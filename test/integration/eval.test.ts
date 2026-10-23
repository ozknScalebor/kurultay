import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadSuite, renderEval, runEval, validateSuite } from '../../src/eval/eval.js';
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
    await assert.rejects(runEval({ suiteDir: dir, tasks: ['nope'], config: dead }), /no task selected/);
    assert.throws(() => loadSuite(tmpProject({})), /suite.json not found/);
    assert.throws(() => loadSuite(tmpProject({ 'suite.json': '{"name":"x","project":"p","tasks":[]}' })), /at least one task/);
    assert.throws(() => loadSuite(tmpProject({ 'suite.json': '{"name":"x","project":"p","tasks":[{"id":"a","prompt":"b"}]}' })), /project folder missing/);
    assert.throws(() => loadSuite(tmpProject({ 'p/a': '', 'suite.json': '{"name":"x","project":"p","tasks":[{"id":"a","prompt":"b"}]}' })), /no check command/);
    assert.throws(() => loadSuite(tmpProject({ 'p/a': '', 'suite.json': '{"name":"x","project":"p","check":"c","tasks":[{"id":"a","prompt":"b"},{"id":"a","prompt":"c"}]}' })), /duplicate task id/);
    assert.throws(() => loadSuite(tmpProject({ 'p/a': '', 'suite.json': '{"name":"x","project":"p","check":"c","tasks":[{"id":"a"}]}' })), /needs an id and a prompt/);
    assert.match(renderEval({ suite: 's', startedAt: 'a', finishedAt: 'b', attempts: [], byMode: {} }), /# Kurultay evaluation: s/);
  });
});
