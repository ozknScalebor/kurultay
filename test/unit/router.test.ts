import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { LlmError } from '../../src/llm/types.js';
import { startMockServer, type MockServerHandle } from '../../src/mock/server.js';
import { caps, config, recordingBus, routerFor } from '../helpers.js';

const PING = { messages: [{ role: 'user' as const, content: 'Reply with exactly the word PONG and nothing else.' }] };
const servers: MockServerHandle[] = [];
async function mock(...args: Parameters<typeof startMockServer>) {
  const s = await startMockServer(...args);
  servers.push(s);
  return s;
}
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

describe('Router – model selection', () => {
  it('prefers the model with the best role score and spreads picks across endpoints', async () => {
    const cfg = config({ endpoints: [{ name: 'a', baseUrl: 'http://127.0.0.1:1/v1' }, { name: 'b', baseUrl: 'http://127.0.0.1:2/v1' }] });
    const r = routerFor(cfg, [
      caps('a1', 'a', { roleScores: { planner: 0.9, coder: 0.9, summarizer: 0.2, reviewer: 0.5, judge: 0.5, fast: 0.1 } }),
      caps('a2', 'a', { roleScores: { planner: 0.8, coder: 0.8, summarizer: 0.9, reviewer: 0.5, judge: 0.5, fast: 0.9 } }),
      caps('b1', 'b', { roleScores: { planner: 0.3, coder: 0.3, summarizer: 0.3, reviewer: 0.5, judge: 0.5, fast: 0.3 } }),
    ]);
    assert.equal(r.best('coder')!.caps.key, 'a1@a');
    assert.equal(r.best('fast')!.caps.key, 'a2@a');
    // two picks must come from two different endpoints even though a2 scores higher than b1
    assert.deepEqual(r.pick('coder', 2).map((h) => h.caps.endpoint).sort(), ['a', 'b']);
    assert.equal(r.pick('coder', 10).length, 3);
    assert.equal(r.pick('coder', 2, ['a1@a'])[0].caps.key, 'a2@a');
  });

  it('honours endpoint model whitelist, disabled models and pinned roles', () => {
    const cfg = config({
      endpoints: [{ name: 'a', baseUrl: 'http://127.0.0.1:1/v1', models: ['keep', 'pinned'] }, { name: 'off', baseUrl: 'http://127.0.0.1:3/v1', disabled: true }],
      models: { pinned: { roles: ['judge'] }, 'drop@a': { disabled: true } },
    });
    const r = routerFor(cfg, [caps('keep', 'a'), caps('pinned', 'a'), caps('stale', 'a'), caps('drop', 'a'), caps('x', 'off')]);
    assert.deepEqual(r.list().map((h) => h.caps.key).sort(), ['keep@a', 'pinned@a']);
    assert.equal(r.get('pinned@a')!.caps.roleScores.judge, 1);
    assert.ok(r.get('pinned@a')!.caps.roleScores.coder <= 0.2);
    assert.equal(r.best('judge')!.caps.key, 'pinned@a');
  });

  it('applies context window overrides and endpoint concurrency', () => {
    const cfg = config({ endpoints: [{ name: 'a', baseUrl: 'http://127.0.0.1:1/v1', maxConcurrency: 5 }], models: { m: { contextWindow: 123456 } } });
    const r = routerFor(cfg, [caps('m', 'a', { contextWindow: 4096, maxConcurrency: 1 })]);
    assert.equal(r.get('m@a')!.caps.contextWindow, 123456);
    assert.equal(r.slotsFor('a').limit, 5);
    assert.equal(r.totalCapacity(), 5);
  });

  it('filters models that cannot hold the prompt', () => {
    const cfg = config({ endpoints: [{ name: 'a', baseUrl: 'http://127.0.0.1:1/v1' }] });
    const r = routerFor(cfg, [caps('small', 'a', { contextWindow: 4096 }), caps('big', 'a', { contextWindow: 131072 })]);
    assert.deepEqual(r.rank('coder', { minContext: 50_000 }).map((h) => h.caps.key), ['big@a']);
  });
});

describe('Router – resilience', () => {
  it('retries transient 503 errors on the same model', async () => {
    const s = await mock([{ id: 'flaky', quality: 'good', tools: true, ctx: 32768, failFirst: 2 }]);
    const r = routerFor(config({ endpoints: [{ name: 'e', baseUrl: s.url }] }), [caps('flaky', 'e')]);
    const res = await r.chat(PING, { retryBaseMs: 5 });
    assert.equal(res.content, 'PONG');
    assert.equal(res.model, 'flaky@e');
    assert.equal(r.get('flaky@e')!.health.failures, 2);
    assert.equal(r.get('flaky@e')!.health.successes, 1);
  });

  it('opens the circuit after repeated failures and fails over to another model', async () => {
    const s = await mock([
      { id: 'dead', quality: 'good', tools: true, ctx: 32768, handler: () => ({ status: 500, error: 'boom' }) },
      { id: 'ok', quality: 'good', tools: true, ctx: 32768 },
    ]);
    const bus = recordingBus();
    const cfg = config({ endpoints: [{ name: 'e', baseUrl: s.url }] });
    const r = routerFor(cfg, [caps('dead', 'e', { roleScores: { planner: 1, coder: 1, summarizer: 1, reviewer: 1, judge: 1, fast: 1 } }), caps('ok', 'e')], bus);
    const res = await r.chat(PING, { role: 'coder', retryBaseMs: 5 });
    assert.equal(res.model, 'ok@e');
    assert.ok(r.get('dead@e')!.health.circuitOpenUntil > Date.now(), 'circuit must be open');
    assert.ok(bus.ofType('log.warn').some((e) => /circuit breaker/.test(e.message ?? '')));
    const before = s.log.filter((l) => l.model === 'dead').length;
    await r.chat(PING, { role: 'coder' });
    assert.equal(s.log.filter((l) => l.model === 'dead').length, before, 'open circuit is skipped');
    assert.equal(r.stats().find((x) => x.key === 'dead@e')!.circuitOpen, true);
  });

  it('disables a model for a long time on auth errors without retrying', async () => {
    const s = await mock([
      { id: 'locked', quality: 'good', tools: true, ctx: 32768, handler: () => ({ status: 401, error: 'bad key' }) },
      { id: 'ok', quality: 'good', tools: true, ctx: 32768 },
    ]);
    const r = routerFor(config({ endpoints: [{ name: 'e', baseUrl: s.url }] }), [caps('locked', 'e'), caps('ok', 'e')]);
    const res = await r.chat(PING, { prefer: ['locked@e'] });
    assert.equal(res.model, 'ok@e');
    assert.equal(s.log.filter((l) => l.model === 'locked').length, 1, 'auth errors are not retried');
    assert.ok(r.get('locked@e')!.health.circuitOpenUntil - Date.now() > 5 * 60_000);
  });

  it('moves to a larger model when the preferred one overflows its context', async () => {
    const s = await mock([
      { id: 'tiny', quality: 'good', tools: true, ctx: 1000 },
      { id: 'large', quality: 'good', tools: true, ctx: 100_000 },
    ]);
    // capabilities claim a big window for tiny – the server proves otherwise
    const r = routerFor(config({ endpoints: [{ name: 'e', baseUrl: s.url }] }), [caps('tiny', 'e', { contextWindow: 100_000 }), caps('large', 'e', { contextWindow: 100_000 })]);
    const big = 'word '.repeat(4000);
    const res = await r.chat({ messages: [{ role: 'user', content: `${big}\nReply with exactly the word PONG and nothing else.` }] }, { prefer: ['tiny@e'] });
    assert.equal(res.model, 'large@e');
    assert.equal(s.log.filter((l) => l.model === 'tiny').length, 1, 'context errors are not retried');
    assert.equal(r.get('tiny@e')!.health.circuitOpenUntil, 0, 'context errors do not open the circuit');
  });

  it('gives up quickly on non-transient errors from every model', async () => {
    const s = await mock([{ id: 'bad', quality: 'good', tools: true, ctx: 32768, handler: () => ({ status: 422, error: 'invalid request' }) }]);
    const r = routerFor(config({ endpoints: [{ name: 'e', baseUrl: s.url }] }), [caps('bad', 'e')]);
    const t0 = Date.now();
    await assert.rejects(r.chat(PING), (e: unknown) => e instanceof LlmError && e.kind === 'bad_request');
    assert.ok(Date.now() - t0 < 2000);
  });

  it('waits for recovery when every model is down, then succeeds', async () => {
    const s = await mock([{ id: 'boot', quality: 'good', tools: true, ctx: 32768, handler: (q) => (q.n <= 4 ? { status: 503, error: 'loading' } : undefined) }]);
    const bus = recordingBus();
    const r = routerFor(config({ endpoints: [{ name: 'e', baseUrl: s.url }] }), [caps('boot', 'e')], bus);
    const res = await r.chat(PING, { attemptsPerModel: 1, recoveryWaitMs: 10_000, recoveryIntervalMs: 20 });
    assert.equal(res.content, 'PONG');
    assert.ok(bus.ofType('log.warn').some((e) => /unreachable/.test(e.message ?? '')));
  });

  it('stops waiting at the recovery deadline', async () => {
    const s = await mock([{ id: 'down', quality: 'good', tools: true, ctx: 32768, handler: () => ({ status: 503, error: 'down' }) }]);
    const r = routerFor(config({ endpoints: [{ name: 'e', baseUrl: s.url }] }), [caps('down', 'e')]);
    const t0 = Date.now();
    await assert.rejects(r.chat(PING, { attemptsPerModel: 1, recoveryWaitMs: 300, recoveryIntervalMs: 50 }), (e: unknown) => e instanceof LlmError && e.retryable);
    assert.ok(Date.now() - t0 < 5000);
  });

  it('times out a hanging request and falls back', async () => {
    const s = await mock([
      { id: 'hang', quality: 'good', tools: true, ctx: 32768, handler: () => ({ hangMs: 3000 }) },
      { id: 'ok', quality: 'good', tools: true, ctx: 32768 },
    ]);
    const r = routerFor(config({ endpoints: [{ name: 'e', baseUrl: s.url }] }), [caps('hang', 'e'), caps('ok', 'e')]);
    const t0 = Date.now();
    const res = await r.chat({ ...PING, timeoutMs: 150 }, { prefer: ['hang@e'], attemptsPerModel: 1 });
    assert.equal(res.model, 'ok@e');
    assert.ok(Date.now() - t0 < 2500);
    assert.match(r.get('hang@e')!.health.lastError ?? '', /timeout/i);
  });

  it('honours abort signals', async () => {
    const s = await mock([{ id: 'slow', quality: 'good', tools: true, ctx: 32768, handler: () => ({ hangMs: 3000 }) }]);
    const r = routerFor(config({ endpoints: [{ name: 'e', baseUrl: s.url }] }), [caps('slow', 'e')]);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error('stop')), 100);
    await assert.rejects(r.chat({ ...PING, signal: ctrl.signal }), (e: unknown) => e instanceof LlmError && e.kind === 'aborted');
  });

  it('throws clear errors when nothing can serve the request', async () => {
    const empty = routerFor(config({ endpoints: [{ name: 'e', baseUrl: 'http://127.0.0.1:1/v1' }] }), []);
    await assert.rejects(empty.chat(PING), /No registered model/);
    const r = routerFor(config({ endpoints: [{ name: 'e', baseUrl: 'http://127.0.0.1:1/v1' }] }), [caps('m', 'e')]);
    await assert.rejects(r.chat(PING, { only: ['ghost@x'] }), /No model matches the requested constraints/);
  });

  it('never exceeds the per-endpoint concurrency limit', async () => {
    const s = await mock([{ id: 'm', quality: 'good', tools: true, ctx: 32768, latencyMs: 40 }]);
    const r = routerFor(config({ endpoints: [{ name: 'e', baseUrl: s.url, maxConcurrency: 2 }] }), [caps('m', 'e')]);
    let peak = 0;
    const timer = setInterval(() => (peak = Math.max(peak, r.slotsFor('e').inUse)), 2);
    await Promise.all(Array.from({ length: 8 }, () => r.chat(PING)));
    clearInterval(timer);
    assert.equal(peak, 2);
    assert.equal(r.slotsFor('e').inUse, 0);
  });

  it('discovers models from GET /models and skips unreachable endpoints', async () => {
    const s = await mock([{ id: 'one', quality: 'good', tools: true, ctx: 8192 }, { id: 'two', quality: 'good', tools: true, ctx: 65536 }]);
    const bus = recordingBus();
    const cfg = config({ endpoints: [{ name: 'e', baseUrl: s.url }, { name: 'gone', baseUrl: 'http://127.0.0.1:9/v1' }] });
    const r = routerFor(cfg, [], bus);
    const found = await r.discover();
    assert.deepEqual(found.map((c) => c.key).sort(), ['one@e', 'two@e']);
    assert.equal(found.find((c) => c.model === 'two')!.contextWindow, 65536);
    assert.ok(bus.ofType('log.warn').some((e) => /gone/.test(e.message ?? '')));
  });
});
