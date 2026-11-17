import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { collect, loadInstances, patchOf, prepare, readPredictions, runAll, sampleInstances, sweprompt } from '../../src/eval/swebench.js';
import { DEFAULT_MOCK_MODELS, startMockServer, type MockServerHandle } from '../../src/mock/server.js';
import { CLAMP_PROJECT, tmpProject } from '../helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let mock: MockServerHandle;
const prevHome = process.env.KURULTAY_HOME;
before(async () => {
  mock = await startMockServer(DEFAULT_MOCK_MODELS);
  process.env.KURULTAY_HOME = tmpProject({});
});
after(() => {
  if (prevHome === undefined) delete process.env.KURULTAY_HOME;
  else process.env.KURULTAY_HOME = prevHome;
  return mock.close();
});

/** A "GitHub" of local bare repositories and a two-instance dataset. */
function fixture() {
  const host = tmpProject({});
  const src = tmpProject(CLAMP_PROJECT);
  git(src, 'init', '-q');
  git(src, 'add', '-A');
  git(src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  const base = git(src, 'rev-parse', 'HEAD');
  writeFileSync(join(src, 'README.md'), 'later change\n');
  git(src, 'add', '-A');
  git(src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'later');
  mkdirSync(join(host, 'acme'), { recursive: true });
  git(host, 'clone', '-q', '--bare', src, join(host, 'acme', 'mathlib.git'));
  const dataset = join(host, 'verified.jsonl');
  const rows = [
    { instance_id: 'acme__mathlib-1', repo: 'acme/mathlib', base_commit: base, problem_statement: 'clamp(15, 0, 10) should return 10. Implement clamp in src/mathutil.js.' },
    { instance_id: 'acme__mathlib-2', repo: 'acme/mathlib', base_commit: base, problem_statement: 'Second issue.' },
    { instance_id: 'broken', repo: 'x' },
  ];
  writeFileSync(dataset, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { host, dataset, base, gitBase: `file://${host}` };
}

describe('SWE-bench adapter', () => {
  it('loads, samples deterministically and builds the prompt', () => {
    const f = fixture();
    const all = loadInstances(f.dataset);
    assert.equal(all.length, 2, 'rows without the required fields are skipped');
    const many = Array.from({ length: 40 }, (_, i) => ({ instance_id: `r__p-${i}` }));
    assert.deepEqual(sampleInstances(many, 5, 7), sampleInstances([...many].reverse(), 5, 7), 'order of the file does not matter');
    assert.notDeepEqual(sampleInstances(many, 5, 7), sampleInstances(many, 5, 8));
    assert.match(sweprompt(all[0]), /Do not modify or delete existing tests[\s\S]*<issue>\nclamp\(15, 0, 10\)/);
    const json = join(tmpProject({}), 'd.json');
    writeFileSync(json, JSON.stringify([all[0]]));
    assert.equal(loadInstances(json).length, 1);
    writeFileSync(json, '[]');
    assert.throws(() => loadInstances(json), /no SWE-bench instances/);
  });

  it('prepares checkouts at the base commit, runs Kurultay into predictions and collects other agents\' patches', async () => {
    const f = fixture();
    const dir = join(tmpProject({}), 'work');
    const lines: string[] = [];
    const list = prepare({ dataset: f.dataset, dir, gitBase: f.gitBase, onProgress: (l) => lines.push(l) });
    assert.equal(list.length, 2);
    assert.equal(git(join(dir, 'acme__mathlib-1'), 'rev-parse', 'HEAD'), f.base);
    assert.ok(!existsSync(join(dir, 'acme__mathlib-1', 'README.md')), 'the later commit is not checked out');
    assert.match(readFileSync(join(dir, 'prompts', 'acme__mathlib-1.txt'), 'utf8'), /<issue>/);
    assert.equal(lines.filter((l) => /cloning acme\/mathlib/.test(l)).length, 1, 'each repository is cloned once');
    prepare({ dataset: f.dataset, dir, gitBase: f.gitBase, instances: ['acme__mathlib-1'] }); // again: no error, nothing re-cloned
    assert.equal(loadInstances(join(dir, 'tasks.jsonl')).length, 1);
    assert.throws(() => prepare({ dataset: f.dataset, dir, gitBase: f.gitBase, instances: ['nope'] }), /not in the dataset: nope/);
    prepare({ dataset: f.dataset, dir, gitBase: f.gitBase });

    const cfg = join(dir, '..', 'k.json');
    writeFileSync(cfg, JSON.stringify({ endpoints: [{ name: 'mock', baseUrl: mock.url }], skills: { includeUser: false } }));
    const progress: string[] = [];
    const r = await runAll({ dir, name: 'kurultay-test', config: cfg, instances: ['acme__mathlib-1'], mode: 'single', onProgress: (l) => progress.push(l) });
    assert.equal(r.done, 1);
    const preds = readPredictions(r.out);
    assert.equal(preds.length, 1);
    assert.equal(preds[0].model_name_or_path, 'kurultay-test');
    assert.match(preds[0].model_patch, /^diff --git a\/src\/mathutil\.js/m);
    assert.match(preds[0].model_patch, /Math\.min\(Math\.max/);
    assert.doesNotMatch(preds[0].model_patch, /\.kurultay\//, 'agent state is not part of the patch');
    assert.equal(git(join(dir, 'acme__mathlib-1'), 'diff', '--cached', '--name-only'), '', 'the index is left as it was');
    const stats = readFileSync(join(dir, 'runs-kurultay-test.jsonl'), 'utf8');
    assert.match(stats, /"instance_id":"acme__mathlib-1".*"requests":[1-9]/);
    assert.match(progress[0], /✓ acme__mathlib-1 · completed/);
    const again = await runAll({ dir, name: 'kurultay-test', config: cfg, instances: ['acme__mathlib-1'] });
    assert.deepEqual([again.done, again.skipped], [0, 1], 'resumable');

    // another agent edits the second checkout, including a test file
    const w2 = join(dir, 'acme__mathlib-2');
    writeFileSync(join(w2, 'src', 'mathutil.js'), 'export const clamp = (v, a, b) => Math.min(Math.max(v, a), b);\n');
    mkdirSync(join(w2, 'tests'), { recursive: true });
    writeFileSync(join(w2, 'tests', 'test_new.py'), 'def test(): pass\n');
    mkdirSync(join(w2, '.qwen'), { recursive: true });
    writeFileSync(join(w2, '.qwen', 'state.json'), '{}');
    const got: string[] = [];
    const c = collect({ dir, name: 'qwen-code', onProgress: (l) => got.push(l) });
    assert.equal(c.predictions.length, 2);
    const p2 = c.predictions.find((p) => p.instance_id === 'acme__mathlib-2')!;
    assert.match(p2.model_patch, /src\/mathutil\.js/);
    assert.doesNotMatch(p2.model_patch, /tests\/test_new\.py|\.qwen/);
    assert.ok(got.some((l) => /test files left out: tests\/test_new\.py/.test(l)));
    assert.ok(existsSync(join(dir, 'predictions-qwen-code.jsonl')));
    assert.match(patchOf(w2, f.base, { keepTests: true }).patch, /tests\/test_new\.py/);
    assert.throws(() => collect({ dir: tmpProject({}), name: 'x' }), /tasks\.jsonl not found/);
  });
});
