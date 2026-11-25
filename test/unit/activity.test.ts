import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ActivityTracker, describePurpose, describeTool } from '../../src/tui/activity.js';
import { attachTerminal, section } from '../../src/ui/terminal.js';
import { cleanTitle } from '../../src/orchestrator/planner.js';
import { EventBus } from '../../src/util/events.js';
import { stripAnsi } from '../../src/tui/keys.js';

describe('live activity: what each model is doing', () => {
  it('describes tool calls and request purposes in plain words', () => {
    assert.equal(describeTool('read_file', { path: 'src/a/Foo.java' }), 'reading Foo.java');
    assert.equal(describeTool('edit_file', { path: 'b\\c.cpp' }), 'editing c.cpp');
    assert.equal(describeTool('write_file', {}), 'writing a file');
    assert.equal(describeTool('delete_file', { path: 'x' }), 'deleting x');
    assert.equal(describeTool('list_dir', { path: 'src' }), 'browsing src');
    assert.equal(describeTool('grep', { pattern: 'parseLine' }), 'searching "parseLine"');
    assert.equal(describeTool('search_code', { query: 'a'.repeat(50) }).length, 'searching ""'.length + 30);
    assert.equal(describeTool('run_command', { command: 'ctest --test-dir build' }), 'running `ctest --test-dir build`');
    assert.equal(describeTool('repo_map'), 'looking at the repository map');
    assert.equal(describeTool('skill', { name: 'cmake' }), 'loading skill cmake');
    assert.equal(describeTool('run_tests'), 'running the tests');
    assert.equal(describeTool('build'), 'building');
    assert.equal(describeTool('finish'), 'finishing up');
    assert.equal(describeTool('some_mcp_tool'), 'some mcp tool');
    assert.equal(describePurpose('council.review'), 'reviewing the candidates');
    assert.equal(describePurpose('summary.architecture.draft'), 'writing the architecture document');
    assert.equal(describePurpose('custom'), 'custom');
  });

  it('follows workers and other requests through the event stream', () => {
    const bus = new EventBus();
    const t = new ActivityTracker(bus);
    bus.emitEvent('run.start', { data: { sessionId: 's', models: 2 } });
    assert.match(t.now, /planning/);
    bus.emitEvent('llm.request', { source: 'big@main', data: { purpose: 'plan.draft' } });
    assert.deepEqual(t.lines(200), ['  now: planning: the models draft plans independently', '  big           drafting a plan']);
    bus.emitEvent('llm.response', { source: 'big@main', data: { purpose: 'plan.draft' } });
    bus.emitEvent('run.plan', { data: { mode: 'race', subtasks: ['a'] } });
    bus.emitEvent('subtask.start', { source: 'T1', data: { title: 'a', models: [] } });
    bus.emitEvent('llm.request', { source: 'big@main', data: { purpose: 'localize.files' } });
    assert.match(t.now, /localisation/);
    bus.emitEvent('llm.error', { source: 'big@main', data: { kind: 'network' } });
    bus.emitEvent('worker.start', { source: 'T1-1', data: { model: 'big@main' } });
    bus.emitEvent('worker.start', { source: 'T1-2', data: { model: 'small@gpu2' } });
    assert.match(t.now, /T1: 2 candidates are coding/);
    bus.emitEvent('llm.request', { source: 'small@gpu2', data: { purpose: 'worker:T1-2' } });
    bus.emitEvent('llm.request', { source: 'x@main', data: { purpose: 'worker:T9-1' } }); // unknown worker: ignored
    bus.emitEvent('worker.tool', { source: 'T1-1', data: { tool: 'edit_file', args: { path: 'src/Foo.java' } } });
    bus.emitEvent('worker.failover', { source: 'T1-1', data: { from: 'big@main', to: 'other@main' } });
    bus.emitEvent('llm.request', { source: 'big@main', data: { purpose: 'worker:T1-1' } });
    const rows = t.lines(200);
    assert.ok(rows.some((r) => /T1-1 +big +thinking \(after editing Foo\.java\) · step 1/.test(r)), rows.join('\n'));
    assert.ok(rows.some((r) => /T1-2 +small@gpu2 +thinking…/.test(r)), rows.join('\n'));
    assert.ok(t.lines(20).every((r) => r.length <= 20));
    bus.emitEvent('worker.end', { source: 'T1-1', data: {} });
    bus.emitEvent('worker.end', { source: 'T1-2', data: {} });
    bus.emitEvent('llm.request', { source: 'judge@main', data: { purpose: 'council.review' } });
    bus.emitEvent('llm.request', { source: 'judge@main', data: { purpose: 'council.review' } });
    assert.match(t.now, /review/);
    bus.emitEvent('llm.response', { source: 'judge@main', data: { purpose: 'council.review' } });
    assert.ok(t.lines().some((r) => /judge +reviewing the candidates/.test(r)));
    bus.emitEvent('llm.response', { source: 'judge@main', data: { purpose: 'council.review' } });
    bus.emitEvent('llm.response', { source: 'nobody@main', data: { purpose: 'x' } });
    bus.emitEvent('subtask.winner', { source: 'T1', data: {} });
    assert.match(t.now, /chosen/);
    bus.emitEvent('llm.request', { source: 'judge@main', data: { purpose: 'plan.judge' } });
    assert.match(t.now, /choosing the best plan/);
    bus.emitEvent('run.verify', { data: {} });
    assert.match(t.now, /verification/);
    bus.emitEvent('run.end', { data: {} });
    assert.deepEqual(t.lines(), []);
    t.dispose();
    bus.emitEvent('run.start', { data: {} });
    assert.equal(t.now, '');
  });
});

describe('terminal renderer: sections and plain-language lines', () => {
  it('draws phase headings with an explanation and quiets retried requests', () => {
    assert.match(stripAnsi(section('Planning', 'why', 40)), /^\n── Planning ─{20,}\nwhy$/);
    assert.equal(stripAnsi(section('X', undefined, 10)).split('\n').length, 2);
    const bus = new EventBus();
    const out: string[] = [];
    const stop = attachTerminal(bus, { write: (l) => out.push(stripAnsi(l)), width: () => 60 });
    bus.emitEvent('run.start', { data: { sessionId: 's1', models: 2 } });
    bus.info('planner', 'plan drafts: a@main, b@main');
    bus.emitEvent('run.plan', { data: { mode: 'split', subtasks: ['one', 'two'] } });
    bus.emitEvent('run.iteration', { data: { iteration: 1, subtasks: 2 } });
    bus.emitEvent('subtask.start', { source: 'T1', data: { title: 'one', models: ['a@main', 'b@main', 'a@main'] } });
    bus.info('T1', 'localised: src/a/Foo.java:Foo, bar, src/b/Bar.java:Bar');
    bus.info('council', '2 candidates, 1 reviewers: b@main');
    bus.info('council', 'something else');
    bus.emitEvent('llm.error', { source: 'a@main', message: 'connection error (a@main): fetch failed [ECONNRESET]', data: { kind: 'network', attempt: 1, retry: true } });
    bus.emitEvent('llm.error', { source: 'a@main', message: 'x', data: { kind: 'timeout', attempt: 1, retry: true } });
    bus.emitEvent('llm.error', { source: 'a@main', message: 'x', data: { kind: 'server', attempt: 1, retry: true } });
    bus.emitEvent('llm.error', { source: 'a@main', message: 'x', data: { kind: 'server', attempt: 3, retry: false } });
    bus.emitEvent('run.iteration', { data: { iteration: 2, subtasks: 1 } });
    bus.emitEvent('run.verify', { data: { skipped: true } });
    bus.emitEvent('run.verify', { data: { ok: true } });
    bus.emitEvent('run.merge', { data: { written: ['a'], conflicts: [], root: '/p/x' } });
    stop();
    const text = out.join('\n');
    for (const want of [
      '2 models · session s1',
      '── Planning',
      'plan drafts by a@main, b@main',
      '── Plan · split · 2 subtasks',
      'independent subtasks run in parallel',
      '── Coding',
      '▸ T1  one',
      '3 candidates: a@main ×2, b@main',
      '⌖ T1 code to change: Foo.java (Foo, bar) · Bar.java (Bar)',
      '⚖ review: 2 candidates · reviewers: b@main',
      'council: something else',
      '↻ a@main: connection dropped, retrying',
      '↻ a@main: no answer (timeout), retrying',
      '↻ a@main: request failed (server), retrying',
      '⚠ a@main: request failed (server)',
      '── Iteration 2',
      'the code was not compiled or tested',
      '✓ verification: build and tests passed',
      'Applied to the project (/p/x): 1 file written',
    ])
      assert.ok(text.includes(want), `${want}\n---\n${text}`);
  });

  it('cleans titles that leaked JSON syntax', () => {
    assert.equal(cleanTitle("Implement Quoted CSV Parsing Logic in CsvProductLoader', "), 'Implement Quoted CSV Parsing Logic in CsvProductLoader');
    assert.equal(cleanTitle('"Add  tests",'), 'Add tests');
    assert.equal(cleanTitle(undefined), '');
  });
});

describe('plan consolidation', () => {
  it('folds test-only and check-only subtasks into the code subtask (the B2 plan)', async () => {
    const { consolidatePlan, filesOf } = await import('../../src/orchestrator/planner.js');
    const files = ['src/main/java/com/x/io/CsvProductLoader.java', 'src/test/java/com/x/CsvProductLoaderTest.java', 'src/main/java/com/x/util/Validation.java'];
    const sub = (id: string, title: string, description: string, f: string[] = []) => ({ id, title, description, files: f, dependsOn: [] as string[], critical: false });
    const plan = {
      subtasks: [
        sub('T1', 'Implement Quoted CSV Parsing Logic in CsvProductLoader', 'Analyze CsvProductLoader.java and implement a quote-aware parser.'),
        sub('T2', 'Verify CSV Parsing with Unit Tests and Demo Run', 'Create new test cases in CsvProductLoaderTest.java.'),
        sub('T3', 'Edge Case Validation and Regression Check', 'Check Validation.requireNonBlank with the new parser.'),
      ],
    };
    const bus = new EventBus();
    const infos: string[] = [];
    bus.on('event', (e) => e.type === 'log.info' && infos.push(e.message ?? ''));
    consolidatePlan(plan, files, bus);
    assert.equal(plan.subtasks.length, 1);
    assert.match(plan.subtasks[0].description, /Also \(Verify CSV Parsing[\s\S]*Also \(Edge Case/);
    assert.match(infos.join(), /merged 3 subtasks into 1/);
    assert.deepEqual([...filesOf(sub('X', 'touch CsvProductLoader', ''), files)], ['src/main/java/com/x/io/CsvProductLoader.java'], 'class-like stem');
    assert.deepEqual([...filesOf(sub('X', 'fix the loader', ''), files)], []);
  });

  it('subtasks that share a file run one after the other; independent ones stay parallel', async () => {
    const { consolidatePlan } = await import('../../src/orchestrator/planner.js');
    const sub = (id: string, f: string[], dependsOn: string[] = []) => ({ id, title: `change ${id}`, description: '', files: f, dependsOn, critical: false });
    const plan = { subtasks: [sub('T1', ['a.c']), sub('T2', ['b.c']), sub('T3', ['a.c', 'c.c']), sub('T4', ['c.c'], ['T3'])] };
    consolidatePlan(plan, ['a.c', 'b.c', 'c.c']);
    assert.deepEqual(plan.subtasks.map((s) => [s.id, s.dependsOn]), [['T1', []], ['T2', []], ['T3', ['T1']], ['T4', ['T3']]]);
    const one = { subtasks: [sub('T1', ['a.c'])] };
    consolidatePlan(one, ['a.c']);
    assert.equal(one.subtasks.length, 1);
    // a test-only subtask without shared files goes to the first code subtask; deps are rewired
    const t = { subtasks: [sub('T1', ['a.c']), { ...sub('T2', ['b.c']), title: 'Add tests for the parser' }, sub('T3', ['d.c'], ['T2'])] };
    consolidatePlan(t, []);
    assert.deepEqual(t.subtasks.map((s) => [s.id, s.dependsOn]), [['T1', []], ['T3', ['T1']]]);
  });

  it('recognises a repeated review finding despite rephrasing', async () => {
    const { sameFinding } = await import('../../src/orchestrator/orchestrator.js');
    assert.ok(sameFinding('The candidate provided only the test suite and no implementation changes for CsvProductLoader', '[P0] Only the test suite was provided; the implementation changes for CsvProductLoader are missing'));
    assert.ok(!sameFinding('null pointer in parseLine', 'price column is not validated'));
    assert.ok(sameFinding('!!', '!!'));
  });
});
