import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Materializer, Overlay } from '../../src/agent/workspace.js';
import { startMockServer, type MockServerHandle } from '../../src/mock/server.js';
import { councilAnswer, councilReview, type Candidate } from '../../src/orchestrator/council.js';
import { focusTerms, renderReport } from '../../src/orchestrator/orchestrator.js';
import { makePlan } from '../../src/orchestrator/planner.js';
import { detectVerifyCommands, renderVerify, verifyFailureText, verifyOverlay } from '../../src/orchestrator/verify.js';
import { caps, config, lastUser, recordingBus, routerFor, tmpProject } from '../helpers.js';

const servers: MockServerHandle[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

async function routerWith(models: Parameters<typeof startMockServer>[0]) {
  const s = await startMockServer(models);
  servers.push(s);
  const cfg = config({ endpoints: [{ name: 'e', baseUrl: s.url }] });
  const bus = recordingBus();
  return { s, router: routerFor(cfg, models.map((m) => caps(m.id, 'e')), bus), bus, cfg };
}

const cand = (id: string, author: string, diff: string, verify?: number): Candidate => ({ id, author, diff, summary: `by ${author}`, verifyScore: verify, verifyOk: verify === undefined ? undefined : verify === 1 });

describe('council review', () => {
  it('anonymises candidates: reviewers never see worker ids or model names', async () => {
    const prompts: string[] = [];
    const { router } = await routerWith([
      { id: 'rev', quality: 'good', tools: true, ctx: 65536, handler: (q) => { prompts.push(lastUser(q.messages)); return { content: '{"ranking":["A","B"],"scores":{"A":8,"B":4},"issues":{}}' }; } },
    ]);
    await councilReview(router, { task: 't', acceptance: ['a1'], candidates: [cand('T1-1', 'secret-model@gpu9', '+x'), cand('T1-2', 'other-model@gpu8', '+y')], reviewers: 1, contextTokens: 8000 });
    assert.equal(prompts.length, 1);
    assert.ok(!/T1-1|T1-2|secret-model|other-model|gpu9|gpu8/.test(prompts[0]), 'no ids/models leak, not even through author notes');
    assert.match(prompts[0], /Author's note: by \[model\]/);
    assert.match(prompts[0], /<candidate id="A">/);
    assert.match(prompts[0], /ACCEPTANCE CRITERIA\n- a1/);
  });

  it('objective test evidence outweighs reviewer preference; blocking issues and empty diffs are penalised', async () => {
    // reviewer prefers whichever label holds the failing candidate
    const { router } = await routerWith([
      {
        id: 'biased', quality: 'good', tools: true, ctx: 65536,
        handler: (q) => {
          const p = lastUser(q.messages);
          const ids = [...p.matchAll(/<candidate id="([A-J])">\nBuild\/tests: (\w+)/g)].map((m) => ({ id: m[1], passed: m[2] === 'PASSED' }));
          const failing = ids.filter((x) => !x.passed).map((x) => x.id);
          const passing = ids.filter((x) => x.passed).map((x) => x.id);
          return { content: JSON.stringify({ ranking: [...failing, ...passing], scores: Object.fromEntries(ids.map((x) => [x.id, x.passed ? 5 : 9])), issues: Object.fromEntries(passing.map((id) => [id, [{ text: 'style nit', blocking: false }]])) }) };
        },
      },
    ]);
    const v = await councilReview(router, { task: 't', acceptance: [], candidates: [cand('good', 'm1', '+ok', 1), cand('bad', 'm2', '+broken', 0), cand('empty', 'm3', '', undefined)], reviewers: 1, contextTokens: 8000 });
    assert.equal(v.winner!.id, 'good');
    assert.equal(v.ranking[v.ranking.length - 1].id, 'empty');
    assert.deepEqual(v.winnerIssues.map((i) => i.text), ['style nit']);
    assert.equal(v.reviews.length, 1);
  });

  it('survives failing or garbage-producing reviewers and works with zero valid reviews', async () => {
    const { router, bus } = await routerWith([
      { id: 'broken', quality: 'good', tools: true, ctx: 65536, handler: () => ({ status: 400, error: 'nope' }) },
      { id: 'garbage', quality: 'good', tools: true, ctx: 65536, handler: () => ({ content: 'I like them all!' }) },
    ]);
    const v = await councilReview(router, { task: 't', acceptance: [], candidates: [cand('x', 'a', '+1', 0.5), cand('y', 'b', '+2', 1)], reviewers: 2, contextTokens: 8000, bus });
    assert.equal(v.reviews.length, 0);
    assert.equal(v.winner!.id, 'y', 'verification decides when no review is usable');
    const empty = await councilReview(router, { task: 't', acceptance: [], candidates: [], reviewers: 2, contextTokens: 8000 });
    assert.equal(empty.winner, undefined);
  });

  it('councilAnswer: members answer independently, the chair synthesises', async () => {
    const { router } = await routerWith([
      { id: 'm1', quality: 'good', tools: true, ctx: 65536 },
      { id: 'm2', quality: 'good', tools: true, ctx: 65536 },
    ]);
    const r = await councilAnswer(router, 'Where is clamp?', 'context', { members: 2, contextTokens: 4000, language: 'Turkish' });
    assert.equal(r.members.length, 2);
    assert.match(r.answer, /Nihai cevap/);
    assert.ok(r.chair);
    const single = await councilAnswer(router, 'q', 'c', { members: 1, contextTokens: 4000, language: 'English' });
    assert.equal(single.chair, undefined);
  });
});

describe('planner', () => {
  it('merges several drafts through a judge and normalises the result', async () => {
    let judged = '';
    const { router } = await routerWith([
      {
        id: 'p', quality: 'good', tools: true, ctx: 65536,
        handler: (q) => {
          const u = lastUser(q.messages);
          if (/Several planners proposed/.test(u)) {
            judged = u;
            return { content: JSON.stringify({ understanding: 'merged', acceptance_criteria: ['ok'], subtasks: [{ id: 'A', title: 'a', description: 'do a', files: ['a.c'], depends_on: ['B', 'A', 'ghost'] }, { id: 'B', title: 'b', description: 'do b' }] }) };
          }
          return { content: JSON.stringify({ understanding: 'draft', subtasks: [{ title: 'only' }] }) };
        },
      },
      { id: 'q', quality: 'good', tools: true, ctx: 65536, handler: () => ({ content: '```json\n{"understanding":"q","subtasks":[{"id":"Z","title":"z"}]}\n```' }) },
    ]);
    const plan = await makePlan(router, 'task', 'ctx', { drafts: 2, contextTokens: 4000 });
    assert.match(judged, /<plan id="A">[\s\S]*<plan id="B">/);
    assert.equal(plan.understanding, 'merged');
    assert.deepEqual(plan.subtasks.map((s) => [s.id, s.dependsOn]), [['A', ['B']], ['B', []]], 'self and unknown deps removed');
    assert.equal(plan.authors.length, 3);
  });

  it('falls back to a single subtask when no model produces a valid plan; breaks cycles; caps at 8', async () => {
    const { router, bus } = await routerWith([{ id: 'x', quality: 'good', tools: true, ctx: 65536, handler: () => ({ content: 'no plan, sorry' }) }]);
    const fb = await makePlan(router, 'the task', 'ctx', { drafts: 1, contextTokens: 4000, bus });
    assert.deepEqual(fb.subtasks.map((s) => s.description), ['the task']);
    assert.ok(bus.ofType('log.warn').some((e) => /geçerli plan/.test(e.message ?? '')));
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `T${i}`, title: `t${i}`, depends_on: i === 0 ? ['T1'] : i === 1 ? ['T0'] : [] }));
    const { router: r2 } = await routerWith([{ id: 'y', quality: 'good', tools: true, ctx: 65536, handler: () => ({ content: JSON.stringify({ subtasks: many }) }) }]);
    const capped = await makePlan(r2, 't', 'c', { drafts: 1, contextTokens: 4000 });
    assert.equal(capped.subtasks.length, 8);
    assert.ok(capped.subtasks.every((s) => s.dependsOn.length === 0), 'cycle T0<->T1 broken');
  });
});

describe('verification', () => {
  it('scores build/test/lint, stops after a failing build, and skips when unconfigured', async () => {
    const root = tmpProject({ 'ok.txt': 'x' });
    const m = new Materializer(root, join(root, '.k'));
    const o = new Overlay('o', root);
    const base = { endpoints: [{ name: 'e', baseUrl: 'http://127.0.0.1:1/v1' }] };
    const pass = await verifyOverlay(o, m, config({ ...base, verify: { build: 'node -e "0"', test: 'node -e "0"', lint: 'node -e "process.exit(1)"' } }));
    assert.equal(pass.ok, false);
    assert.equal(pass.score, 0.9);
    const brokenBuild = await verifyOverlay(o, m, config({ ...base, verify: { build: 'node -e "process.exit(2)"', test: 'node -e "0"' } }));
    assert.equal(brokenBuild.steps.length, 1, 'tests are not run on a broken build');
    assert.equal(brokenBuild.score, 0);
    assert.match(verifyFailureText(brokenBuild), /exit 2/);
    assert.match(renderVerify(brokenBuild), /build: ❌/);
    const skipped = await verifyOverlay(o, m, config(base));
    assert.deepEqual([skipped.skipped, skipped.ok], [true, true]);
    assert.match(renderVerify(skipped), /tanımlı değil/);
    // the overlay content is what the commands see
    o.write('ok.txt', 'from-overlay');
    const sees = await verifyOverlay(o, m, config({ ...base, verify: { test: `node -e "process.exit(require('fs').readFileSync('ok.txt','utf8')==='from-overlay'?0:1)"` } }));
    assert.equal(sees.ok, true);
  });

  it('detects build systems for kurultay init', () => {
    const cases: Array<[Record<string, string>, RegExp, RegExp | null]> = [
      [{ 'CMakeLists.txt': '' }, /cmake --build/, /ctest/],
      [{ 'meson.build': '' }, /meson compile/, /meson test/],
      [{ 'pom.xml': '' }, /mvn -o -q compile/, /mvn -o -q test/],
      [{ gradlew: '', 'build.gradle': '' }, /gradlew --offline/, /test/],
      [{ 'build.gradle.kts': '' }, /gradle --offline/, /test/],
      [{ 'Cargo.toml': '' }, /cargo build --offline/, /cargo test/],
      [{ 'go.mod': '' }, /go build/, /go test/],
      [{ 'package.json': '{"scripts":{"build":"tsc","test":"node --test","lint":"eslint ."}}' }, /npm run build/, /npm test/],
      [{ 'pyproject.toml': '' }, /^$/, /pytest/],
      [{ Makefile: 'all:\n\ntest:\n\techo\n' }, /make -j/, /make test/],
      [{ 'README.md': '' }, /^$/, null],
    ];
    for (const [files, build, test] of cases) {
      const v = detectVerifyCommands(tmpProject(files));
      assert.match(v.build ?? '', build, JSON.stringify(files));
      if (test) assert.match(v.test ?? '', test, JSON.stringify(files));
      else assert.equal(v.test, '');
    }
    assert.equal(detectVerifyCommands(tmpProject({ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\""}}' })).test, '');
  });
});

describe('orchestrator helpers', () => {
  it('extracts focus identifiers and file paths from task text', () => {
    const f = focusTerms('Fix uart_init in src/drv/uart.c and update UartDriver::open plus CMakeLists.txt; see docs');
    assert.ok(f.files.includes('src/drv/uart.c'));
    assert.ok(f.files.includes('CMakeLists.txt'));
    assert.ok(f.identifiers.includes('uart_init'));
    assert.ok(f.identifiers.includes('UartDriver'));
    assert.ok(!f.identifiers.includes('docs'));
  });

  it('renders a readable report', () => {
    const md = renderReport(
      {
        sessionId: 's', sessionDir: '/x', task: 'T', mode: 'race', iterations: 2, status: 'incomplete', modelsUsed: ['a@e'], changedFiles: ['f.c'], diffPath: '/x/changes.diff', reportPath: '/x/REPORT.md',
        plan: { understanding: 'u', acceptance: ['c1'], subtasks: [], authors: ['a@e'] },
        subtasks: [{ subtask: { id: 'T1', title: 'one', description: '', files: [], dependsOn: [], critical: true }, iteration: 1, candidates: [{ worker: 'T1-1', models: ['a@e'], status: 'done', files: 1, verify: 'geçti', summary: '' }], winner: { worker: 'T1-1', models: ['a@e'] }, verdict: { ranking: [{ id: 'T1-1', author: 'a@e', points: 9 }], winnerIssues: [{ reviewer: 'b@e', text: 'leak', blocking: true }] }, fixes: 1, status: 'done' }],
        requirementCheck: { complete: false, missing: ['add docs'], judges: ['b@e'] },
        merge: { written: ['f.c'], deleted: [], merged3way: [], conflicts: ['g.c'] },
      },
      '--- a/f.c\n+++ b/f.c\n@@ -1 +1 @@\n-a\n+b\n',
    );
    for (const want of ['**Durum:** incomplete', '(+1 / -1)', '🏆', '**[engelleyici]** leak', 'Düzeltme turu: 1', '- add docs', 'çakışma: 1', '- g.c', '- c1']) assert.ok(md.includes(want), want);
  });
});
