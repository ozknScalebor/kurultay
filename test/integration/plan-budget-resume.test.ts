import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Materializer } from '../../src/agent/workspace.js';
import { ProjectIndex } from '../../src/index/project-index.js';
import { startMockServer, type MockReply, type MockRequest, type MockServerHandle } from '../../src/mock/server.js';
import { Orchestrator, renderPlan, renderUsageTable, type RunOptions } from '../../src/orchestrator/orchestrator.js';
import { caps, config, isAgent, lastUser, recordingBus, routerFor, tmpProject, toolResults } from '../helpers.js';

const servers: MockServerHandle[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

const call = (name: string, args: Record<string, unknown>, completionTokens?: number): MockReply => ({ toolCall: { name, args }, completionTokens });

const PLAN = {
  understanding: 'two modules',
  acceptance_criteria: ['B equals 2'],
  subtasks: [
    { id: 'T1', title: 'create a', description: 'create src/a.js', files: ['src/a.js'], depends_on: [] },
    { id: 'T2', title: 'create b', description: 'create src/b.js using a', files: ['src/b.js'], depends_on: ['T1'] },
  ],
};

interface Script {
  agent?: (id: string, step: number) => MockReply | undefined;
  planPrompts?: string[];
  agentCalls?: string[];
  plan?: () => unknown;
}

async function setup(script: Script, cfgExtra: Record<string, unknown> = {}, modelOpts: { latencyMs?: number } = {}) {
  const handler = (q: MockRequest): MockReply | undefined => {
    const u = lastUser(q.messages);
    if (isAgent(q.messages)) {
      const first = q.messages.find((m) => m.role === 'user')?.content ?? '';
      const id = first.match(/Your subtask \(([^ ]+) –/)?.[1] ?? '?';
      const step = toolResults(q.messages);
      script.agentCalls?.push(`${id}:${step}`);
      return script.agent?.(id, step) ?? call('finish', { summary: `${id} done` });
    }
    if (/You are the planner of a team/.test(u)) {
      script.planPrompts?.push(u);
      return { content: JSON.stringify(script.plan?.() ?? PLAN) };
    }
    if (/final acceptance judge/.test(u)) return { content: '{"complete":true,"missing":[]}' };
    if (/strict senior code reviewer/.test(u)) return { content: '{"ranking":["A"],"scores":{},"issues":{}}' };
    return undefined;
  };
  const s = await startMockServer([{ id: 'm1', quality: 'good', tools: true, ctx: 65536, handler, ...modelOpts }]);
  servers.push(s);
  const root = tmpProject({ 'package.json': '{"type":"module"}', 'README.md': '# x' }, { git: true });
  const cfg = config({ endpoints: [{ name: 'e', baseUrl: s.url }], ...cfgExtra });
  const bus = recordingBus();
  const router = routerFor(cfg, [caps('m1', 'e', { maxConcurrency: 4 })], bus);
  const index = new ProjectIndex(root, join(root, cfg.stateDir));
  index.build();
  const orch = () => new Orchestrator(root, cfg, router, new Materializer(root, join(root, cfg.stateDir)), index, bus);
  const run = (task: string, o: RunOptions = {}) => orch().run(task, o);
  const resume = (id?: string, o: RunOptions = {}) => orch().resume(id, o);
  return { root, bus, run, resume, cfg };
}

const writer = (id: string, step: number, bigT2 = false): MockReply | undefined => {
  if (id === 'T1' && step === 0) return call('write_file', { path: 'src/a.js', content: 'export const A = 1;\n' });
  if (id === 'T2' && step === 0) return call('write_file', { path: 'src/b.js', content: "import { A } from './a.js';\nexport const B = A + 1;\n" }, bigT2 ? 5_000_000 : undefined);
  return undefined;
};

describe('plan approval', () => {
  it('feedback makes the planners revise the plan; approval then runs it', async () => {
    const planPrompts: string[] = [];
    let plans = 0;
    const { run, root } = await setup({ planPrompts, agent: (id, step) => writer(id, step), plan: () => (++plans === 1 ? { ...PLAN, subtasks: [PLAN.subtasks[0]] } : PLAN) });
    const seen: Array<{ subtasks: number; round: number; text: string }> = [];
    const report = await run('Create modules a and b', {
      approvePlan: async (plan, info) => {
        seen.push({ subtasks: plan.subtasks.length, round: info.round, text: renderPlan(plan, info.mode) });
        return info.round === 1 ? 'b modülünü de ekle' : true;
      },
    });
    assert.deepEqual(seen.map((x) => [x.round, x.subtasks]), [[1, 1], [2, 2]]);
    assert.match(seen[1].text, /T2\. create b \(after: T1\)[\s\S]*Acceptance criteria:\n {2}- B equals 2/);
    assert.match(planPrompts[planPrompts.length - 1], /USER FEEDBACK ON THE PREVIOUS PLAN[\s\S]*b modülünü de ekle[\s\S]*PREVIOUS PLAN[\s\S]*T1 create a/);
    assert.equal(report.status, 'completed');
    assert.ok(existsSync(join(root, 'src/b.js')));
  });

  it('rejecting the plan cancels the run before any code is written', async () => {
    const agentCalls: string[] = [];
    const { run, root, bus } = await setup({ agentCalls });
    const report = await run('Create modules a and b', { approvePlan: async () => false });
    assert.equal(report.status, 'cancelled');
    assert.deepEqual(agentCalls, []);
    assert.ok(!existsSync(join(root, 'src')));
    assert.match(readFileSync(report.reportPath, 'utf8'), /Cancelled:\*\* the plan was not approved/);
    assert.ok(bus.ofType('log.info').some((e) => /plan rejected/.test(e.message ?? '')));
    assert.deepEqual(Orchestrator.resumable(root), [], 'a cancelled run is not resumable');
  });
});

describe('budgets and resume', () => {
  it('stops at the token budget without touching the project, then resumes only the unfinished subtask', async () => {
    const agentCalls: string[] = [];
    const { run, resume, root, bus } = await setup({ agentCalls, agent: (id, step) => writer(id, step, true) }, { orchestrator: { maxTokens: 1_000_000 } });
    const first = await run('Create modules a and b', { mode: 'split' });
    assert.equal(first.status, 'incomplete');
    assert.match(first.stopReason!, /token budget used up \(\d+ \/ 1000000\)/);
    assert.ok(!existsSync(join(root, 'src/a.js')), 'nothing merged when stopped');
    assert.match(readFileSync(first.reportPath, 'utf8'), /Stopped:\*\* token budget[\s\S]*kurultay run --resume/);
    assert.ok(first.usage!.tokensOut >= 5_000_000);
    assert.ok(bus.ofType('log.warn').some((e) => /stopping the run/.test(e.message ?? '')));
    const list = Orchestrator.resumable(root);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, first.sessionId);
    assert.equal(list[0].left, 1, 'T1 finished, T2 left');
    const t1Calls = agentCalls.filter((c) => c.startsWith('T1')).length;

    const second = await resume(undefined, { budget: { tokens: 0 } });
    assert.equal(second.status, 'completed', JSON.stringify(second.requirementCheck));
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.resumed, true);
    assert.equal(agentCalls.filter((c) => c.startsWith('T1')).length, t1Calls, 'T1 was not run again');
    assert.equal(readFileSync(join(root, 'src/b.js'), 'utf8'), "import { A } from './a.js';\nexport const B = A + 1;\n");
    assert.ok(existsSync(join(root, 'src/a.js')));
    assert.deepEqual(second.subtasks.map((s) => `${s.subtask.id}:${s.status}`), ['T1:done', 'T2:done']);
    assert.ok(second.usage!.requests > first.usage!.requests, 'usage accumulates across resumes');
    assert.equal(second.stopReason, undefined);
    assert.deepEqual(Orchestrator.resumable(root), []);
    await assert.rejects(resume(first.sessionId), /already finished/);
    await assert.rejects(resume(), /No unfinished task/);
    await assert.rejects(resume('nope'), /Session not found/);
    const md = readFileSync(second.reportPath, 'utf8');
    assert.match(md, /## Model usage[\s\S]*\| m1@e \| \d+ \|/);
    assert.match(md, /Usage:\*\* \d+ requests .* \(including the resumed session\)/);
  });

  it('a user interrupt (Ctrl+C) leaves the run resumable', async () => {
    const ctrl = new AbortController();
    const { run, resume, root } = await setup({
      agent: (id, step) => {
        if (id === 'T2' && step === 0) ctrl.abort(new Error('cancelled by the user'));
        return writer(id, step);
      },
    });
    await assert.rejects(run('Create modules a and b', { mode: 'split', signal: ctrl.signal }), /cancelled/);
    const list = Orchestrator.resumable(root);
    assert.equal(list.length, 1);
    assert.match(list[0].stopReason ?? '', /cancelled/);
    const r = await resume(list[0].id);
    assert.equal(r.status, 'completed');
    assert.ok(existsSync(join(root, 'src/b.js')));
  });

  it('stops at the time budget; a budget hit while planning keeps the plan for resuming', async () => {
    const slow = await setup({ agent: (id, step) => writer(id, step) }, {}, { latencyMs: 400 });
    const r = await slow.run('Create modules a and b', { mode: 'split', budget: { minutes: 0.01 } });
    assert.equal(r.status, 'incomplete');
    assert.match(r.stopReason!, /time budget used up/);

    const tiny = await setup({});
    const p = await tiny.run('Create modules a and b', { budget: { tokens: 1 } });
    assert.equal(p.status, 'incomplete');
    assert.match(p.stopReason!, /token budget/);
    assert.ok(!existsSync(join(tiny.root, 'src')));
    const left = Orchestrator.resumable(tiny.root);
    assert.equal(left[0]?.left, p.plan.subtasks.length, 'the plan is kept; no subtask ran');
  });

  it('renders the per-model usage table', () => {
    const t = renderUsageTable({ requests: 3, tokensIn: 25_000, tokensOut: 2_000_000, seconds: 5, byModel: { 'a@e': { requests: 2, tokensIn: 25_000, tokensOut: 2_000_000, ms: 3000, errors: 1, truncated: 1 }, 'b@e': { requests: 0, tokensIn: 0, tokensOut: 0, ms: 0, errors: 2, truncated: 0 } } });
    assert.equal(t[2], '| a@e | 2 | 25K | 2.0M | 1.5 s | 1 | 1 |');
    assert.equal(t[3], '| b@e | 0 | 0 | 0 | - | 2 | 0 |');
  });
});
