import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Materializer, Overlay } from '../../src/agent/workspace.js';
import { crossTest, testFilesOf, TEST_PATH } from '../../src/orchestrator/cross-test.js';
import { config, recordingBus, tmpProject } from '../helpers.js';

const test = (call: string, want: number | string) => `import { twice } from '../src/m.mjs';\nif (${call} !== ${want}) throw new Error('twice is wrong');\n`;
// runs every tests/*.test.mjs; exit code 1 when one throws (works the same on Windows)
const RUNNER = "import { readdirSync } from 'node:fs';\nimport { pathToFileURL } from 'node:url';\nfor (const f of readdirSync('tests').filter((f) => f.endsWith('.test.mjs'))) await import(pathToFileURL('tests/' + f).href);\n";

describe('cross-test selection', () => {
  it('recognises test files in the usual layouts', () => {
    for (const p of ['tests/a.test.mjs', 'src/test/java/FooTest.java', 'pkg/x_test.go', 'test_util.py', 'src/foo.spec.ts', 'tests/test_main.cpp']) assert.ok(TEST_PATH.test(p), p);
    for (const p of ['src/main.c', 'src/latest.c', 'contest/a.js']) assert.ok(!TEST_PATH.test(p), p);
  });

  it('runs every candidate against the rivals\' reproducing tests', async () => {
    const root = tmpProject({ 'src/m.mjs': 'export const twice = (x) => x + x + 1;\n', 'tests/base.test.mjs': test('1', 1), 'run.mjs': RUNNER });
    const cfg = config({ endpoints: [{ name: 'e', baseUrl: 'http://e/v1' }], verify: { test: 'node run.mjs' } });
    const materializer = new Materializer(root, join(root, '.kurultay'));
    const base = new Overlay('int', root);
    const cand = (id: string, code: string, tests: Record<string, string>) => {
      const o = base.fork(id);
      o.write('src/m.mjs', code);
      for (const [p, c] of Object.entries(tests)) o.write(p, c);
      return { id, overlay: o };
    };
    const right = cand('right', 'export const twice = (x) => x * 2;\n', { 'tests/right.test.mjs': test('twice(2)', 4) });
    const overfit = cand('overfit', 'export const twice = (x) => (x === 3 ? 6 : 0);\n', { 'tests/overfit.test.mjs': test('twice(3)', 6) });
    const silent = cand('silent', 'export const twice = (x) => 2 * x;\n', {});
    // its test passes on the original code too: it does not count
    const weak = cand('weak', 'export const twice = (x) => x;\n', { 'tests/weak.test.mjs': test('typeof twice', "'function'") });
    assert.deepEqual(testFilesOf(right.overlay), ['tests/right.test.mjs']);

    const bus = recordingBus();
    const r = (await crossTest([right, overfit, silent, weak], base, materializer, cfg, { bus, source: 'T1' }))!;
    assert.deepEqual(r.suites.map((s) => [s.from, s.reproduces]), [['right', true], ['overfit', true], ['weak', false]]);
    assert.deepEqual(Object.fromEntries(r.scores), {
      right: { passed: 1, total: 1 },
      overfit: { passed: 0, total: 1 },
      silent: { passed: 2, total: 2 },
      weak: { passed: 0, total: 2 },
    });
    assert.ok(bus.ofType('log.info').some((e) => /rival tests: right 1\/1/.test(e.message ?? '')));

    // nothing to compare: no test command, one candidate, or no reproducing test
    assert.equal(await crossTest([right, silent], base, materializer, config({ endpoints: [{ name: 'e', baseUrl: 'http://e/v1' }] })), undefined);
    assert.equal(await crossTest([right], base, materializer, cfg), undefined);
    const none = (await crossTest([silent, weak], base, materializer, cfg, { bus }))!;
    assert.equal(none.scores.size, 0);
    assert.ok(bus.ofType('log.debug').some((e) => /no candidate test fails on the original code/.test(e.message ?? '')));
  });
});
