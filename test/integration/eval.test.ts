import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { appendHistory, failureLines, loadSuite, modeStats, readHistory, renderEval, renderHistory, runEval, scoreFolder, validateSuite, type EvalAttempt } from '../../src/eval/eval.js';
import { DEFAULT_MOCK_MODELS, startMockServer, type MockServerHandle } from '../../src/mock/server.js';
import { CLAMP_PROJECT, tmpProject } from '../helpers.js';

let mock: MockServerHandle;
const prevHome = process.env.KURULTAY_HOME;
before(async () => {
  mock = await startMockServer(DEFAULT_MOCK_MODELS);
  process.env.KURULTAY_HOME = tmpProject({}); // learned stats / caches stay out of the real home
});
after(() => {
  if (prevHome === undefined) delete process.env.KURULTAY_HOME;
  else process.env.KURULTAY_HOME = prevHome;
  return mock.close();
});

const HIDDEN = "import { clamp } from './src/mathutil.js';\nif (clamp(15, 0, 10) !== 10 || clamp(-1, 0, 10) !== 0 || clamp(4, 0, 10) !== 4) { console.error('clamp yanlış'); process.exit(1); }\nconsole.log('ok');\n";
const TWICE = "import * as m from './src/mathutil.js';\nif (typeof m.twice !== 'function' || m.twice(21) !== 42) { console.error('twice yok'); process.exit(1); }\n";

function suite(extra: Record<string, string> = {}) {
  const { 'test.js': _visible, ...project } = CLAMP_PROJECT;
  const files: Record<string, string> = {
    'suite.json': JSON.stringify({
      name: 'mini',
      project: 'project',
      check: 'node hidden_test.js',
      tasks: [
        { id: 'clamp', prompt: 'Implement clamp in src/mathutil.js', timeoutSec: 120 },
        { id: 'twice', prompt: 'Add an exported function twice(x) returning 2*x to src/mathutil.js', timeoutSec: 120 },
      ],
    }),
    'hidden/clamp/hidden_test.js': HIDDEN,
    'hidden/twice/hidden_test.js': TWICE,
    'solutions/clamp/src/mathutil.js': 'export function clamp(v, a, b) { return Math.min(Math.max(v, a), b); }\n',
    'solutions/twice/src/mathutil.js': 'export function clamp() { throw new Error("TODO"); }\nexport const twice = (x) => 2 * x;\n',
    ...Object.fromEntries(Object.entries(project).map(([k, v]) => [`project/${k}`, v])),
    ...extra,
  };
  return tmpProject(files);
}

describe('evaluation harness', () => {
  it('validates the suite: tasks fail on the base project and pass with the reference solution', async () => {
    const dir = suite();
    const r = await validateSuite({ suiteDir: dir });
    assert.deepEqual(
      r.map((x) => [x.task, x.baselineFails, x.solutionPasses]),
      [
        ['clamp', true, true],
        ['twice', true, true],
      ],
    );
    const lines: string[] = [];
    const bad = suite({ 'solutions/clamp/src/mathutil.js': 'export function clamp() { return 0; }\n' });
    const r2 = await validateSuite({ suiteDir: bad, tasks: ['clamp'], onProgress: (l) => lines.push(l), keepWork: true, outDir: join(bad, 'out') });
    assert.equal(r2[0].solutionPasses, false);
    assert.match(lines[0], /solution FAILS/);
  });

  it('runs every task in every mode on a fresh copy, scores with hidden tests and reports cost', async () => {
    const dir = suite();
    const cfg = join(dir, 'k.json');
    writeFileSync(cfg, JSON.stringify({ endpoints: [{ name: 'mock', baseUrl: mock.url }], skills: { includeUser: false } }));
    const progress: string[] = [];
    const { summary, reportPath, jsonPath } = await runEval({ suiteDir: dir, modes: ['single', 'race'], config: cfg, outDir: join(dir, 'out'), onProgress: (l) => progress.push(l) });
    assert.equal(summary.attempts.length, 4);
    const clamp = summary.attempts.filter((a) => a.task === 'clamp');
    assert.ok(clamp.every((a) => a.passed && a.baselineFailed), JSON.stringify(clamp));
    assert.ok(summary.attempts.filter((a) => a.task === 'twice').every((a) => !a.passed), 'the scripted mock cannot add twice()');
    assert.ok(clamp.every((a) => a.requests > 0 && a.tokensIn > 0 && a.seconds > 0));
    assert.ok(summary.byMode.race.avgRequests > summary.byMode.single.avgRequests, 'race costs more requests');
    assert.equal(summary.byMode.single.passRate, 0.5);
    assert.match(progress.join('\n'), /✓ clamp \[single\]/);
    assert.match(progress.join('\n'), /✗ twice \[race\]/);
    const md = readFileSync(reportPath, 'utf8');
    assert.match(md, /\| single \| 2 \| 1 \| 50% \|/);
    assert.match(md, /### twice \[single\][\s\S]*twice yok/);
    assert.ok(existsSync(jsonPath));
    assert.ok(!existsSync(join(dir, 'out', 'work', 'clamp-single-1')), 'work copies removed unless --keep');
    assert.match(readFileSync(join(dir, 'project/src/mathutil.js'), 'utf8'), /TODO/, 'the suite project itself is never modified');
  });

  it('reports errors per attempt and rejects broken suites', async () => {
    const dir = suite({ 'project/build/CMakeCache.txt': 'CMAKE_HOME_DIRECTORY=/elsewhere', 'project/.build/classes/A.class': 'x', 'project/src/build/keep.js': 'x' });
    const dead = join(dir, 'dead.json');
    writeFileSync(dead, JSON.stringify({ endpoints: [{ name: 'dead', baseUrl: 'http://127.0.0.1:9/v1' }] }));
    const { summary } = await runEval({ suiteDir: dir, tasks: ['clamp'], config: dead, outDir: join(dir, 'o2'), keepWork: true });
    assert.equal(summary.attempts[0].status, 'error');
    assert.match(summary.attempts[0].error!, /no usable model/);
    assert.ok(existsSync(summary.attempts[0].workDir), '--keep keeps the work copy');
    assert.ok(!existsSync(join(summary.attempts[0].workDir, 'build')) && !existsSync(join(summary.attempts[0].workDir, '.build')), 'stale build outputs are not copied');
    assert.ok(existsSync(join(summary.attempts[0].workDir, 'src', 'build', 'keep.js')), 'only top-level build dirs are skipped');
    const kept = await runEval({ suiteDir: dir, tasks: ['clamp'], config: dead, outDir: join(dir, 'o3'), keepFailed: true });
    assert.ok(existsSync(join(kept.summary.attempts[0].workDir, 'src')), 'keepFailed keeps a failed work copy');
    assert.ok(!existsSync(join(kept.summary.attempts[0].workDir, 'build')), '… without build output');
    await assert.rejects(runEval({ suiteDir: dir, tasks: ['nope'], config: dead }), /no task selected/);
    assert.throws(() => loadSuite(tmpProject({})), /suite.json not found/);
    assert.throws(() => loadSuite(tmpProject({ 'suite.json': '{"name":"x","project":"p","tasks":[]}' })), /at least one task/);
    assert.throws(() => loadSuite(tmpProject({ 'suite.json': '{"name":"x","project":"p","tasks":[{"id":"a","prompt":"b"}]}' })), /project folder missing/);
    assert.throws(() => loadSuite(tmpProject({ 'p/a': '', 'suite.json': '{"name":"x","project":"p","tasks":[{"id":"a","prompt":"b"}]}' })), /no check command/);
    assert.throws(() => loadSuite(tmpProject({ 'p/a': '', 'suite.json': '{"name":"x","project":"p","check":"c","tasks":[{"id":"a","prompt":"b"},{"id":"a","prompt":"c"}]}' })), /duplicate task id/);
    assert.throws(() => loadSuite(tmpProject({ 'p/a': '', 'suite.json': '{"name":"x","project":"p","check":"c","tasks":[{"id":"a"}]}' })), /needs an id and a prompt/);
    assert.match(renderEval({ suite: 's', startedAt: 'a', finishedAt: 'b', attempts: [], byMode: {} }), /# Kurultay evaluation: s/);
  });

  it('failure lines come first, then the end of the output', () => {
    const out = ['Test project', '  [HATA] split_frames: t.cpp:34: CHECK_EQ(d.buffered(), 5u) beklenen 5 ama 4', ...Array.from({ length: 40 }, (_, i) => `  [OK]   test_${i}`), '0% tests passed, 1 tests failed out of 1', 'Errors while running CTest'].join('\n');
    const lines = failureLines(out, 5).split('\n');
    assert.match(lines[0], /\[HATA\] split_frames/);
    assert.equal(lines[1], '…');
    assert.equal(lines.length, 7);
    assert.equal(failureLines('a\nb\nc', 2), 'b\nc');
  });

  it('pass@k and pass^k over trials, a history per version', () => {
    const a = (task: string, passed: boolean): EvalAttempt => ({ task, mode: 'single', repeat: 1, passed, baselineFailed: true, status: 'x', seconds: 10, requests: 4, tokensIn: 1, tokensOut: 1, llmErrors: 0, models: [], changedFiles: 1, iterations: 1, checkOutput: '', workDir: '' });
    const st = modeStats([a('t1', true), a('t1', true), a('t1', true), a('t2', true), a('t2', false), a('t2', false), a('t3', false), a('t3', false), a('t3', false)]);
    assert.equal(st.trials, 3);
    assert.equal(st.passRate, 4 / 9);
    assert.equal(st.passAtK, 2 / 3, 't1 and t2 solved at least once');
    assert.equal(st.passHatK, 1 / 3, 'only t1 solved every time');
    assert.match(renderEval({ suite: 's', startedAt: 'a', finishedAt: 'b', attempts: [], byMode: { single: st } }), /\| single \| 9 \| 4 \| 44% \| 67% \| 33% \|/);
    const file = join(tmpProject({}), 'h', 'history.jsonl');
    assert.deepEqual(readHistory(file), []);
    assert.match(renderHistory([]), /No evaluation runs/);
    appendHistory(file, { suite: 's', startedAt: 'a', finishedAt: '2026-11-17', attempts: [], byMode: { single: st }, version: '0.9.0' }, ['t1', 't2', 't3']);
    writeFileSync(file, readFileSync(file, 'utf8') + 'not json\n');
    appendHistory(file, { suite: 's', startedAt: 'a', finishedAt: '2026-11-18', attempts: [], byMode: { single: { ...st, passRate: 1 } }, version: '0.9.1' }, ['t1', 't2', 't3']);
    const h = readHistory(file);
    assert.equal(h.length, 2);
    const md = renderHistory(h);
    assert.match(md, /\| 0\.9\.0 \| s \| single \| 3 \| 3 \| 44\.4% \| 66\.7% \| 33\.3% \|/);
    assert.match(md, /\| 0\.9\.1 \| s \| single \| 3 \| 3 \| 100\.0% \|/);
  });

  it('scores a folder another agent worked on with the same hidden tests, task by task', async () => {
    const dir = suite();
    const solved = tmpProject({ 'src/mathutil.js': 'export function clamp(v, a, b) { return Math.min(Math.max(v, a), b); }\n', 'package.json': '{"type":"module"}' });
    const lines: string[] = [];
    const r = await scoreFolder({ suiteDir: dir, dir: solved, onProgress: (l) => lines.push(l) });
    assert.deepEqual(r.map((x) => [x.task, x.passed]), [['clamp', true], ['twice', false]]);
    assert.match(r[1].output, /twice yok/);
    assert.deepEqual(lines, ['✓ clamp', '✗ twice']);
    await assert.rejects(scoreFolder({ suiteDir: dir, dir: join(dir, 'nope') }), /folder not found/);
    await assert.rejects(scoreFolder({ suiteDir: dir, dir: solved, tasks: ['x'] }), /no task selected/);
  });
});
