import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Materializer } from '../../src/agent/workspace.js';
import { ProjectIndex } from '../../src/index/project-index.js';
import { startMockServer, type MockReply, type MockRequest, type MockServerHandle } from '../../src/mock/server.js';
import { Orchestrator, type RunOptions } from '../../src/orchestrator/orchestrator.js';
import { caps, config, isAgent, lastUser, recordingBus, routerFor, tmpProject, toolResults } from '../helpers.js';

const servers: MockServerHandle[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

interface Brain {
  plan: { understanding?: string; acceptance_criteria?: string[]; subtasks: Array<Record<string, unknown>> };
  /** scripted agent: subtask id (e.g. "T1", "F1.1", "V1"), step, request */
  agent: (subtask: string, step: number, q: MockRequest, model: string) => MockReply | undefined;
  /** acceptance judge verdicts in call order (last one repeats) */
  judge?: Array<{ complete: boolean; missing?: string[] }>;
  review?: (prompt: string) => MockReply;
  record?: (kind: string, prompt: string, model: string) => void;
}

const call = (name: string, args: Record<string, unknown>): MockReply => ({ toolCall: { name, args } });

function brainHandler(b: Brain, model: string) {
  let judgeCalls = 0;
  return (q: MockRequest): MockReply | undefined => {
    const u = lastUser(q.messages);
    if (isAgent(q.messages)) {
      const first = q.messages.find((m) => m.role === 'user')?.content ?? '';
      const id = first.match(/Your subtask \(([^ ]+) –/)?.[1] ?? '?';
      b.record?.('agent', `${q.messages[0].content}\n${first}`, model);
      return b.agent(id, toolResults(q.messages), q, model) ?? call('finish', { summary: `${id} done by ${model}` });
    }
    if (/You are the planner of a team/.test(u)) {
      b.record?.('plan', u, model);
      return { content: JSON.stringify(b.plan) };
    }
    if (/strict senior code reviewer/.test(u)) {
      b.record?.('review', u, model);
      return b.review?.(u) ?? { content: '{"ranking":["A","B","C"],"scores":{},"issues":{}}' };
    }
    if (/final acceptance judge/.test(u)) {
      b.record?.('judge', u, model);
      const list = b.judge ?? [{ complete: true }];
      return { content: JSON.stringify(list[Math.min(judgeCalls++, list.length - 1)]) };
    }
    return undefined;
  };
}

async function setup(brain: Brain, files: Record<string, string>, opts: { models?: string[]; cfg?: Record<string, unknown> } = {}) {
  const ids = opts.models ?? ['m1', 'm2'];
  const s = await startMockServer(ids.map((id) => ({ id, quality: 'good' as const, tools: true, ctx: 65536, handler: brainHandler(brain, id) })));
  servers.push(s);
  const root = tmpProject(files, { git: true });
  const cfg = config({ endpoints: [{ name: 'e', baseUrl: s.url }], ...(opts.cfg ?? {}) });
  const bus = recordingBus();
  const router = routerFor(cfg, ids.map((id) => caps(id, 'e', { maxConcurrency: 4 })), bus);
  const index = new ProjectIndex(root, join(root, cfg.stateDir));
  index.build();
  const run = (task: string, o: RunOptions = {}) => new Orchestrator(root, cfg, router, new Materializer(root, join(root, cfg.stateDir)), index, bus).run(task, o);
  return { s, root, bus, run, cfg };
}

const read = (root: string, p: string) => readFileSync(join(root, p), 'utf8');

describe('Orchestrator', () => {
  it('split mode: runs dependent subtasks in order and later ones see earlier changes', async () => {
    let t2SawA = false;
    const brain: Brain = {
      plan: {
        understanding: 'two modules',
        acceptance_criteria: ['B equals 2'],
        subtasks: [
          { id: 'T1', title: 'create a', description: 'create src/a.js', files: ['src/a.js'], depends_on: [] },
          { id: 'T2', title: 'create b', description: 'create src/b.js using a', files: ['src/b.js'], depends_on: ['T1'] },
        ],
      },
      agent: (id, step, q) => {
        if (id === 'T1') return [call('write_file', { path: 'src/a.js', content: 'export const A = 1;\n' })][step];
        if (id === 'T2') {
          if (step === 0) return call('read_file', { path: 'src/a.js' });
          if (step === 1) {
            t2SawA = q.messages.some((m) => m.role === 'tool' && /export const A = 1/.test(m.content ?? ''));
            return call('write_file', { path: 'src/b.js', content: "import { A } from './a.js';\nexport const B = A + 1;\n" });
          }
        }
        return undefined;
      },
    };
    const { run, root, bus } = await setup(brain, { 'package.json': '{"type":"module"}', 'README.md': '# x' }, { cfg: { verify: { test: 'node -e "import(\'./src/b.js\').then(m=>process.exit(m.B===2?0:1))"' } } });
    const report = await run('Create modules a and b', { mode: 'split' });
    assert.equal(report.status, 'completed', JSON.stringify(report.requirementCheck));
    assert.equal(report.mode, 'split');
    assert.ok(t2SawA, 'T2 worker read T1 output through the integration overlay');
    assert.equal(read(root, 'src/b.js'), "import { A } from './a.js';\nexport const B = A + 1;\n");
    assert.deepEqual(report.changedFiles, ['src/a.js', 'src/b.js']);
    const order = bus.history.filter((e) => e.type === 'subtask.start' || e.type === 'subtask.winner').map((e) => `${e.type}:${e.source}`);
    assert.deepEqual(order, ['subtask.start:T1', 'subtask.winner:T1', 'subtask.start:T2', 'subtask.winner:T2']);
    assert.equal(report.finalVerify!.ok, true);
    assert.ok(existsSync(join(report.sessionDir, 'events.jsonl')));
    const session = JSON.parse(read(report.sessionDir, 'session.json'));
    assert.equal(session.plan.subtasks.length, 2);
    assert.ok(!existsSync(join(root, '.kurultay', 'journal.json')));
  });

  it('runs follow-up iterations for requirements the judges find missing', async () => {
    const brain: Brain = {
      plan: { subtasks: [{ id: 'T1', title: 'main', description: 'write src/a.js' }] },
      agent: (id, step) => {
        if (id === 'T1' && step === 0) return call('write_file', { path: 'src/a.js', content: 'a' });
        if (id.startsWith('F') && step === 0) return call('write_file', { path: 'src/extra.js', content: 'extra' });
        return undefined;
      },
      judge: [{ complete: false, missing: ['also create src/extra.js'] }, { complete: true }], // one model → one judge per iteration
    };
    const { run, root } = await setup(brain, { 'README.md': '#' }, { models: ['solo'] });
    const report = await run('Do the thing', { mode: 'single' });
    assert.equal(report.status, 'completed');
    assert.equal(report.iterations, 2);
    assert.ok(report.subtasks.some((s) => s.subtask.id === 'F1.1' && s.iteration === 2));
    assert.equal(read(root, 'src/extra.js'), 'extra');
  });

  it('adds a fix-the-build subtask when the combined change fails verification', async () => {
    let verifyFixSeen = false;
    const brain: Brain = {
      plan: { subtasks: [{ id: 'T1', title: 'one', description: 'write flag' }, { id: 'T2', title: 'two', description: 'write other' }] },
      agent: (id, step, q) => {
        if (step !== 0) return undefined;
        if (id === 'T1') return call('write_file', { path: 'flag.txt', content: 'bad' });
        if (id === 'T2') return call('write_file', { path: 'other.txt', content: 'x' });
        if (id === 'V1') {
          verifyFixSeen = /fail verification/.test(q.messages.find((m) => m.role === 'user')?.content ?? '');
          return call('edit_file', { path: 'flag.txt', old_text: 'bad', new_text: 'good' });
        }
        return undefined;
      },
    };
    // each subtask alone passes (flag.txt absent or anything) – only the combination is checked strictly
    const verify = `node -e "const fs=require('fs');process.exit(fs.existsSync('other.txt')&&fs.readFileSync('flag.txt','utf8')!=='good'?1:0)"`;
    const { run, root } = await setup(brain, { 'README.md': '#' }, { models: ['solo'], cfg: { verify: { test: verify } } });
    const report = await run('Two things', { mode: 'split' });
    assert.ok(verifyFixSeen, 'V1 follow-up received the verification failure');
    assert.equal(report.status, 'completed');
    assert.equal(read(root, 'flag.txt'), 'good');
  });

  it('stops after maxIterations with status incomplete', async () => {
    const brain: Brain = {
      plan: { subtasks: [{ id: 'T1', title: 'x', description: 'x' }] },
      agent: (id, step) => (step === 0 ? call('write_file', { path: `out-${id}.txt`, content: id }) : undefined),
      judge: [{ complete: false, missing: ['never satisfied'] }],
    };
    const { run } = await setup(brain, { 'README.md': '#' }, { models: ['solo'], cfg: { orchestrator: { maxIterations: 2 } } });
    const report = await run('impossible', { mode: 'single' });
    assert.equal(report.status, 'incomplete');
    assert.equal(report.iterations, 2);
    assert.deepEqual(report.requirementCheck!.missing, ['never satisfied']);
  });

  it('reports failure when no worker produces any change', async () => {
    const brain: Brain = { plan: { subtasks: [{ id: 'T1', title: 'x', description: 'x' }] }, agent: () => ({ content: 'I refuse.' }) };
    const { run, root } = await setup(brain, { 'a.txt': 'a' }, { cfg: { orchestrator: { maxIterations: 1 } } });
    const report = await run('nothing happens', { mode: 'race' });
    assert.equal(report.status, 'failed');
    assert.deepEqual(report.changedFiles, []);
    assert.equal(report.merge, undefined);
    assert.equal(read(root, 'a.txt'), 'a');
    assert.match(read(report.sessionDir, 'REPORT.md'), /\*\*Durum:\*\* failed/);
  });

  it('flags conflicts when parallel subtasks edit the same lines', async () => {
    const brain: Brain = {
      plan: { subtasks: [{ id: 'T1', title: 'x', description: 'x' }, { id: 'T2', title: 'y', description: 'y' }] },
      agent: (id, step) => (step === 0 ? call('edit_file', { path: 'shared.txt', old_text: 'value = 0', new_text: `value = ${id}` }) : undefined),
    };
    const { run, root, bus } = await setup(brain, { 'shared.txt': 'header\nvalue = 0\nfooter\n' });
    const report = await run('both edit', { mode: 'split' });
    assert.ok(bus.ofType('log.warn').some((e) => /çakışma/.test(e.message ?? '')));
    const merged = read(root, 'shared.txt');
    assert.match(merged, /<<<<<<< kurultay[\s\S]*=======[\s\S]*>>>>>>> mevcut/);
    assert.ok(report.changedFiles.includes('shared.txt'));
  });

  it('fixes are re-reviewed by a model that did not write the code', async () => {
    const reviews: Array<{ model: string; corrected: boolean }> = [];
    const writers = new Set<string>();
    const brain: Brain = {
      plan: { subtasks: [{ id: 'T1', title: 'x', description: 'write a.txt' }] },
      agent: (_id, step, q, model) => {
        if (step !== 0) return undefined;
        writers.add(model);
        const first = q.messages.find((m) => m.role === 'user')?.content ?? '';
        if (/Blocking review findings/.test(first)) {
          const round = (first.match(/still-broken/) ? 2 : 1);
          return call('edit_file', { path: 'a.txt', old_text: round === 1 ? 'bug' : 'half', new_text: round === 1 ? 'half' : 'fixed' });
        }
        return call('write_file', { path: 'a.txt', content: 'bug' });
      },
      review: (prompt) => {
        const corrected = /corrected version/.test(prompt);
        const body = prompt.match(/```diff\n([\s\S]*?)```/)?.[1] ?? '';
        const broken = /\+bug/.test(body) ? 'null deref' : /\+half/.test(body) ? 'still-broken edge case' : '';
        return { content: JSON.stringify({ ranking: ['A'], scores: { A: 5 }, issues: broken ? { A: [{ text: broken, priority: 0, confidence: 0.9 }] } : {} }) };
      },
      record: (kind, prompt, model) => {
        if (kind === 'review') reviews.push({ model, corrected: /corrected version/.test(prompt) });
      },
    };
    const { run, root } = await setup(brain, { 'README.md': '#' }, { models: ['m1', 'm2', 'm3'] });
    const report = await run('write a.txt', { mode: 'single' });
    assert.equal(read(root, 'a.txt'), 'fixed');
    const st = report.subtasks[0];
    assert.equal(st.fixes, 2);
    assert.equal(st.verdict!.independent, true);
    assert.deepEqual(st.fixReviews!.map((f) => f.blocking), [1, 0], 'first fix still had a P0, second fix was clean');
    assert.ok(st.fixReviews!.every((f) => f.independent));
    assert.equal(reviews.filter((r) => r.corrected).length, 2);
    assert.ok(reviews.every((r) => !writers.has(`${r.model}@e`) && !writers.has(r.model)), `reviewers ${reviews.map((r) => r.model)} vs writers ${[...writers]}`);
    const md = read(report.reportPath, '');
    assert.match(md, /İnceleyen modeller: .* — bağımsız/);
    assert.match(md, /1\. düzeltme yeniden incelendi \(.*\): 1 engelleyici bulgu kaldı/);
    assert.match(md, /2\. düzeltme yeniden incelendi \(.*\): engelleyici bulgu yok/);
  });

  it('asks for confirmation and keeps the project untouched when declined', async () => {
    let asked = '';
    const brain: Brain = { plan: { subtasks: [{ id: 'T1', title: 'x', description: 'x' }] }, agent: (_id, step) => (step === 0 ? call('edit_file', { path: 'a.txt', old_text: 'orig', new_text: 'changed' }) : undefined) };
    const { run, root } = await setup(brain, { 'a.txt': 'orig' }, { models: ['solo'], cfg: { orchestrator: { confirmMerge: true } } });
    const report = await run('change a', {
      mode: 'single',
      confirm: async (q) => {
        asked = q;
        return false;
      },
    });
    assert.match(asked, /1 dosya, \+1\/-1 satır/);
    assert.equal(report.status, 'dry-run');
    assert.equal(read(root, 'a.txt'), 'orig');
    assert.match(read(report.diffPath, ''), /\+changed/);
  });

  it('injects requirements, project rules and review rules into the right prompts', async () => {
    const seen: Record<string, string[]> = { plan: [], agent: [], review: [] };
    const brain: Brain = {
      plan: { subtasks: [{ id: 'T1', title: 'java work', description: 'edit Foo.java', files: ['src/Foo.java'] }] },
      agent: (_id, step, _q, model) => (step === 0 ? call('edit_file', { path: 'src/Foo.java', old_text: 'class Foo {}', new_text: `class Foo { /* ${model} */ }` }) : undefined),
      record: (kind, prompt) => seen[kind]?.push(prompt),
    };
    const { run } = await setup(brain, {
      'src/Foo.java': 'class Foo {}',
      'AGENTS.md': 'RULE-GLOBAL-123: always add tests',
      '.kurultay/rules/java.md': '---\napplies_to: "*.java"\n---\nRULE-JAVA-456',
      '.kurultay/rules/c.md': '---\napplies_to: "*.c"\n---\nRULE-C-789',
      '.kurultay/skills/refactor.md': '---\nname: java-refactor\ndescription: refactor java classes safely\n---\nSKILL-STEPS-321',
      '.agents/skills/foo-kurallari/SKILL.md': '---\nname: foo-kurallari\ndescription: Foo sınıfı kuralları\nkeywords: [foo]\n---\nSKILL-KEYWORD-654',
      '.agents/skills/gizli/SKILL.md': '---\nname: gizli\ndescription: yalnızca açıkça istenince\ndisable-model-invocation: true\n---\nSKILL-HIDDEN-000',
      'review_rules.md': 'REVIEW-RULE-999',
    });
    const report = await run('refactor the java class Foo', { mode: 'race', requirements: 'REQ-DOC-555' });
    assert.equal(report.skills.available, 3);
    assert.ok(report.skills.used.some((u) => u.name === 'foo-kurallari' && u.how === 'preload'));
    assert.match(readFileSync(report.reportPath, 'utf8'), /## Skill'ler[\s\S]*foo-kurallari/);
    assert.ok(seen.plan.some((p) => p.includes('REQ-DOC-555')), 'requirements reach the planner');
    const agentPrompt = seen.agent.join('\n');
    assert.ok(agentPrompt.includes('RULE-GLOBAL-123'));
    assert.ok(agentPrompt.includes('RULE-JAVA-456'));
    assert.ok(!agentPrompt.includes('RULE-C-789'), 'glob-scoped rule for *.c is not injected');
    // progressive disclosure: a merely relevant skill is advertised (name + description), its body is not preloaded
    assert.ok(agentPrompt.includes('<name>java-refactor</name><description>refactor java classes safely</description>'), 'relevant skill advertised');
    assert.ok(!agentPrompt.includes('SKILL-STEPS-321'), 'relevant skill body is loaded on demand only');
    assert.ok(agentPrompt.includes('SKILL-KEYWORD-654'), 'keyword-triggered skill preloaded');
    assert.ok(!agentPrompt.includes('SKILL-HIDDEN-000') && !agentPrompt.includes('<name>gizli</name>'), 'hidden skill neither advertised nor loaded');
    assert.ok(seen.review.some((p) => p.includes('REVIEW-RULE-999')), 'review rules reach the council');
  });

  it('recovers files left behind by a crashed run before starting', async () => {
    const brain: Brain = { plan: { subtasks: [{ id: 'T1', title: 'x', description: 'x' }] }, agent: () => ({ content: 'nothing' }) };
    const { run, root, bus } = await setup(brain, { 'a.txt': 'CANDIDATE-LEFTOVER' }, { models: ['solo'], cfg: { orchestrator: { maxIterations: 1 } } });
    mkdirSync(join(root, '.kurultay'), { recursive: true });
    writeFileSync(join(root, '.kurultay', 'journal.json'), JSON.stringify({ overlay: 'old', originals: { 'a.txt': 'ORIGINAL' } }));
    await run('noop', { mode: 'single' });
    assert.equal(read(root, 'a.txt'), 'ORIGINAL');
    assert.ok(bus.ofType('log.warn').some((e) => /geri yüklendi/.test(e.message ?? '')));
  });

  it('can be aborted mid-run without touching the project', async () => {
    const ctrl = new AbortController();
    const brain: Brain = {
      plan: { subtasks: [{ id: 'T1', title: 'x', description: 'x' }] },
      agent: (_id, step) => {
        if (step === 0) return call('edit_file', { path: 'a.txt', old_text: 'orig', new_text: 'half-done' });
        setTimeout(() => ctrl.abort(new Error('user cancelled')), 5);
        return { hangMs: 2000 };
      },
    };
    const { run, root } = await setup(brain, { 'a.txt': 'orig' }, { models: ['solo'] });
    const t0 = Date.now();
    const report = await run('slow task', { mode: 'single', signal: ctrl.signal }).catch((e: Error) => e);
    assert.ok(Date.now() - t0 < 2500, 'abort is prompt');
    if (!(report instanceof Error)) assert.notEqual(report.status, 'completed');
    assert.equal(read(root, 'a.txt'), 'orig');
    assert.ok(!existsSync(join(root, '.kurultay', 'journal.json')));
  });
});
