import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { startMockServer, type MockServerHandle } from '../../src/mock/server.js';
import { UsageMeter, fillBar, fillText, fmtTok } from '../../src/tui/usage.js';
import { caps, config, recordingBus, routerFor } from '../helpers.js';

const servers: MockServerHandle[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

const req = (source: string, prompt: number, window: number) => ({ type: 'llm.request', source, data: { prompt, window } });
const res = (source: string, i: number, o: number, window = 0) => ({ type: 'llm.response', source, data: { in: i, out: o, ms: 500, window } });

describe('console usage meter', () => {
  it('counts tokens per model and shows the live context fill of requests in flight', () => {
    const u = new UsageMeter();
    assert.equal(u.footerText(), '');
    const op = u.begin();
    u.onEvent(req('a@e', 30_000, 128_000));
    u.onEvent(req('b@e', 12_000, 16_000));
    assert.equal(u.active, 2);
    assert.deepEqual(u.liveFill(), { model: 'b@e', used: 12_000, window: 16_000, fill: 0.75 });
    assert.equal(u.activityText(op), '2 LLM isteği sürüyor · bağlam 75% (12K/16K)');
    u.onEvent(res('b@e', 12_400, 800));
    assert.equal(u.active, 1);
    assert.equal(u.activityText(op), '1 LLM isteği sürüyor · 12K↑ 800↓ token · bağlam 23% (30K/128K)');
    u.onEvent({ type: 'llm.error', source: 'a@e', data: {} });
    u.onEvent({ type: 'llm.truncated', source: 'b@e' });
    assert.equal(u.active, 0);
    assert.equal(u.activityText(), '');
    assert.equal(u.summary(op), '1 istek · 12K giriş / 800 çıkış token · en dolu bağlam 78% (12K/16K) (b@e) · 1 hata');
    u.end(op);
    assert.equal(u.footerText(), '13K token · bağlam 78%');
    assert.deepEqual([u.byModel['b@e'].truncated, u.byModel['a@e'].errors], [1, 1]);
    const t = u.table();
    assert.equal(t[2], '| b@e | 1 | 12K | 800 | 0.5 sn | 78% / 16K | 0 | 1 |');
    assert.equal(t[3], '| a@e | 0 | 0 | 0 | - | 23% / 128K | 1 | 0 |');
    // a later operation keeps its own peak; a server without usage falls back to the estimate
    const op2 = u.begin();
    u.onEvent(req('a@e', 5000, 128_000));
    u.onEvent(res('a@e', 0, 10));
    assert.match(u.summary(op2), /en dolu bağlam 4% \(5.0K\/128K\) \(a@e\)/);
    assert.equal(u.summary(u.begin()), '');
    u.onEvent(res('ghost@x', 1, 1));
    assert.equal(u.byModel['ghost@x'].window, 0, 'no window known → no fill');
    u.reset();
    assert.deepEqual([u.requests, Object.keys(u.byModel).length, u.last], [0, 0, undefined]);
  });

  it('formats numbers and bars', () => {
    assert.deepEqual([fmtTok(950), fmtTok(1250), fmtTok(64_000), fmtTok(2_500_000)], ['950', '1.3K', '64K', '2.5M']);
    assert.equal(fillBar(0.62), '▰▰▰▰▰▰▱▱▱▱');
    assert.equal(fillBar(1.7), '▰▰▰▰▰▰▰▰▰▰');
    assert.equal(fillText({ model: 'm', used: 80_000, window: 128_000, fill: 0.625 }), '63% (80K/128K)');
  });

  it('the router reports prompt size and window with every request', async () => {
    const s = await startMockServer([{ id: 'm', quality: 'good', tools: true, ctx: 32768 }]);
    servers.push(s);
    const bus = recordingBus();
    const r = routerFor(config({ endpoints: [{ name: 'e', baseUrl: s.url }] }), [caps('m', 'e', { contextWindow: 32768 })], bus);
    const u = new UsageMeter();
    bus.on('event', (e: { type: string; source?: string; data?: Record<string, unknown> }) => u.onEvent(e));
    await r.chat({ messages: [{ role: 'user', content: 'merhaba '.repeat(400) }] });
    const q = bus.ofType('llm.request')[0].data!;
    assert.ok((q.prompt as number) > 300 && q.window === 32768, JSON.stringify(q));
    assert.equal(bus.ofType('llm.response')[0].data!.window, 32768);
    assert.equal(u.requests, 1);
    assert.ok(u.last && u.last.fill > 0 && u.last.window === 32768);
  });
});
