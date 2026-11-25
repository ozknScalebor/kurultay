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
  /** answers of the localisation step */
  locate?: { files: string[]; locations: Array<{ file: string; symbol: string }> };
  /** the localisation answers this late */
  locateDelayMs?: number;
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
    if (b.locate && /Which files must be EDITED/.test(u)) return { content: JSON.stringify({ files: b.locate.files }), delayMs: b.locateDelayMs };
    if (b.locate && /Skeleton of the files to edit/.test(u)) return { content: JSON.stringify({ locations: b.locate.locations }) };
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

async function setup(brain: Brain, files: Record<string, string>, opts: { models?: string[]; cfg?: Record<string, unknown>; caps?: Record<string, Record<string, unknown>> } = {}) {
  const ids = opts.models ?? ['m1', 'm2'];
  const s = await startMockServer(ids.map((id) => ({ id, quality: 'good' as const, tools: true, ctx: 65536, handler: brainHandler(brain, id) })));
  servers.push(s);
  const root = tmpProject(files, { git: true });
  const cfg = config({ endpoints: [{ name: 'e', baseUrl: s.url }], ...(opts.cfg ?? {}) });
  const bus = recordingBus();
  const router = routerFor(cfg, ids.map((id) => caps(id, 'e', { maxConcurrency: 4, ...(opts.caps?.[id] ?? {}) })), bus);
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
    assert.match(read(report.sessionDir, 'REPORT.md'), /\*\*Status:\*\* failed/);
  });

  it('flags conflicts when parallel subtasks edit the same lines', async () => {
    const brain: Brain = {
      plan: { subtasks: [{ id: 'T1', title: 'x', description: 'x' }, { id: 'T2', title: 'y', description: 'y' }] },
      agent: (id, step) => (step === 0 ? call('edit_file', { path: 'shared.txt', old_text: 'value = 0', new_text: `value = ${id}` }) : undefined),
    };
    const { run, root, bus } = await setup(brain, { 'shared.txt': 'header\nvalue = 0\nfooter\n' });
    const report = await run('both edit', { mode: 'split' });
    assert.ok(bus.ofType('log.warn').some((e) => /conflict/.test(e.message ?? '')));
    const merged = read(root, 'shared.txt');
    assert.match(merged, /<<<<<<< kurultay[\s\S]*=======[\s\S]*>>>>>>> current/);
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
    assert.match(md, /Reviewers: .* – independent/);
    assert.match(md, /fix 1 re-reviewed \(.*\): 1 blocking findings left/);
    assert.match(md, /fix 2 re-reviewed \(.*\): no blocking findings/);
  });

  it('race with one model samples it again and the rivals\' tests pick the right candidate', async () => {
    const runner = "import { readdirSync } from 'node:fs';\nimport { pathToFileURL } from 'node:url';\nfor (const f of readdirSync('tests').filter((f) => f.endsWith('.test.mjs'))) await import(pathToFileURL('tests/' + f).href);\n";
    const check = (call: string, want: number) => `import { twice } from '../src/m.mjs';\nif (${call} !== ${want}) throw new Error('wrong');\n`;
    const temps: number[] = [];
    const brain: Brain = {
      plan: { subtasks: [{ id: 'T1', title: 'fix twice', description: 'twice(x) must return 2*x' }] },
      agent: (_id, step, q) => {
        const t = Number(q.body.temperature);
        if (step === 0) temps.push(t);
        // the first sample over-fits to one input, the freer samples fix it properly
        const right = t > 0.5;
        if (step === 0) return call('read_file', { path: 'src/m.mjs' });
        if (step === 1) return call('write_file', { path: 'src/m.mjs', content: right ? 'export const twice = (x) => x * 2;\n' : 'export const twice = (x) => (x === 3 ? 6 : 0);\n' });
        if (step === 2) return call('write_file', { path: right ? 'tests/right.test.mjs' : 'tests/overfit.test.mjs', content: right ? check('twice(2)', 4) : check('twice(3)', 6) });
        return undefined;
      },
    };
    const { run, root } = await setup(brain, { 'src/m.mjs': 'export const twice = (x) => x + x + 1;\n', 'run.mjs': runner, 'tests/base.test.mjs': check('1', 1) }, { models: ['m1'], cfg: { verify: { test: 'node run.mjs' } } });
    const report = await run('fix twice', { mode: 'race' });
    assert.deepEqual(temps.sort(), [0.2, 0.7, 0.7], 'three samples of the one model, the repeats sample more freely');
    const st = report.subtasks[0];
    assert.equal(st.candidates.length, 3);
    assert.deepEqual(st.candidates.map((c) => c.crossTests).sort(), ['0/2', '2/2', '2/2']);
    assert.equal(read(root, 'src/m.mjs'), 'export const twice = (x) => x * 2;\n');
    assert.match(read(report.reportPath, ''), /rival tests: 2\/2/);
  });

  it('localises the edit before the workers start and shows them that code', async () => {
    const prompts: string[] = [];
    const brain: Brain = {
      plan: { subtasks: [{ id: 'T1', title: 'fix uart_send', description: 'uart_send writes one byte too many' }] },
      locate: { files: ['src/uart.c'], locations: [{ file: 'src/uart.c', symbol: 'uart_send' }] },
      agent: () => undefined,
      record: (kind, prompt) => kind === 'agent' && prompts.push(prompt),
    };
    const files: Record<string, string> = { 'src/uart.c': 'int uart_init(void) {\n  return 0;\n}\n\nint uart_send(int n) {\n  return n + 1;\n}\n' };
    for (let i = 0; i < 8; i++) files[`src/f${i}.c`] = `int f${i}(void) { return ${i}; }\n`;
    const { run } = await setup(brain, files, { models: ['m1'] });
    const report = await run('fix uart_send', { mode: 'single' });
    assert.deepEqual(report.subtasks[0].localized, ['src/uart.c:uart_send']);
    assert.ok(prompts.some((p) => /LIKELY EDIT LOCATIONS[\s\S]*5│ int uart_send\(int n\)/.test(p)));
    assert.match(read(report.reportPath, ''), /Localised: `src\/uart\.c:uart_send`/);
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
    assert.match(asked, /1 file, \+1\/-1 lines/);
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
    assert.match(readFileSync(report.reportPath, 'utf8'), /## Skills[\s\S]*foo-kurallari/);
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
    assert.ok(bus.ofType('log.warn').some((e) => /restored/.test(e.message ?? '')));
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

  it('fast path: a small task skips the plan council and reuses the localisation', async () => {
    let plans = 0;
    const prompts: string[] = [];
    const brain: Brain = {
      plan: { subtasks: [{ id: 'T1', title: 'x', description: 'x' }] },
      locate: { files: ['src/uart.c'], locations: [{ file: 'src/uart.c', symbol: 'uart_send' }] },
      agent: (_id, step) => (step === 0 ? call('edit_file', { path: 'src/uart.c', old_text: 'return n + 1;', new_text: 'return n;' }) : undefined),
      record: (kind, prompt) => {
        if (kind === 'plan') plans++;
        if (kind === 'agent') prompts.push(prompt);
      },
    };
    const files: Record<string, string> = { 'src/uart.c': 'int uart_send(int n) {\n  return n + 1;\n}\n' };
    for (let i = 0; i < 8; i++) files[`src/f${i}.c`] = `int f${i}(void) { return ${i}; }\n`;
    const { run, s, bus, root } = await setup(brain, files, { cfg: { orchestrator: { parallelLocalize: false } } });
    const report = await run('uart_send writes one byte too many');
    assert.equal(plans, 0, 'no plan drafts');
    assert.equal(report.mode, 'single', 'no build/test commands: one coder and a reviewer, no race');
    assert.equal(report.subtasks.length, 1);
    assert.equal(report.subtasks[0].candidates.length, 1);
    assert.deepEqual(report.subtasks[0].localized, ['src/uart.c:uart_send']);
    assert.equal(s.log.filter((l) => JSON.stringify(l.body).includes('Which files must be EDITED')).length, 1, 'localised once');
    assert.ok(prompts.some((p) => /Files likely involved: src\/uart\.c/.test(p)));
    assert.ok(bus.ofType('log.info').some((e) => /small task/.test(e.message ?? '')));
    assert.match(read(root, 'src/uart.c'), /return n;/);
    assert.match(read(report.reportPath, ''), /## Prompt makeup \(\d+ coding requests?\)[\s\S]*\| Tool declarations \| \d+ \|/);
    // localisation names at most four files: a short task stays one agent loop, with several models too
    brain.locate = { files: ['src/f1.c', 'src/f2.c', 'src/f3.c', 'src/f4.c'], locations: [] };
    await run('change f1 to f4');
    assert.equal(plans, 0);
    // a long task, a forced mode or plan approval go through the planners
    await run(`change f1 to f4\n${'more detail. '.repeat(130)}`);
    assert.ok(plans > 0);
    const after = plans;
    await run('x', { mode: 'race' });
    assert.ok(plans > after);
  });

  it('one coding model: a medium task stays one agent loop, is localised once, and needs no separate acceptance judge', async () => {
    let plans = 0;
    let judges = 0;
    const brain: Brain = {
      plan: { subtasks: [{ id: 'T1', title: 'x', description: 'x' }, { id: 'T2', title: 'y', description: 'y' }] },
      locate: { files: ['src/f1.c', 'src/f2.c', 'src/f3.c', 'src/f4.c'], locations: [] },
      agent: (_id, step) => (step === 0 ? call('edit_file', { path: 'src/f1.c', old_text: 'return 1;', new_text: 'return 10;' }) : undefined),
      record: (kind) => {
        if (kind === 'plan') plans++;
        if (kind === 'judge') judges++;
      },
    };
    const files: Record<string, string> = {};
    for (let i = 0; i < 9; i++) files[`src/f${i}.c`] = `int f${i}(void) { return ${i}; }\n`;
    const { run, s } = await setup(brain, files, { models: ['solo'], cfg: { verify: { build: 'true', test: 'true' } } });
    const report = await run('change f1 to f4');
    assert.equal(plans, 0, 'no plan council for one model and four files');
    assert.equal(report.subtasks.length, 1);
    assert.equal(s.log.filter((l) => JSON.stringify(l.body).includes('Which files must be EDITED')).length, 1, 'localised once');
    assert.equal(judges, 0, 'verified work of the only model is not judged again');
    assert.equal(report.status, 'completed');
  });

  it('a one-subtask plan reuses the localisation made while triaging the task', async () => {
    const brain: Brain = {
      plan: { subtasks: [{ id: 'T1', title: 'x', description: 'x' }] },
      locate: { files: ['src/f0.c', 'src/f1.c', 'src/f2.c', 'src/f3.c', 'src/f4.c', 'src/f5.c', 'src/f6.c'], locations: [] },
      agent: (_id, step) => (step === 0 ? call('edit_file', { path: 'src/f1.c', old_text: 'return 1;', new_text: 'return 10;' }) : undefined),
    };
    const files: Record<string, string> = {};
    for (let i = 0; i < 9; i++) files[`src/f${i}.c`] = `int f${i}(void) { return ${i}; }\n`;
    const { run, s } = await setup(brain, files);
    await run('change f0 to f6');
    assert.equal(s.log.filter((l) => JSON.stringify(l.body).includes('Which files must be EDITED')).length, 1);
  });

  it('speed band: a much slower model stays out of the race and the review until the fast model fails the tests', async () => {
    const workers: string[] = [];
    const brain: Brain = {
      plan: { subtasks: [{ id: 'T1', title: 'x', description: 'x' }] },
      locate: { files: ['src/f1.c'], locations: [] },
      agent: (_id, step, _q, model) => {
        if (step === 0) workers.push(model);
        return step === 0 ? call('edit_file', { path: 'src/f1.c', old_text: 'return 1;', new_text: 'return 10;' }) : undefined;
      },
    };
    const files: Record<string, string> = {};
    for (let i = 0; i < 9; i++) files[`src/f${i}.c`] = `int f${i}(void) { return ${i}; }\n`;
    const speeds = { fast: { tokensPerSec: 190, ttftMs: 1000 }, slow: { tokensPerSec: 19, ttftMs: 7000 } };
    const ok = await setup(brain, files, { models: ['fast', 'slow'], caps: speeds, cfg: { verify: { build: 'true', test: 'true' }, orchestrator: { raceWidth: 3, maxIterations: 1 } } });
    const report = await ok.run('change f1');
    assert.equal(report.mode, 'race');
    assert.ok(workers.length >= 1 && workers.every((m) => m === 'fast'), `only the fast model works (${workers.join(', ')})`);
    assert.ok(ok.bus.ofType('log.info').some((e) => /much slower than fast@e: slow@e/.test(e.message ?? '')));
    assert.ok(!ok.s.log.some((l) => (l.body as { model?: string }).model === 'slow'), 'the slow model got no request at all');
    // the fast model's change fails the tests: the slower model joins the next iteration
    workers.length = 0;
    const bad = await setup(brain, files, { models: ['fast', 'slow'], caps: speeds, cfg: { verify: { build: 'true', test: 'false' }, orchestrator: { raceWidth: 2, maxIterations: 2 } } });
    await bad.run('change f1');
    assert.ok(bad.bus.ofType('log.info').some((e) => /(first candidate|build or tests) failed: the slower models join from now on \(slow@e\)/.test(e.message ?? '')));
    assert.ok((workers as string[]).includes('slow'));
  });

  it('cascade: with build/tests the main model tries alone first and the race starts only when it fails', async () => {
    const workers: string[] = [];
    let judges = 0;
    const brain: Brain = {
      plan: { subtasks: [{ id: 'T1', title: 'x', description: 'x' }] },
      locate: { files: ['src/f1.c'], locations: [] },
      agent: (_id, step, _q, model) => {
        if (step === 0) workers.push(model);
        return step === 0 ? call('edit_file', { path: 'src/f1.c', old_text: 'return 1;', new_text: 'return 10;' }) : undefined;
      },
      record: (kind) => {
        if (kind === 'judge') judges++;
      },
    };
    const files: Record<string, string> = {};
    for (let i = 0; i < 9; i++) files[`src/f${i}.c`] = `int f${i}(void) { return ${i}; }\n`;
    const good = await setup(brain, files, { models: ['m1', 'm2'], cfg: { verify: { build: 'true', test: 'true' }, orchestrator: { raceWidth: 3 } } });
    const r1 = await good.run('change f1');
    assert.equal(workers.length, 1, 'one agent when it passes');
    assert.equal(r1.subtasks[0].cascade, 'first');
    assert.equal(judges, 0);
    assert.ok(!r1.subtasks[0].verdict, 'no review either');
    workers.length = 0;
    const bad = await setup(brain, files, { models: ['m1', 'm2'], cfg: { verify: { build: 'true', test: 'false' }, orchestrator: { raceWidth: 3, maxIterations: 1 } } });
    const r2 = await bad.run('change f1');
    assert.equal(r2.subtasks[0].cascade, 'raced');
    assert.ok(workers.length >= 3, 'the first one, then two more (and a fix round)');
    const r3 = await good.run('change f1', { mode: 'race' });
    assert.equal(r3.subtasks[0].cascade, undefined, 'a race asked for is a race');
    assert.ok(r3.subtasks[0].candidates.length >= 2);
  });

  it('parallel localisation: the coder starts at once and gets the located code as a hint', async () => {
    const seen: string[] = [];
    const brain: Brain = {
      plan: { subtasks: [{ id: 'T1', title: 'x', description: 'x' }] },
      locate: { files: ['src/uart.c'], locations: [{ file: 'src/uart.c', symbol: 'uart_send' }] },
      locateDelayMs: 150,
      agent: (_id, step, q) => {
        seen.push(q.messages.map((m) => m.content ?? '').join('\n'));
        return step === 0 ? { toolCall: { name: 'read_file', args: { path: 'src/f1.c' } }, content: '', delayMs: 300 } as MockReply : step === 1 ? call('edit_file', { path: 'src/uart.c', old_text: 'return n + 1;', new_text: 'return n;' }) : undefined;
      },
    };
    const files: Record<string, string> = { 'src/uart.c': 'int uart_send(int n) {\n  return n + 1;\n}\n' };
    for (let i = 0; i < 8; i++) files[`src/f${i}.c`] = `int f${i}(void) { return ${i}; }\n`;
    const { run, root } = await setup(brain, files);
    const report = await run('uart_send writes one byte too many');
    assert.equal(report.status, 'completed');
    assert.ok(!/A parallel localisation finished/.test(seen[0] ?? ''), 'first step without the hint');
    assert.ok(seen.slice(1).some((t) => /A parallel localisation finished[\s\S]*uart_send/.test(t)), 'a later step has it');
    assert.match(read(root, 'src/uart.c'), /return n;/);
  });

  it('a task with many requirements: the coder gets them as a todo list and the acceptance judge runs although the tests passed', async () => {
    let judges = 0;
    let firstPrompt = '';
    const brain: Brain = {
      plan: { subtasks: [{ id: 'T1', title: 'x', description: 'x' }] },
      locate: { files: ['src/f1.c'], locations: [] },
      agent: (_id, step, q) => {
        if (step === 0) firstPrompt = q.messages.map((m) => m.content ?? '').join('\n');
        if (step === 0) return call('edit_file', { path: 'src/f1.c', old_text: 'return 1;', new_text: 'return 10;' });
        if (step === 1) return call('todo_write', { todos: [1, 2, 3, 4, 5].map((i) => ({ id: String(i), content: `r${i}`, status: 'completed' })) });
        return undefined;
      },
      record: (kind) => {
        if (kind === 'judge') judges++;
      },
    };
    const files: Record<string, string> = {};
    for (let i = 0; i < 9; i++) files[`src/f${i}.c`] = `int f${i}(void) { return ${i}; }\n`;
    const { run } = await setup(brain, files, { models: ['solo'], cfg: { verify: { build: 'true', test: 'true' } } });
    const task = 'Add the f1 rules. f1 must return ten for every input. Negative inputs must raise an error code. The value must be logged on every call. Existing tests keep passing with the new behaviour.';
    const report = await run(task);
    assert.equal(report.status, 'completed');
    assert.match(firstPrompt, /your todo list[\s\S]*\[ \] 1\. Add the f1 rules\./);
    assert.equal(judges, 1, 'judged although one model passed the tests');
    assert.ok(report.plan.acceptance.length >= 4);
  });

  it('the acceptance judge runs while the coder finishes; its gaps are fixed in the same conversation', async () => {
    let judges = 0;
    let gapSeen = false;
    const brain: Brain = {
      plan: { subtasks: [{ id: 'T1', title: 'x', description: 'x' }] },
      locate: { files: ['src/f1.c'], locations: [] },
      judge: [{ complete: false, missing: ['negative inputs must return -1'] }, { complete: true }],
      agent: (_id, step, q) => {
        if (step === 0) return call('edit_file', { path: 'src/f1.c', old_text: 'return 1;', new_text: 'return 10;' });
        if (step === 1) return call('todo_write', { todos: [1, 2, 3, 4, 5].map((i) => ({ id: String(i), content: `r${i}`, status: 'completed' })) });
        if (step === 2) return undefined; // finish → waits for the judge
        if (step === 3) {
          gapSeen = /acceptance check[\s\S]*negative inputs must return -1/.test(q.messages.map((m) => m.content ?? '').join('\n'));
          return call('edit_file', { path: 'src/f1.c', old_text: 'return 10;', new_text: 'return x < 0 ? -1 : 10;' });
        }
        return undefined;
      },
      record: (kind) => {
        if (kind === 'judge') judges++;
      },
    };
    const files: Record<string, string> = {};
    for (let i = 0; i < 9; i++) files[`src/f${i}.c`] = `int f${i}(int x) { return ${i}; }\n`;
    const { run, bus, root } = await setup(brain, files, { models: ['solo'], cfg: { verify: { build: 'true', test: 'true' } } });
    const report = await run('Add the f1 rules. f1 must return ten for every input. Negative inputs must raise an error code. The value must be logged on every call. Existing tests keep passing with the new behaviour.');
    assert.equal(report.status, 'completed');
    assert.ok(gapSeen, 'the gap went into the coder\'s conversation');
    assert.match(read(root, 'src/f1.c'), /x < 0 \? -1 : 10/);
    assert.equal(report.iterations, 1, 'no extra round');
    assert.equal(judges, 2, 'judged alongside, then once more on the changed diff');
    assert.ok(bus.ofType('log.info').some((e) => /starts while the coder finishes/.test(e.message ?? '')));
  });

  it('a verdict from alongside the coder is reused when the change did not move', async () => {
    let judges = 0;
    const brain: Brain = {
      plan: { subtasks: [{ id: 'T1', title: 'x', description: 'x' }] },
      locate: { files: ['src/f1.c'], locations: [] },
      agent: (_id, step) => {
        if (step === 0) return call('edit_file', { path: 'src/f1.c', old_text: 'return 1;', new_text: 'return 10;' });
        if (step === 1) return call('todo_write', { todos: [1, 2, 3, 4, 5].map((i) => ({ id: String(i), content: `r${i}`, status: i === 5 ? 'dropped' : 'completed', note: 'n/a' })) });
        return undefined;
      },
      record: (kind) => {
        if (kind === 'judge') judges++;
      },
    };
    const files: Record<string, string> = {};
    for (let i = 0; i < 9; i++) files[`src/f${i}.c`] = `int f${i}(void) { return ${i}; }\n`;
    const { run, bus } = await setup(brain, files, { models: ['solo'], cfg: { verify: { build: 'true', test: 'true' } } });
    const report = await run('Add the f1 rules. f1 must return ten for every input. Negative inputs must raise an error code. The value must be logged on every call. Existing tests keep passing with the new behaviour.');
    assert.equal(report.status, 'completed');
    assert.equal(judges, 1);
    assert.ok(bus.ofType('log.info').some((e) => /ran while the coder finished/.test(e.message ?? '')));
  });

  it('fix rounds stop when the reviewer keeps finding the same problem', async () => {
    let judgePrompt = '';
    const brain: Brain = {
      plan: { subtasks: [{ id: 'T1', title: 'x', description: 'write a.txt' }] },
      agent: (_id, step, q) => {
        if (step !== 0) return undefined;
        const first = q.messages.find((m) => m.role === 'user')?.content ?? '';
        return /Blocking review findings/.test(first) ? call('edit_file', { path: 'out.txt', old_text: 'v', new_text: 'v2' }) : call('write_file', { path: 'out.txt', content: 'v' });
      },
      review: () => ({ content: JSON.stringify({ ranking: ['A'], scores: { A: 3 }, issues: { A: [{ text: 'the parser still drops quoted commas in field two', priority: 0, confidence: 0.9 }] } }) }),
      record: (kind, prompt) => kind === 'judge' && (judgePrompt = prompt),
    };
    const { run, bus } = await setup(brain, { 'a.txt': 'orig' }, { cfg: { orchestrator: { maxIterations: 1, fastPath: false } } });
    const report = await run('write a.txt', { mode: 'single' });
    assert.equal(report.subtasks[0].fixes, 1, 'one round, not two');
    assert.ok(bus.ofType('log.warn').some((e) => /made no progress/.test(e.message ?? '')));
    assert.deepEqual(report.subtasks[0].openIssues, ['[P0] the parser still drops quoted commas in field two']);
    assert.match(judgePrompt, /OPEN REVIEW FINDINGS[\s\S]*quoted commas/);
  });

  it('race: slower candidates are stopped a while after the first one is done', async () => {
    const brain: Brain = {
      plan: { subtasks: [{ id: 'T1', title: 'x', description: 'write a.txt' }] },
      agent: (_id, step, _q, model) => {
        if (model === 'slow') return step === 0 ? { hangMs: 4000 } : undefined;
        return step === 0 ? call('write_file', { path: 'out.txt', content: 'fast' }) : undefined;
      },
    };
    const { run, bus, root } = await setup(brain, { 'a.txt': 'orig' }, { models: ['fast', 'slow'], cfg: { orchestrator: { raceWidth: 2, repeatModels: false, raceGraceMinSeconds: 0, raceGrace: 0.01, maxIterations: 1 }, llm: { timeoutRetries: 0 } } });
    const t0 = Date.now();
    const report = await run('write a.txt', { mode: 'race' });
    assert.ok(Date.now() - t0 < 3500, `did not wait for the slow model (${Date.now() - t0} ms)`);
    assert.ok(bus.ofType('log.info').some((e) => /stopping the slower ones/.test(e.message ?? '')));
    assert.equal(read(root, 'out.txt'), 'fast');
    assert.ok(!report.subtasks[0].candidates.some((c) => c.status === 'done' && c.models.includes('slow@e')));
  });

  it('auto mode without build/test commands runs one candidate', async () => {
    const brain: Brain = { plan: { subtasks: [{ id: 'T1', title: 'x', description: 'x' }] }, agent: (_id, step) => (step === 0 ? call('write_file', { path: 'out.txt', content: 'y' }) : undefined) };
    const { run } = await setup(brain, { 'a.txt': 'x' }, { cfg: { orchestrator: { fastPath: false, maxIterations: 1 } } });
    const report = await run('x');
    assert.equal(report.mode, 'single');
    assert.equal(report.subtasks[0].candidates.length, 1);
  });
});
