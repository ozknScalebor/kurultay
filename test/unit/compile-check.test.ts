import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { findCompileCommands, hasTool, javaSourceRoot, relevantErrors, renderSyntaxResult, splitCommand, syntaxCheck, syntaxOnlyArgs } from '../../src/agent/compile-check.js';
import { executeTool, type ToolContext } from '../../src/agent/tools.js';
import { Materializer, Overlay } from '../../src/agent/workspace.js';
import { ProjectIndex } from '../../src/index/project-index.js';
import { testingGuidance } from '../../src/orchestrator/orchestrator.js';
import { config, tmpProject } from '../helpers.js';

const gcc = hasTool('gcc') || hasTool('cc') || hasTool('clang');
const gxx = hasTool('g++') || hasTool('c++') || hasTool('clang++');
const javac = hasTool('javac');

function setup(files: Record<string, string>, syntaxCheckCfg: unknown = 'auto') {
  const root = tmpProject(files);
  const cfg = config({ endpoints: [{ name: 'e', baseUrl: 'http://127.0.0.1:1/v1' }], tools: { syntaxCheck: syntaxCheckCfg } });
  const index = new ProjectIndex(root, join(root, '.kurultay'));
  index.build();
  const m = new Materializer(root, join(root, '.kurultay'));
  const ctx: ToolContext = { workerId: 'w', root, overlay: new Overlay('w', root), index, materializer: m, config: cfg, readFiles: new Set(), writtenFiles: new Set(), staleFiles: new Set() };
  return { root, ctx, m };
}

describe('test-first guidance', () => {
  it('asks for reproduction on bugs and for tests with the configured command', () => {
    const bug = testingGuidance('Fix the crash when the buffer is empty', 'ctest --test-dir build');
    assert.match(bug, /FIRST reproduce it with a failing test/);
    assert.match(bug, /`ctest --test-dir build`/);
    assert.match(bug, /Do not delete or weaken existing tests/);
    const feature = testingGuidance('Add CSV export', '');
    assert.doesNotMatch(feature, /reproduce/);
    assert.match(feature, /no configured test command: write a small self-check/);
    assert.match(testingGuidance('sıralama hatasını düzelt', 'x'), /FIRST reproduce/);
  });
});

describe('compiler check after edits', () => {
  it('parses compile commands and builds syntax-only invocations', () => {
    assert.deepEqual(splitCommand(`gcc -I"a b" -DX='1 2' -c src/x.c -o x.o \\-y ""`, false), ['gcc', '-Ia b', '-DX=1 2', '-c', 'src/x.c', '-o', 'x.o', '-y', '']);
    assert.deepEqual(splitCommand(`cl.exe -IC:\\p\\inc "-DX=\\"q\\"" C:\\p\\a.c`, true), ['cl.exe', '-IC:\\p\\inc', '-DX="q"', 'C:\\p\\a.c']);
    const r = syntaxOnlyArgs({ directory: '/p/build', file: '../src/x.c', command: 'cc -I/p/include -MD -MF x.d -c ../src/x.c -o x.o' }, '/p', '/sb', '/sb/src/x.c');
    assert.equal(r.cmd, 'cc');
    assert.deepEqual(r.args, ['-I/sb/include', '-fsyntax-only', '/sb/src/x.c']);
    assert.equal(r.cwd, '/sb/build');
    const w = syntaxOnlyArgs({ directory: 'C:\\p\\build', file: 'C:\\p\\x.c', arguments: ['cc', '-IC:\\p\\inc', '--sysroot=C:\\p\\sys', '-c', 'C:\\p\\x.c'] }, 'C:\\p', 'D:\\sb', 'D:\\sb\\x.c');
    assert.deepEqual(w.args.slice(0, 2), ['-ID:\\sb\\inc', '--sysroot=D:\\sb\\sys'], 'Windows drive paths glued to flags are remapped');
    const a = syntaxOnlyArgs({ directory: '/p', file: 'y.cpp', arguments: ['c++', '-std=c++17', '-oout.o', '-c', 'y.cpp'] }, '/p', '/sb', '/sb/y.cpp');
    assert.deepEqual(a.args, ['-std=c++17', '-fsyntax-only', '/sb/y.cpp']);
    const root = tmpProject({ 'build/compile_commands.json': '[{"directory":"/x","file":"a.c","command":"cc -c a.c"}]', 'out/compile_commands.json': 'broken' });
    assert.equal(findCompileCommands(root)?.entries.length, 1);
    assert.equal(findCompileCommands(tmpProject({ 'compile_commands.json': '[]' })), undefined);
  });

  it('keeps only real errors in the edited file', () => {
    const out = [
      'src/a.c:3:5: error: expected ‘;’ before ‘}’ token',
      '    3 |   x = 1',
      '      |        ^',
      'src/a.c:1:10: fatal error: missing.h: No such file or directory',
      'src/other.c:9:1: error: unrelated',
      'src/a.c:7: warning: unused',
    ].join('\n');
    const e = relevantErrors(out, 'src/a.c', 'c');
    assert.equal(e.length, 1);
    const win = relevantErrors('C:\\Users\\RUNNER~1\\p\\src\\a.c:5:13: error: expected expression\nD:\\other\\lib\\a.c:1:1: error: elsewhere\n/sb/3/src/a.c:2:1: fatal error: \'v.h\' file not found', 'src/a.c', 'c');
    assert.deepEqual(win, ['src/a.c:5:13: error: expected expression'], 'paths normalised, same-name file elsewhere skipped, clang missing header ignored');
    assert.match(e[0], /expected ‘;’[\s\S]*x = 1/);
    const j = relevantErrors('src/A.java:3: error: \';\' expected\n  int x = 1\n           ^\nsrc/A.java:1: error: package org.junit does not exist', 'src/A.java', 'java');
    assert.equal(j.length, 1);
    assert.equal(javaSourceRoot('/p/src/main/java/com/acme/Foo.java', 'package com.acme;\nclass Foo {}'), '/p/src/main/java');
    assert.equal(javaSourceRoot('/p/src/Foo.java', 'class Foo {}'), '/p/src');
    assert.equal(renderSyntaxResult('a.c', { checked: false, errors: ['x'] }), '');
    assert.match(renderSyntaxResult('a.c', { checked: true, tool: 'gcc', errors: ['boom'] }), /⚠ gcc a\.c için derleme hatası/);
  });

  it('C: reports a syntax error introduced by an edit, ignores missing headers', { skip: !gcc }, async () => {
    const { ctx } = setup({ 'src/a.c': '#include "missing_vendor.h"\n#include <vendor/sub/api.h>\nvendor_t g;\nint f(void) {\n  return 1;\n}\n', 'include/x.h': 'int g(void);\n' });
    await executeTool('read_file', { path: 'src/a.c' }, ctx);
    const bad = await executeTool('edit_file', { path: 'src/a.c', old_text: '  return 1;', new_text: '  return 1 +;' }, ctx);
    assert.match(bad.output, /derleme hatası buldu[\s\S]*src\/a\.c:5/);
    assert.doesNotMatch(bad.output, /missing_vendor|vendor_t/, 'stubbed headers: undeclared names are not reported');
    const good = await executeTool('edit_file', { path: 'src/a.c', old_text: '  return 1 +;', new_text: '  return 2;' }, ctx);
    assert.doesNotMatch(good.output, /derleme hatası/);
  });

  it('C++: uses compile_commands.json flags and checks headers through a TU', { skip: !gxx }, async () => {
    const files = {
      'inc/cfg.hpp': '#pragma once\n#ifndef REQUIRED_FLAG\n#error flag missing\n#endif\nstruct Cfg { int v; };\n',
      'src/main.cpp': '#include "cfg.hpp"\nint main() { Cfg c{1}; return c.v - 1; }\n',
    };
    const { root, ctx, m } = setup(files);
    // without the database the header cannot compile (flag missing) → the error is in the header, it is reported
    const plain = await syntaxCheck('inc/cfg.hpp', ctx.overlay, m, 'auto');
    assert.equal(plain.checked, true);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(root, 'compile_commands.json'), JSON.stringify([{ directory: join(root, 'build'), file: join(root, 'src/main.cpp'), command: `c++ -std=c++17 -DREQUIRED_FLAG -I${join(root, 'inc')} -c ${join(root, 'src/main.cpp')} -o main.o` }]));
    const ok = await syntaxCheck('src/main.cpp', ctx.overlay, m, 'auto');
    assert.deepEqual(ok.errors, []);
    assert.match(ok.tool!, /compile_commands/);
    ctx.overlay.write('inc/cfg.hpp', files['inc/cfg.hpp'].replace('int v;', 'int v'));
    const hdr = await syntaxCheck('inc/cfg.hpp', ctx.overlay, m, 'auto');
    assert.equal(hdr.checked, true);
    assert.ok(hdr.errors.some((e) => /cfg\.hpp:5/.test(e)), JSON.stringify(hdr));
  });

  it('Java: javac with the source root finds errors and resolves sibling classes', { skip: !javac }, async () => {
    const { ctx, m } = setup({
      'src/main/java/com/acme/Util.java': 'package com.acme;\npublic class Util { public static int twice(int x) { return 2 * x; } }\n',
      'src/main/java/com/acme/App.java': 'package com.acme;\npublic class App { int run() { return Util.twice(2); } }\n',
    });
    assert.deepEqual((await syntaxCheck('src/main/java/com/acme/App.java', ctx.overlay, m, 'auto')).errors, []);
    ctx.overlay.write('src/main/java/com/acme/App.java', 'package com.acme;\npublic class App { int run() { return Util.thrice(2) } }\n');
    const r = await syntaxCheck('src/main/java/com/acme/App.java', ctx.overlay, m, 'auto');
    assert.equal(r.tool, 'javac');
    assert.ok(r.errors.length >= 1, JSON.stringify(r));
  });

  it('custom commands per extension, off switch and unknown languages', async () => {
    const { ctx, m } = setup({ 'a.txt': 'x', 'b.py': 'x = (' });
    const custom = await syntaxCheck('b.py', ctx.overlay, m, { '.py': `node -e "process.exit(require('fs').readFileSync('{file}','utf8').includes('(')?1:0)"` });
    assert.equal(custom.checked, true);
    assert.equal(custom.errors.length, 1);
    assert.equal((await syntaxCheck('a.txt', ctx.overlay, m, { '.py': 'x' })).checked, false);
    assert.equal((await syntaxCheck('a.c', ctx.overlay, m, 'off')).checked, false);
    assert.equal((await syntaxCheck('a.txt', ctx.overlay, m, 'auto')).checked, false);
  });
});
