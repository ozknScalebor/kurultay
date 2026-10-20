import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ConfigError, findConfigFile, loadConfig, modelKey, parseConfig } from '../../src/config.js';
import { renderCapabilitiesMarkdown } from '../../src/probe/probe.js';
import { mapLimit, Semaphore, settle, sleep, withTimeout, errorMessage } from '../../src/util/async.js';
import { EventBus } from '../../src/util/events.js';
import { estimateTokens, fnv1a, indent, slug, stripThinking, truncateMiddle, truncateTokens, tryExtractJson, extractJson } from '../../src/util/text.js';
import { caps, tmpProject } from '../helpers.js';

describe('config', () => {
  const ep = { name: 'a', baseUrl: 'http://h:1/v1' };
  it('rejects invalid configurations with clear messages', () => {
    assert.throws(() => parseConfig({}), /en az bir/);
    assert.throws(() => parseConfig({ endpoints: [ep, ep] }), /tekrar/);
    assert.throws(() => parseConfig({ endpoints: [{ name: 'bad name', baseUrl: 'http://h' }] }), /Geçersiz endpoint adı/);
    assert.throws(() => parseConfig({ endpoints: [{ name: 'a', baseUrl: 'ftp://h' }] }), /baseUrl/);
    assert.throws(() => parseConfig({ endpoints: [{ name: 'a', baseUrl: 'not a url' }] }), ConfigError);
    assert.throws(() => parseConfig({ endpoints: [ep], orchestrator: { defaultMode: 'chaos' } }), /defaultMode/);
  });
  it('deep-merges defaults and interpolates env vars with fallbacks', () => {
    delete process.env.K_NOPE;
    const c = parseConfig({ endpoints: [{ ...ep, apiKey: '${K_NOPE:-fallback}', headers: { 'x-a': '${K_NOPE}' } }], orchestrator: { raceWidth: 5 }, index: { exclude: ['gen/**'] } });
    assert.equal(c.endpoints[0].apiKey, 'fallback');
    assert.equal(c.endpoints[0].headers!['x-a'], '');
    assert.equal(c.orchestrator.raceWidth, 5);
    assert.equal(c.orchestrator.councilSize, 3, 'other defaults kept');
    assert.deepEqual(c.index.exclude, ['gen/**']);
    assert.ok(c.tools.denyPatterns.length > 3);
    assert.equal(modelKey('m', 'e'), 'm@e');
  });
  it('finds config files in priority order and reports unreadable JSON', () => {
    const root = tmpProject({ '.kurultay/config.json': JSON.stringify({ endpoints: [ep] }) });
    assert.equal(findConfigFile(root), join(root, '.kurultay', 'config.json'));
    writeFileSync(join(root, 'kurultay.config.json'), JSON.stringify({ endpoints: [{ name: 'top', baseUrl: 'http://h:2/v1' }] }));
    assert.equal(loadConfig(root).config.endpoints[0].name, 'top');
    writeFileSync(join(root, 'broken.json'), '{ nope');
    assert.throws(() => loadConfig(root, join(root, 'broken.json')), /okunamadı/);
    const empty = tmpProject({});
    mkdirSync(join(empty, 'sub'));
    if (!findConfigFile(empty)) assert.throws(() => loadConfig(empty), /kurultay init/);
  });
});

describe('text utils', () => {
  it('estimates and truncates', () => {
    assert.equal(estimateTokens(''), 0);
    assert.ok(estimateTokens('x'.repeat(360)) === 100);
    const t = truncateMiddle('a'.repeat(1000), 200);
    assert.ok(t.length < 260 && t.includes('kırpıldı'));
    assert.equal(truncateMiddle('short', 100), 'short');
    assert.ok(truncateTokens('b'.repeat(10_000), 100).length < 500);
  });
  it('extracts JSON robustly', () => {
    assert.deepEqual(extractJson('[1, 2, 3]'), [1, 2, 3]);
    assert.deepEqual(extractJson('```\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('text {"smart": “quotes”} end'), { smart: 'quotes' });
    assert.deepEqual(extractJson('```json\nbroken\n```\nlater {"ok": true}'), { ok: true });
    assert.deepEqual(extractJson('{"esc": "a \\"b\\" {c}"}'), { esc: 'a "b" {c}' });
    assert.equal(tryExtractJson('nothing here'), undefined);
    assert.throws(() => extractJson('{'), /JSON/);
  });
  it('handles thinking blocks, slugs, hashes and indentation', () => {
    assert.deepEqual(stripThinking('<thinking>a</thinking>b'), { content: 'b', thinking: 'a' });
    assert.deepEqual(stripThinking('<think>cut off mid'), { content: '', thinking: 'cut off mid' });
    assert.equal(slug('Src/Net Driver!!'), 'src-net-driver');
    assert.equal(slug('!!!'), 'x');
    assert.equal(fnv1a('abc'), fnv1a('abc'));
    assert.notEqual(fnv1a('abc'), fnv1a('abd'));
    assert.equal(indent('a\n\nb'), '  a\n\n  b');
  });
});

describe('async utils', () => {
  it('semaphore supports abort while waiting and dynamic limits', async () => {
    const s = new Semaphore(1);
    await s.acquire();
    const ctrl = new AbortController();
    const waiting = s.acquire(ctrl.signal);
    assert.equal(s.queued, 1);
    ctrl.abort(new Error('cancel'));
    await assert.rejects(waiting, /cancel/);
    assert.equal(s.queued, 0);
    const later = s.acquire();
    s.setLimit(2);
    await later;
    assert.equal(s.inUse, 2);
    s.release();
    s.release();
    assert.equal(s.inUse, 0);
    assert.equal(new Semaphore(0).limit, 1);
    const pre = new AbortController();
    pre.abort(new Error('already'));
    const busy = new Semaphore(1);
    await busy.acquire();
    await assert.rejects(busy.acquire(pre.signal), /already/);
  });
  it('sleep, withTimeout, settle, mapLimit order, errorMessage', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error('wake')), 10);
    await assert.rejects(sleep(5000, ctrl.signal), /wake/);
    const t = withTimeout(undefined, 20);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(t.signal.aborted, true);
    t.dispose();
    const parent = new AbortController();
    const t2 = withTimeout(parent.signal, 10_000);
    parent.abort(new Error('p'));
    assert.equal(t2.signal.aborted, true);
    t2.dispose();
    const r = await settle([Promise.resolve(1), Promise.reject(new Error('x'))]);
    assert.deepEqual(r.map((x) => x.ok), [true, false]);
    assert.deepEqual(await mapLimit([30, 1, 10], 3, async (ms, i) => { await sleep(ms); return i; }), [0, 1, 2]);
    assert.deepEqual(await mapLimit([], 3, async () => 1), []);
    assert.equal(errorMessage('plain'), 'plain');
  });
});

describe('event bus and capability report', () => {
  it('records history, writes jsonl logs and emits typed events', () => {
    const root = tmpProject({});
    const bus = new EventBus();
    const file = join(root, 'logs', 'events.jsonl');
    bus.attachLog(file);
    let got = 0;
    bus.on('log.warn', () => got++);
    bus.info('src', 'hello');
    bus.warn('src', 'careful');
    bus.error('src', 'bad');
    assert.equal(got, 1);
    assert.deepEqual(bus.history.map((e) => e.type), ['log.info', 'log.warn', 'log.error']);
    const lines = require_lines(file);
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[1]).message, 'careful');
  });
  it('renders the capability markdown table with notes', () => {
    const md = renderCapabilitiesMarkdown({ version: 1, generatedAt: 'now', models: [caps('qwen', 'gpu1', { notes: ['slow'], nativeTools: false }), caps('down', 'gpu2', { reachable: false })] });
    assert.match(md, /\| qwen@gpu1 \| ✅ \|/);
    assert.match(md, /\| down@gpu2 \| ❌ \|/);
    assert.match(md, /prompt/);
    assert.match(md, /\*\*qwen@gpu1\*\*: slow/);
  });
});

import { readFileSync } from 'node:fs';
function require_lines(file: string): string[] {
  return readFileSync(file, 'utf8').trim().split('\n');
}
