import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { applyReplacement, normalizeUnicode } from '../../src/agent/edits.js';
import { LoopGuard, callKey, callSignature } from '../../src/agent/loop-guard.js';
import { loadProjectRules, selectRules } from '../../src/agent/rules.js';
import { bracketBalance, postEditCheck } from '../../src/agent/syntax.js';
import { executeTool, type ToolContext } from '../../src/agent/tools.js';
import { Materializer, Overlay } from '../../src/agent/workspace.js';
import { ProjectIndex } from '../../src/index/project-index.js';
import { classifyHttp, parseRetryAfter } from '../../src/llm/client.js';
import { parseTextRanking } from '../../src/orchestrator/council.js';
import { config, tmpProject } from '../helpers.js';

describe('LoopGuard', () => {
  it('signatures ignore key order but include the result', () => {
    assert.equal(callSignature('read_file', { a: 1, b: { y: 2, x: [1, { q: 1, p: 2 }] } }, 'r'), callSignature('read_file', { b: { x: [1, { p: 2, q: 1 }], y: 2 }, a: 1 }, 'r'));
    assert.notEqual(callSignature('read_file', { a: 1 }, 'r1'), callSignature('read_file', { a: 1 }, 'r2'));
    assert.equal(callKey('x', { a: null }), callKey('x', { a: null }));
  });

  it('warns at the third identical call+result and stops at the fifth', () => {
    const g = new LoopGuard();
    const v = [1, 2, 3, 4, 5].map(() => g.record('list_dir', { path: '.' }, 'same', false));
    assert.deepEqual(v.map((x) => x.action), ['ok', 'ok', 'warn', 'ok', 'stop']);
    assert.equal(v[2].action === 'warn' && v[2].kind, 'repeat');
    assert.equal(v[4].action === 'stop' && v[4].kind, 'repeat');
  });

  it('allows repeating a call whose result changed (Crush)', () => {
    const g = new LoopGuard();
    for (let i = 0; i < 8; i++) assert.equal(g.record('run_command', { command: 'make' }, `out ${i}`, false).action, 'ok');
  });

  it('detects A-B-A-B alternation: warn first, then stop', () => {
    const g = new LoopGuard({ softRepeat: 99, hardRepeat: 99 });
    const seq = () => [g.record('read_file', { path: 'a' }, String(Math.random()), false), g.record('read_file', { path: 'b' }, String(Math.random()), false)];
    const all = [...seq(), ...seq(), ...seq()];
    assert.equal(all[5].action, 'warn');
    assert.equal(all[5].action === 'warn' && all[5].kind, 'alternating');
    const more = [...seq(), ...seq(), ...seq()];
    assert.ok(more.some((x) => x.action === 'stop' && x.kind === 'alternating'));
  });

  it('counts consecutive errors: reminder halfway, stop at the limit, reset on success', () => {
    const g = new LoopGuard({ maxConsecutiveErrors: 4 });
    assert.equal(g.record('edit_file', { n: 1 }, 'e1', true).action, 'ok');
    const half = g.record('edit_file', { n: 2 }, 'e2', true);
    assert.equal(half.action === 'warn' && half.kind, 'errors');
    assert.equal(g.consecutiveErrors, 2);
    g.record('edit_file', { n: 3 }, 'e3', false);
    assert.equal(g.consecutiveErrors, 0);
    for (let i = 0; i < 3; i++) g.record('edit_file', { n: 10 + i }, 'e', true);
    const stop = g.record('edit_file', { n: 99 }, 'e', true);
    assert.equal(stop.action === 'stop' && stop.kind, 'errors');
  });

  it('nudges after the read-only exploration budget; writes reset it', () => {
    const g = new LoopGuard({ explorationBudget: 3 });
    const r = [0, 1, 2].map((i) => g.record('search_code', { q: i }, String(i), false));
    assert.equal(r[2].action === 'warn' && r[2].kind, 'exploration');
    g.record('edit_file', { p: 1 }, 'ok', false);
    assert.equal(g.record('read_file', { p: 9 }, 'x', false).action, 'ok');
  });

  it('keeps a bounded history', () => {
    const g = new LoopGuard({ window: 2 });
    for (let i = 0; i < 20; i++) g.record('write_file', { i }, 'ok', false);
    assert.equal(g.record('write_file', { i: 0 }, 'ok', false).action, 'ok');
  });
});

describe('post-edit syntax check', () => {
  it('measures bracket balance ignoring strings and comments', () => {
    assert.deepEqual(bracketBalance('int f() { return "}"; } // {', 'c'), { curly: 0, paren: 0, square: 0 });
    assert.deepEqual(bracketBalance('a[(1', 'javascript'), { curly: 0, paren: 1, square: 1 });
  });

  it('warns when an edit makes the balance worse, not when it was already off', () => {
    const before = 'int f() {\n  return 1;\n}\n';
    assert.equal(postEditCheck('src/a.c', before, 'int f() {\n  return 2;\n}\n'), '');
    assert.match(postEditCheck('src/a.c', before, 'int f() {\n  return (2;\n'), /\{ \} dengesi \+1, \( \) dengesi \+1/);
    assert.match(postEditCheck('src/a.ts', undefined, 'const a = [1, 2;'), /\[ \] dengesi \+1/);
    assert.equal(postEditCheck('src/a.c', 'int f() {', 'int g() {'), '', 'pre-existing imbalance is not blamed on the edit');
    assert.match(postEditCheck('src/a.c', '}', '}}'), /dengesi -2/);
  });

  it('validates JSON and skips unknown or bracket-free languages', () => {
    assert.match(postEditCheck('package.json', '{"a":1}', '{"a":1,}'), /geçerli JSON değil/);
    assert.equal(postEditCheck('package.json', '{"a":1}', '{"a":2}'), '');
    assert.equal(postEditCheck('broken.json', '{', '{{'), '', 'already invalid JSON is not reported');
    assert.equal(postEditCheck('new.json', undefined, '[1]'), '');
    assert.equal(postEditCheck('script.py', 'x = 1', 'x = (1'), '');
    assert.equal(postEditCheck('file.unknownext', '', '{{{'), '');
  });
});

describe('robust edits', () => {
  it('preserves CRLF line endings', () => {
    const out = applyReplacement('a\r\nb\r\nc\r\n', 'b\nc', 'B\nC');
    assert.equal(out, 'a\r\nB\r\nC\r\n');
    assert.equal(applyReplacement('x\r\ny\r\n', 'y\r\n', 'z\r\n'), 'x\r\nz\r\n');
    assert.equal(applyReplacement('x\ny\n', 'y\r\n', 'z\r\n'), 'x\nz\n');
  });

  it('matches through smart quotes, dashes and NBSP', () => {
    assert.equal(normalizeUnicode('“hi” — it’s ok…'), '"hi" - it\'s ok...');
    const file = 'const s = "a - b";\nlog(\'it\'s\');\n';
    const out = applyReplacement(file, 'const s = “a – b”;', 'const s = "a + b";');
    assert.equal(out, 'const s = "a + b";\nlog(\'it\'s\');\n');
  });
});

describe('Retry-After handling', () => {
  it('parses seconds and HTTP dates', () => {
    assert.equal(parseRetryAfter(null), undefined);
    assert.equal(parseRetryAfter('2'), 2000);
    assert.equal(parseRetryAfter(' 0.5 '), 500);
    const now = Date.parse('2026-01-01T00:00:00Z');
    assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now), 30_000);
    assert.equal(parseRetryAfter('Wed, 31 Dec 2025 00:00:00 GMT', now), 0);
    assert.equal(parseRetryAfter('soon'), undefined);
  });

  it('attaches the wait to rate-limit and overloaded errors', () => {
    const rl = classifyHttp(429, 'slow down', 'm', '3');
    assert.equal(rl.kind, 'rate_limit');
    assert.equal(rl.retryAfterMs, 3000);
    const busy = classifyHttp(503, 'busy', 'm', '1');
    assert.equal(busy.kind, 'server');
    assert.equal(busy.retryAfterMs, 1000);
    assert.equal(classifyHttp(503, 'busy', 'm').retryAfterMs, undefined);
  });
});

describe('council text ranking fallback', () => {
  it('parses FINAL RANKING sections and ignores invalid labels', () => {
    assert.deepEqual(parseTextRanking('analysis...\nFINAL RANKING:\n1. Candidate B\n2. Candidate A\n3. Candidate Z\n', 2), ['B', 'A']);
    assert.deepEqual(parseTextRanking('FINAL RANKING: candidate C is best, then candidate A', 3), ['C', 'A']);
    assert.deepEqual(parseTextRanking('1) A\n2) A\n3) B', 2), ['A', 'B']);
    assert.deepEqual(parseTextRanking('no ranking here', 3), []);
  });
});

describe('read-before-write guard and path resolution', () => {
  const files = { 'src/drivers/uart.c': 'int uart(void) {\n  return 0;\n}\n', 'src/app.c': 'int main(void){return 0;}\n', 'cfg.json': '{"a":1}\n' };
  function ctx(root: string, flag = true): ToolContext {
    const cfg = config({ endpoints: [{ name: 'e', baseUrl: 'http://127.0.0.1:1/v1' }], tools: { requireReadBeforeEdit: flag } });
    const index = new ProjectIndex(root, join(root, '.kurultay'));
    index.build();
    return { workerId: 'w', root, overlay: new Overlay('w', root), index, materializer: new Materializer(root, join(root, '.kurultay')), config: cfg, readFiles: new Set(), writtenFiles: new Set(), staleFiles: new Set() };
  }

  it('blocks blind overwrites and deletes of existing files until they are read', async () => {
    const root = tmpProject(files);
    const c = ctx(root);
    const blind = await executeTool('write_file', { path: 'src/app.c', content: 'x' }, c);
    assert.equal(blind.isError, true);
    assert.match(blind.output, /read_file ile okumalısınız/);
    assert.equal((await executeTool('delete_file', { path: 'src/app.c' }, c)).isError, true);
    assert.equal((await executeTool('write_file', { path: 'src/new.c', content: 'int n;' }, c)).isError, undefined, 'new files are fine');
    assert.equal((await executeTool('write_file', { path: 'src/new.c', content: 'int m;' }, c)).isError, undefined, 'own files are fine');
    await executeTool('read_file', { path: 'src/app.c' }, c);
    assert.match((await executeTool('write_file', { path: 'src/app.c', content: 'int main(void){return 1;}\n' }, c)).output, /Güncellendi/);
    const off = ctx(tmpProject(files), false);
    assert.equal((await executeTool('write_file', { path: 'src/app.c', content: 'x' }, off)).isError, undefined, 'guard can be disabled');
  });

  it('lets exact edits through but requires a re-read after a failed match', async () => {
    const root = tmpProject(files);
    const c = ctx(root);
    assert.match((await executeTool('edit_file', { path: 'src/app.c', old_text: 'return 0;', new_text: 'return 2;' }, c)).output, /Düzenlendi/);
    const miss = await executeTool('edit_file', { path: 'src/drivers/uart.c', old_text: 'return 42;', new_text: 'return 1;' }, c);
    assert.equal(miss.isError, true);
    assert.match(miss.output, /yeniden okuyun/);
    const stale = await executeTool('edit_file', { path: 'src/drivers/uart.c', old_text: 'return 0;', new_text: 'return 1;' }, c);
    assert.equal(stale.isError, true);
    assert.match(stale.output, /son düzenleme eşleşmedi/);
    await executeTool('read_file', { path: 'src/drivers/uart.c' }, c);
    assert.match((await executeTool('edit_file', { path: 'src/drivers/uart.c', old_text: 'return 0;', new_text: 'return 1;' }, c)).output, /Düzenlendi/);
    const same = await executeTool('edit_file', { path: 'src/app.c', old_text: 'x', new_text: 'x' }, c);
    assert.match(same.output, /aynı/);
  });

  it('appends syntax warnings and resolves unique basenames', async () => {
    const root = tmpProject(files);
    const c = ctx(root);
    const r = await executeTool('read_file', { path: 'uart.c' }, c);
    assert.match(r.output, /src\/drivers\/uart\.c/);
    const broken = await executeTool('edit_file', { path: 'uart.c', old_text: '  return 0;\n}', new_text: '  return 0;' }, c);
    assert.match(broken.output, /src\/drivers\/uart\.c/);
    assert.match(broken.output, /parantez dengesi bozuldu/);
    await executeTool('read_file', { path: 'cfg.json' }, c);
    assert.match((await executeTool('write_file', { path: 'cfg.json', content: '{"a":' }, c)).output, /geçerli JSON değil/);
    const missing = await executeTool('read_file', { path: 'src/uart.h' }, c);
    assert.equal(missing.isError, true);
    assert.match(missing.output, /Benzer dosyalar: src\/drivers\/uart\.c/);
  });
});

describe('directory-scoped rules', () => {
  it('scopes nested AGENTS.md / CLAUDE.md to their folder and parses list globs', () => {
    const root = tmpProject({
      'AGENTS.md': 'ROOT-RULE',
      'src/drivers/AGENTS.md': 'DRIVER-RULE',
      'lib/CLAUDE.md': 'LIB-RULE',
      'node_modules/x/AGENTS.md': 'IGNORED',
      'src/empty/AGENTS.md': '',
      '.kurultay/rules/multi.md': '---\nglobs: ["*.c", "*.h"]\ndescription: C kuralları\n---\nMULTI',
    });
    const { rules } = loadProjectRules(root, join(root, '.kurultay'), ['AGENTS.md', 'src/drivers/AGENTS.md', 'lib/CLAUDE.md', 'node_modules/x/AGENTS.md', 'src/empty/AGENTS.md']);
    const names = rules.map((r) => r.name);
    assert.ok(names.includes('src/drivers/AGENTS.md'));
    assert.ok(names.includes('lib/CLAUDE.md'));
    assert.ok(!rules.some((r) => r.body === 'IGNORED'));
    assert.equal(rules.filter((r) => r.body === 'ROOT-RULE').length, 1, 'root file not duplicated');
    const multi = rules.find((r) => r.name === 'multi')!;
    assert.deepEqual(multi.appliesTo, ['*.c', '*.h']);
    assert.equal(multi.description, 'C kuralları');
    const forDriver = selectRules(rules, ['src/drivers/uart.c']).map((r) => r.body);
    assert.ok(forDriver.includes('DRIVER-RULE'));
    assert.ok(!forDriver.includes('LIB-RULE'));
    assert.ok(!selectRules(rules, ['src/app.py']).some((r) => r.body === 'DRIVER-RULE' || r.body === 'MULTI'));
  });
});
