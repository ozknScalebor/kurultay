import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { applyReplacement, parseSearchReplace, EditError } from '../../src/agent/edits.js';
import { unifiedDiff, diffStat } from '../../src/agent/diff.js';
import { merge3 } from '../../src/agent/merge3.js';
import { parseTextToolCalls } from '../../src/agent/text-tools.js';
import { Overlay, Materializer } from '../../src/agent/workspace.js';
import { selectRules, loadProjectRules } from '../../src/agent/rules.js';
import { readStream, classifyHttp } from '../../src/llm/client.js';
import { computeRoleScores } from '../../src/llm/models.js';
import { parseConfig, ConfigError } from '../../src/config.js';
import { extractSymbols } from '../../src/index/symbols.js';
import { pageRank, buildGraph, type GraphFile } from '../../src/index/graph.js';
import { Bm25Index, tokenize } from '../../src/index/bm25.js';
import { globToRegExp } from '../../src/index/scanner.js';
import { ProjectIndex } from '../../src/index/project-index.js';
import { evaluateCodingAnswer, CODING_TASKS, EDIT_TASKS, evaluateEditAnswer } from '../../src/probe/bench.js';
import { topoOrder } from '../../src/orchestrator/planner.js';
import { extractJson, stripThinking } from '../../src/util/text.js';
import { Semaphore, mapLimit } from '../../src/util/async.js';

describe('edits', () => {
  it('applies exact replacement', () => {
    assert.equal(applyReplacement('a\nb\nc', 'b', 'B'), 'a\nB\nc');
  });
  it('tolerates indentation differences and re-indents', () => {
    const file = 'class A {\n    void f() {\n        x = 1;\n    }\n}';
    const out = applyReplacement(file, 'void f() {\n    x = 1;\n}', 'void f() {\n    x = 2;\n}');
    assert.equal(out, 'class A {\n    void f() {\n        x = 2;\n    }\n}');
  });
  it('rejects ambiguous matches and gives a hint for misses', () => {
    assert.throws(() => applyReplacement('x\nx', 'x', 'y'), EditError);
    assert.throws(() => applyReplacement('int read_raw(int ch);', 'int read_raw(int channel);', ''), /En yakın eşleşme/);
  });
  it('parses SEARCH/REPLACE blocks with file paths', () => {
    const b = parseSearchReplace('src/a.c\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n');
    assert.deepEqual(b, [{ path: 'src/a.c', search: 'old', replace: 'new' }]);
  });
});

describe('diff and merge', () => {
  it('produces a unified diff', () => {
    const d = unifiedDiff('f.txt', 'a\nb\nc\n', 'a\nB\nc\n');
    assert.match(d, /^--- a\/f\.txt\n\+\+\+ b\/f\.txt\n@@/);
    assert.deepEqual(diffStat(d), { added: 1, removed: 1 });
  });
  it('merges non-overlapping edits cleanly', () => {
    const base = 'l1\nl2\nl3\nl4\nl5';
    const r = merge3(base, 'L1\nl2\nl3\nl4\nl5', 'l1\nl2\nl3\nl4\nL5');
    assert.equal(r.ok, true);
    assert.equal(r.content, 'L1\nl2\nl3\nl4\nL5');
  });
  it('marks conflicts', () => {
    const r = merge3('a\nb\nc', 'a\nX\nc', 'a\nY\nc');
    assert.equal(r.ok, false);
    assert.match(r.content, /<<<<<<<[\s\S]*X[\s\S]*=======[\s\S]*Y[\s\S]*>>>>>>>/);
  });
});

describe('text tool calls', () => {
  it('parses hermes style', () => {
    const c = parseTextToolCalls('ok <tool_call>{"name":"read_file","arguments":{"path":"a.c"}}</tool_call>');
    assert.deepEqual(c, [{ name: 'read_file', arguments: { path: 'a.c' } }]);
  });
  it('parses qwen3-coder xml style', () => {
    const c = parseTextToolCalls('<tool_call>\n<function=edit_file>\n<parameter=path>\nsrc/x.py\n</parameter>\n<parameter=replace_all>\ntrue\n</parameter>\n</function>\n</tool_call>');
    assert.deepEqual(c, [{ name: 'edit_file', arguments: { path: 'src/x.py', replace_all: true } }]);
  });
  it('parses fenced json and search/replace', () => {
    const c = parseTextToolCalls('```json\n{"name":"grep","arguments":{"pattern":"foo"}}\n```\nsrc/a.c\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE');
    assert.equal(c[0].name, 'grep');
    assert.deepEqual(c[1], { name: 'edit_file', arguments: { path: 'src/a.c', old_text: 'x', new_text: 'y' } });
  });
});

describe('overlay workspace', () => {
  it('isolates writes, absorbs children, materializes temporarily', async () => {
    const root = mkdtempSync(join(tmpdir(), 'k-ov-'));
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree');
    const parent = new Overlay('p', root);
    const child = parent.fork('c');
    child.write('a.txt', 'one\nTWO\nthree');
    child.write('new.txt', 'hi');
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'one\ntwo\nthree');
    assert.deepEqual(child.ownChanges(), ['a.txt', 'new.txt']);
    // a sibling edits another line of the same file and is absorbed first
    const sib = parent.fork('s');
    sib.write('a.txt', 'ONE\ntwo\nthree');
    parent.absorb(sib);
    const res = parent.absorb(child);
    assert.deepEqual(res.conflicts, []);
    assert.equal(parent.read('a.txt'), 'ONE\nTWO\nthree');
    const m = new Materializer(root, join(root, '.kurultay'));
    const seen = await m.withApplied(parent, async () => {
      // readers through overlays must still see pristine content while applied
      const other = new Overlay('o', root);
      return { disk: readFileSync(join(root, 'a.txt'), 'utf8'), pristine: other.read('a.txt'), listed: other.list('').map((e) => e.name) };
    });
    assert.equal(seen.disk, 'ONE\nTWO\nthree');
    assert.equal(seen.pristine, 'one\ntwo\nthree');
    assert.ok(!seen.listed.includes('new.txt'));
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'one\ntwo\nthree');
    const rep = await m.merge(parent);
    assert.deepEqual(rep.written.sort(), ['a.txt', 'new.txt']);
    assert.equal(readFileSync(join(root, 'new.txt'), 'utf8'), 'hi');
  });
  it('3-way merges when the file changed on disk meanwhile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'k-ov2-'));
    writeFileSync(join(root, 'f.c'), 'a\nb\nc\nd');
    const o = new Overlay('w', root);
    o.write('f.c', 'A\nb\nc\nd');
    writeFileSync(join(root, 'f.c'), 'a\nb\nc\nD'); // user edited meanwhile
    const rep = await new Materializer(root, join(root, '.k')).merge(o);
    assert.deepEqual(rep.merged3way, ['f.c']);
    assert.equal(readFileSync(join(root, 'f.c'), 'utf8'), 'A\nb\nc\nD');
  });
});

describe('llm client', () => {
  it('parses SSE content, reasoning, tool call deltas and usage', async () => {
    const chunks = [
      { choices: [{ delta: { reasoning_content: 'hmm' } }] },
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_', arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"x"}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];
    const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        const enc = new TextEncoder().encode(text);
        for (let i = 0; i < enc.length; i += 7) ctrl.enqueue(enc.slice(i, i + 7)); // split mid-line
        ctrl.close();
      },
    });
    const r = await readStream(stream, Date.now(), 'm@e');
    assert.equal(r.content, 'Hello');
    assert.equal(r.thinking, 'hmm');
    assert.equal(r.toolCalls[0].function.name, 'read_file');
    assert.equal(r.toolCalls[0].function.arguments, '{"path":"x"}');
    assert.equal(r.usage.completionTokens, 5);
    assert.equal(r.finishReason, 'tool_calls');
  });
  it('classifies context-length errors', () => {
    assert.equal(classifyHttp(400, "This model's maximum context length is 8192 tokens", 'm').kind, 'context_length');
    assert.equal(classifyHttp(503, 'loading', 'm').kind, 'server');
    assert.equal(classifyHttp(401, 'no', 'm').kind, 'auth');
  });
});

describe('symbols, graph, search', () => {
  it('extracts C/C++/Java/Python/Go/TS definitions', () => {
    const c = extractSymbols('#include "x.h"\nstatic int foo(int a) {\n  return bar(a);\n}\n', 'c');
    assert.deepEqual(c.defs.map((d) => d.name), ['foo']);
    assert.deepEqual(c.imports, ['x.h']);
    const cpp = extractSymbols('class Q {\npublic:\n  int size() const { return n; }\n};\nbool Q::pop(int &o) {\n  return true;\n}\n', 'cpp');
    assert.deepEqual(cpp.defs.map((d) => `${d.kind}:${d.name}`), ['class:Q', 'method:size', 'method:pop']);
    const java = extractSymbols('public class A {\n  public static <T> List<T> f(T x) {\n    return null;\n  }\n}', 'java');
    assert.deepEqual(java.defs.map((d) => d.name), ['A', 'f']);
    const go = extractSymbols('package x\nfunc (s *Server) Start() error {\n}\ntype Server struct {}\n', 'go');
    assert.deepEqual(go.defs.map((d) => `${d.kind}:${d.name}`), ['method:Start', 'struct:Server']);
    const ts = extractSymbols('export class S {\n  async run(x: number): Promise<void> {\n  }\n}\nexport const f = (a: string) => a;\n', 'typescript');
    assert.deepEqual(ts.defs.map((d) => d.name), ['S', 'run', 'f']);
  });
  it('ranks central files higher with PageRank', () => {
    const files: GraphFile[] = [
      { path: 'core.c', lang: 'c', defs: [{ name: 'core_init', kind: 'function' as const, line: 1, signature: '' }], refs: {}, imports: [] },
      { path: 'a.c', lang: 'c', defs: [], refs: { core_init: 2 }, imports: [] },
      { path: 'b.c', lang: 'c', defs: [], refs: { core_init: 1 }, imports: [] },
    ];
    const { edges } = buildGraph(files);
    const r = pageRank(files.map((f) => f.path), edges);
    assert.ok(r.get('core.c')! > r.get('a.c')!);
  });
  it('bm25 finds identifiers split by camelCase/snake_case', () => {
    assert.ok(tokenize('sensorReadRaw').includes('read'));
    const idx = new Bm25Index();
    idx.add({ path: 'a.c', startLine: 1, endLine: 2, text: 'int sensor_read_raw(void);' });
    idx.add({ path: 'b.c', startLine: 1, endLine: 2, text: 'void uart_send(char c);' });
    assert.equal(idx.search('read sensor')[0].path, 'a.c');
  });
  it('globs', () => {
    assert.ok(globToRegExp('*.java').test('src/a/B.java'));
    assert.ok(globToRegExp('build/').test('build/x.o'));
    assert.ok(!globToRegExp('src/*.c').test('src/a/b.c'));
    assert.ok(globToRegExp('src/**/*.c').test('src/a/b.c'));
  });
  it('builds a project index incrementally', () => {
    const root = mkdtempSync(join(tmpdir(), 'k-idx-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'util.c'), 'int util_add(int a, int b) {\n  return a + b;\n}\n');
    writeFileSync(join(root, 'src', 'main.c'), '#include "util.h"\nint main(void) {\n  return util_add(1, 2);\n}\n');
    const idx = new ProjectIndex(root, join(root, '.kurultay'));
    const s1 = idx.build();
    assert.equal(s1.total, 2);
    assert.ok(idx.dependents('src/util.c').some((d) => d.path === 'src/main.c'));
    assert.match(idx.repoMap(500), /util_add/);
    const s2 = idx.build();
    assert.equal(s2.added + s2.changed, 0);
  });
});

describe('probe benchmark', () => {
  it('scores correct and wrong answers', () => {
    const roman = CODING_TASKS.find((t) => t.id === 'roman')!;
    assert.equal(evaluateCodingAnswer(roman, '```js\nfunction toRoman(n){return "I"}\n```') < 0.5, true);
    const crc = CODING_TASKS.find((t) => t.id === 'crc')!;
    const good = 'function crc8(b){let c=0;for(const x of b){c^=x;for(let i=0;i<8;i++)c=c&0x80?((c<<1)^7)&255:(c<<1)&255}return c}';
    assert.equal(evaluateCodingAnswer(crc, good), 1);
    assert.equal(evaluateCodingAnswer(crc, 'while(true){}'), 0);
    const ed = EDIT_TASKS[1];
    assert.equal(evaluateEditAnswer(ed, `${ed.path}\n<<<<<<< SEARCH\nbool Queue::pop(Item &out) {\n=======\nbool Queue::pop(Item &out) {\n    if (count_ == 0) return false;\n>>>>>>> REPLACE`), 1);
  });
  it('computes role scores in range', () => {
    const r = computeRoleScores({ contextWindow: 131072, nativeTools: true, tokensPerSec: 50, codingScore: 0.8, editScore: 0.7, instructionScore: 0.9, thinking: false }, 100);
    for (const v of Object.values(r)) assert.ok(v >= 0 && v <= 1);
  });
});

describe('config, rules, planner, utils', () => {
  it('interpolates env vars and validates', () => {
    process.env.K_TEST_KEY = 'secret';
    const c = parseConfig({ endpoints: [{ name: 'a', baseUrl: 'http://x:1/v1/', apiKey: '${K_TEST_KEY}' }] });
    assert.equal(c.endpoints[0].apiKey, 'secret');
    assert.equal(c.endpoints[0].baseUrl, 'http://x:1/v1');
    assert.equal(c.orchestrator.raceWidth, 3);
    assert.throws(() => parseConfig({ endpoints: [] }), ConfigError);
  });
  it('loads rules from several agent conventions and filters by glob', () => {
    const root = mkdtempSync(join(tmpdir(), 'k-rules-'));
    mkdirSync(join(root, '.kurultay', 'rules'), { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), '# Agents\nAlways write tests.');
    writeFileSync(join(root, '.kurultay', 'rules', 'java.md'), '---\napplies_to: "*.java"\n---\nUse final.');
    writeFileSync(join(root, 'review_rules.md'), 'No leaks.');
    const r = loadProjectRules(root, join(root, '.kurultay'));
    assert.equal(r.rules.length, 2);
    assert.equal(r.review.length, 1);
    assert.equal(selectRules(r.rules, ['src/a.c']).length, 1);
    assert.equal(selectRules(r.rules, ['src/A.java']).length, 2);
  });
  it('topologically orders subtasks and detects cycles', () => {
    const t = (id: string, deps: string[]) => ({ id, title: id, description: '', files: [], dependsOn: deps, critical: false });
    assert.deepEqual(topoOrder([t('B', ['A']), t('A', [])])!.map((x) => x.id), ['A', 'B']);
    assert.equal(topoOrder([t('A', ['B']), t('B', ['A'])]), undefined);
  });
  it('extracts JSON from messy LLM output', () => {
    assert.deepEqual(extractJson('<think>x</think>Sure:\n```json\n{"a": [1,2,],}\n```'), { a: [1, 2] });
    assert.deepEqual(extractJson('prefix {"k": "v {not} end"} suffix'), { k: 'v {not} end' });
    assert.equal(stripThinking('<think>abc</think>done').content, 'done');
  });
  it('semaphore bounds concurrency', async () => {
    const s = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await mapLimit([1, 2, 3, 4, 5, 6], 6, () =>
      s.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      }),
    );
    assert.equal(peak, 2);
  });
});
