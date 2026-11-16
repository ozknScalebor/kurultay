import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig, normalizeRawConfig, parseConfig } from '../../src/config.js';
import { editModelList } from '../../src/tui/commands.js';
import { detectUnicode, forTerminal, setUnicode, toAscii, unicodeEnabled } from '../../src/ui/symbols.js';
import { plural } from '../../src/util/text.js';
import { caps, routerFor, tmpProject } from '../helpers.js';

describe('short configuration form', () => {
  it('one endpoint, one key, a list of model names; a model may carry its own key', () => {
    const c = parseConfig({ baseUrl: 'http://h:1/v1/', apiKey: 'main', models: ['a', { id: 'b', apiKey: 'own', contextWindow: 8192 }, ' c '], maxConcurrency: 4 });
    assert.equal(c.endpoints.length, 1);
    assert.deepEqual({ ...c.endpoints[0] }, { name: 'main', baseUrl: 'http://h:1/v1', apiKey: 'main', models: ['a', 'b', 'c'], maxConcurrency: 4 });
    assert.deepEqual(c.models['b@main'], { apiKey: 'own', contextWindow: 8192 });
    assert.equal(c.models['a@main'], undefined, 'plain names need no override');
  });

  it('endpointName, extra endpoints and model lists on a single endpoint', () => {
    const c = parseConfig({ baseUrl: 'http://h/v1', endpointName: 'gpu', models: [], endpoints: [{ name: 'other', baseUrl: 'http://o/v1' }] });
    assert.deepEqual(c.endpoints.map((e) => e.name), ['gpu', 'other']);
    const one = normalizeRawConfig({ endpoints: [{ name: 'x', baseUrl: 'http://x/v1' }], models: ['m', { id: 'n', apiKey: 'k' }] }) as { endpoints: Array<{ models: string[] }>; models: Record<string, unknown> };
    assert.deepEqual(one.endpoints[0].models, ['m', 'n']);
    assert.deepEqual(one.models, { 'n@x': { apiKey: 'k' } });
    assert.throws(() => normalizeRawConfig({ models: ['m'] }), ConfigError);
    assert.throws(() => normalizeRawConfig({ baseUrl: 'http://x/v1', models: [42] }), /Invalid model entry/);
    assert.equal(normalizeRawConfig(null), null);
    // the classic form with a models-override object still works
    const classic = parseConfig({ endpoints: [{ name: 'e', baseUrl: 'http://e/v1' }], models: { 'm@e': { contextWindow: 4096 } } });
    assert.equal(classic.models['m@e'].contextWindow, 4096);
  });

  it('a project config without endpoints extends the short user config', () => {
    const root = tmpProject({ 'kurultay.config.json': JSON.stringify({ verify: { test: 'make test' } }) });
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ baseUrl: 'http://h/v1', apiKey: 'k', models: ['a'] }));
    const prev = process.env.KURULTAY_HOME;
    process.env.KURULTAY_HOME = home;
    try {
      const { config } = loadConfig(root);
      assert.equal(config.endpoints[0].baseUrl, 'http://h/v1');
      assert.deepEqual(config.endpoints[0].models, ['a']);
      assert.equal(config.verify.test, 'make test');
    } finally {
      if (prev === undefined) delete process.env.KURULTAY_HOME;
      else process.env.KURULTAY_HOME = prev;
    }
  });

  it('/model add|remove edits the model list of the short form or a single endpoint', () => {
    const raw: Record<string, unknown> = { baseUrl: 'http://h/v1', apiKey: 'k' };
    editModelList(raw, 'add', 'b', undefined, ['a']);
    assert.deepEqual(raw.models, ['a', 'b'], 'the first add starts from the discovered models');
    editModelList(raw, 'add', 'c', 'own', []);
    editModelList(raw, 'add', 'b', 'new-key', []);
    assert.deepEqual(raw.models, ['a', { id: 'c', apiKey: 'own' }, { id: 'b', apiKey: 'new-key' }]);
    editModelList(raw, 'remove', 'c', undefined, []);
    assert.deepEqual(raw.models, ['a', { id: 'b', apiKey: 'new-key' }]);
    assert.throws(() => editModelList(raw, 'remove', 'zzz', undefined, []), /No model named zzz/);
    const eps: Record<string, unknown> = { endpoints: [{ name: 'e', baseUrl: 'http://e/v1', models: ['x'] }] };
    editModelList(eps, 'add', 'y', undefined, []);
    assert.deepEqual((eps.endpoints as Array<{ models: string[] }>)[0].models, ['x', 'y']);
    assert.throws(() => editModelList({}, 'add', 'y', undefined, []), /No endpoint configured/);
  });
});

describe('terminal symbols', () => {
  it('detects consoles that cannot draw Unicode', () => {
    assert.equal(detectUnicode({ KURULTAY_ASCII: '1' }, 'linux'), false);
    assert.equal(detectUnicode({ KURULTAY_ASCII: '0' }, 'win32'), true);
    assert.equal(detectUnicode({}, 'win32'), false, 'plain cmd.exe / PowerShell console');
    assert.equal(detectUnicode({ WT_SESSION: 'x' }, 'win32'), true, 'Windows Terminal');
    assert.equal(detectUnicode({ TERM: 'xterm-256color' }, 'win32'), true, 'Git Bash / mintty');
    assert.equal(detectUnicode({ LANG: 'en_US.UTF-8' }, 'linux'), true);
    assert.equal(detectUnicode({ LC_ALL: 'C.ascii' }, 'linux'), false);
  });

  it('maps every symbol to one ASCII character and keeps ANSI codes', () => {
    const s = '\x1b[32m✓\x1b[0m T1 → done… ⠋ ▰▰▱ │─┌ çğış é 漢';
    const a = toAscii(s);
    assert.equal(a, '\x1b[32m+\x1b[0m T1 > done. | ##. |-+ cgis e ?');
    assert.equal(Array.from(a).length, Array.from(s).length, 'width preserved');
    const prev = unicodeEnabled();
    try {
      setUnicode(false);
      assert.equal(forTerminal('✓ ok'), '+ ok');
      setUnicode(true);
      assert.equal(forTerminal('✓ ok'), '✓ ok');
    } finally {
      setUnicode(prev);
    }
  });

  it('pluralises counts in messages', () => {
    assert.equal(plural(1, 'file'), '1 file');
    assert.equal(plural(0, 'file'), '0 files');
    assert.equal(plural(2, 'dependency'), '2 dependencies');
    assert.equal(plural(3, 'day'), '3 days');
  });
});

describe('helper model', () => {
  it('the helper section becomes an endpoint whose models only do light work', () => {
    const c = parseConfig({ baseUrl: 'http://gpu/v1', apiKey: 'k', models: ['big'], helper: { baseUrl: 'http://127.0.0.1:8080/v1', models: ['small'] } });
    const h = c.endpoints.find((e) => e.name === 'helper')!;
    assert.deepEqual({ ...h }, { name: 'helper', baseUrl: 'http://127.0.0.1:8080/v1', apiKey: 'none', models: ['small'], roles: ['fast', 'summarizer'], rolesOnly: true });
    const custom = parseConfig({ baseUrl: 'http://gpu/v1', helper: { name: 'pc', baseUrl: 'http://127.0.0.1:1234/v1', roles: ['summarizer'], maxConcurrency: 1 } });
    assert.deepEqual(custom.endpoints[1].roles, ['summarizer']);
    assert.equal(custom.endpoints[1].maxConcurrency, 1);
    assert.throws(() => parseConfig({ baseUrl: 'http://gpu/v1', helper: { models: ['x'] } }), /"helper" needs a "baseUrl"/);
    assert.throws(() => parseConfig({ baseUrl: 'http://gpu/v1', helper: { baseUrl: 'http://h/v1', roles: ['typist'] } }), /Unknown role "typist" for endpoint helper/);
    assert.throws(() => parseConfig({ endpoints: [{ name: 'e', baseUrl: 'http://e/v1', rolesOnly: true }] }), /rolesOnly but no roles/);
    assert.throws(() => parseConfig({ endpoints: [{ name: 'e', baseUrl: 'http://e/v1' }], models: { 'm@e': { roles: ['coder', 'nap'] } } }), /Unknown role "nap"/);
    assert.throws(() => parseConfig({ endpoints: [{ name: 'e', baseUrl: 'http://e/v1' }], models: { 'm@e': { rolesOnly: true } } }), /rolesOnly but no roles/);
  });

  it('rolesOnly models get no coding, planning or review – unless nothing else is up', () => {
    const cfg = parseConfig({ baseUrl: 'http://gpu/v1', models: ['big', 'mid'], helper: { baseUrl: 'http://pc/v1', models: ['small'] }, skills: { includeUser: false } });
    const r = routerFor(cfg, [caps('big', 'main', { codingScore: 0.9 }), caps('mid', 'main', { codingScore: 0.6 }), caps('small', 'helper', { codingScore: 0.9, tokensPerSec: 500 })]);
    const helper = r.get('small@helper')!;
    assert.equal(helper.override.rolesOnly, true);
    assert.deepEqual(r.pick('coder', 3).map((h) => h.caps.key).sort(), ['big@main', 'mid@main'], 'the helper never joins a race');
    assert.ok(!r.rank('reviewer').includes(helper));
    assert.ok(!r.rank('planner').includes(helper));
    assert.equal(r.rank('summarizer')[0].caps.key, 'small@helper', 'pinned roles come first');
    assert.ok(r.rank('fast').includes(helper));
    assert.equal(r.rank().length, 3);
    // alone it is still used rather than failing the task
    const solo = routerFor(cfg, [caps('small', 'helper')]);
    assert.deepEqual(solo.rank('coder').map((h) => h.caps.key), ['small@helper']);
    // a model's own roles win over the endpoint default
    const own = parseConfig({ baseUrl: 'http://gpu/v1', helper: { baseUrl: 'http://pc/v1', models: [{ id: 'small', roles: ['fast'] }] }, skills: { includeUser: false } });
    assert.deepEqual(routerFor(own, [caps('small', 'helper')]).get('small@helper')!.override.roles, ['fast']);
  });
});
