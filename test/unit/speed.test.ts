import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { multiModelNote, renderTiming, TimingTracker } from '../../src/orchestrator/timing.js';
import { RateLimiter, settleQuorum } from '../../src/util/async.js';
import type { KEvent } from '../../src/util/events.js';
import { caps, config, routerFor } from '../helpers.js';

describe('RateLimiter', () => {
  it('lets the first requests through at once and holds the next one back', async () => {
    const l = new RateLimiter(2);
    assert.equal(await l.take(), 0);
    assert.equal(await l.take(), 0);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error('stop')), 60);
    await assert.rejects(l.take(ctrl.signal), /stop/);
  });
});

describe('Router – main model and provider limits', () => {
  const roles = { planner: 0.8, coder: 0.8, summarizer: 0.8, reviewer: 0.8, judge: 0.8, fast: 0.8 };

  it('prefers orchestrator.primaryModel for coding and planning, not for the light roles', () => {
    const cfg = config({ endpoints: [{ name: 'a', baseUrl: 'http://127.0.0.1:1/v1' }, { name: 'b', baseUrl: 'http://127.0.0.1:2/v1' }], orchestrator: { primaryModel: 'kimi' } });
    const r = routerFor(cfg, [caps('strong', 'a', { roleScores: { ...roles, coder: 0.9, planner: 0.9 } }), caps('kimi', 'b', { roleScores: { ...roles, coder: 0.7, planner: 0.7, fast: 0.5 } })]);
    assert.equal(r.best('coder')!.caps.key, 'kimi@b');
    assert.equal(r.best('planner')!.caps.key, 'kimi@b');
    assert.equal(r.best('fast')!.caps.key, 'strong@a');
    assert.equal(r.pick('coder', 2).length, 2, 'the other models still take part');
  });

  it('shares one requests-per-minute limiter between endpoints of the same key', () => {
    const cfg = config({
      endpoints: [
        { name: 'n1', baseUrl: 'https://nim/v1', apiKey: 'k', requestsPerMinute: 40, models: ['m1'] },
        { name: 'n2', baseUrl: 'https://nim/v1', apiKey: 'k', requestsPerMinute: 40, models: ['m2'] },
        { name: 'other', baseUrl: 'https://nim/v1', apiKey: 'k2', requestsPerMinute: 40, models: ['m3'] },
      ],
    });
    const r = routerFor(cfg, [caps('m1', 'n1'), caps('m2', 'n2'), caps('m3', 'other')]);
    const rpm = (r as unknown as { rpm: Map<string, RateLimiter> }).rpm;
    assert.equal(rpm.get('n1'), rpm.get('n2'));
    assert.notEqual(rpm.get('n1'), rpm.get('other'));
  });
});

describe('TimingTracker', () => {
  const ev = (type: string, ts: number, source?: string, data?: Record<string, unknown>) => ({ type, ts, source, data }) as unknown as KEvent;

  function run(fast: boolean, models: string[]) {
    const t = new TimingTracker();
    const s = 1_000_000;
    const events = [
      ev('run.start', s),
      ev('run.plan', s + 20_000, undefined, { fast }),
      ev('worker.start', s + 20_000, 'st1-1'),
      ev('worker.start', s + 20_000, 'st1-2'),
      ev('worker.end', s + 50_000, 'st1-1', { status: 'done' }),
      ev('worker.end', s + 80_000, 'st1-2', { status: 'done' }),
      ev('subtask.winner', s + 90_000, 'st1'),
      ev('run.verify', s + 100_000),
      ev('run.requirements', s + 110_000),
      ev('llm.wait', s + 30_000, models[0], { reason: 'rate_limit', ms: 5000 }),
      ...models.map((m) => ev('llm.response', s + 40_000, m)),
    ];
    for (const e of events) t.onEvent(e);
    return t.result(s + 120_000, 0);
  }

  it('splits the run into phases and names the multi-model share', () => {
    const r = run(false, ['kimi@n', 'ds@n']);
    assert.equal(r.totalSeconds, 120);
    assert.equal(r.planning, 20);
    assert.equal(r.coding, 30);
    assert.equal(r.slowerCandidates, 30);
    assert.equal(r.selection, 10);
    assert.equal(r.verify, 10);
    assert.equal(r.requirements, 10);
    assert.equal(r.models, 2);
    // plan council 20 + slower 30 + selection 10 + judges 10 + rate limit 5
    assert.equal(r.multiModel, 75);
    const note = multiModelNote(r)!;
    assert.match(note, /63% of the time/);
    assert.match(note, /waiting for slower candidates 30 s/);
    assert.match(renderTiming(r).join('\n'), /\*\*Multi-model work\*\* \(2 models answered\)/);
  });

  it('does not charge provider waits to the extra models when only one model answered', () => {
    const r = run(true, ['kimi@n']);
    assert.equal(r.planCouncil, false);
    assert.equal(r.multiModel, 50, 'slower 30 + selection 10 + judges 10, no plan council, no waits');
    assert.equal(r.rateLimitWait, 5);
    assert.equal(multiModelNote({ ...r, totalSeconds: 20 }), undefined, 'short runs get no warning');
  });
});

describe('known context windows', () => {
  it('maps model ids of well-known families to their published window, capped at 256k', async () => {
    const { knownContextWindow, normalizeModelId } = await import('../../src/llm/known-windows.js');
    const { defaultCapabilities } = await import('../../src/llm/models.js');
    assert.equal(normalizeModelId('moonshotai/Kimi-K3.1-Pro'), 'kimi-k3.1-pro');
    assert.equal(knownContextWindow('moonshotai/kimi-k3.1-pro'), 262_144);
    assert.equal(knownContextWindow('Qwen3.8-Flash-Next-FP8'), 262_144);
    assert.equal(knownContextWindow('qwen2.5-coder-1.5b-instruct-q4_k_m.gguf'), 32_768);
    assert.equal(knownContextWindow('z-ai/glm-5.3-flash'), 202_752);
    assert.equal(knownContextWindow('mistralai/mistral-large-4-1t-a52b'), 131_072);
    assert.equal(knownContextWindow('nvidia/nemotron-3.5-lightning-30b-a3b'), 131_072);
    assert.equal(knownContextWindow('my-own-model'), undefined);
    assert.equal(defaultCapabilities('moonshotai/kimi-k3.1-pro', 'e').contextWindow, 262_144, 'an unprobed model gets its family window');
    assert.equal(defaultCapabilities('my-own-model', 'e').contextWindow, 32_768);
  });
});

describe('settleQuorum', () => {
  const wait = <T>(ms: number, v: T, signal: AbortSignal) =>
    new Promise<T>((res, rej) => {
      const t = setTimeout(() => res(v), ms);
      signal.addEventListener('abort', () => (clearTimeout(t), rej(new Error('aborted'))), { once: true });
    });

  it('does not wait for a slow model once one has answered and the grace is over', async () => {
    const late: number[] = [];
    const t0 = Date.now();
    const r = await settleQuorum([(s) => wait(10, 'a', s), (s) => wait(5000, 'b', s), (s) => wait(15, 'c', s)], { minGraceMs: 40, factor: 0, onLate: (i) => late.push(i) });
    assert.ok(Date.now() - t0 < 1000);
    assert.deepEqual(r.map((x) => x.ok), [true, false, true]);
    assert.equal((r[1] as { late?: boolean }).late, true);
    assert.deepEqual(late, [1]);
  });

  it('waits for everyone when nobody succeeds, and passes the caller\'s abort on', async () => {
    const r = await settleQuorum([() => Promise.reject(new Error('x')), (s) => wait(20, 'b', s)], { minGraceMs: 1000 });
    assert.deepEqual(r.map((x) => x.ok), [false, true]);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error('stop')), 20);
    const a = await settleQuorum([(s) => wait(5000, 'a', s)], { signal: ctrl.signal });
    assert.equal(a[0].ok, false);
  });
});

describe('role scores of a model whose speed test failed', () => {
  it('ranks it last instead of letting it plan or review', async () => {
    const { computeRoleScores } = await import('../../src/llm/models.js');
    const base = { contextWindow: 131_072, nativeTools: true, tokensPerSec: 0, codingScore: 0.5, editScore: 0.5, instructionScore: 1, thinking: true };
    const ok = computeRoleScores({ ...base, tokensPerSec: 30, streaming: true }, 40);
    const broken = computeRoleScores({ ...base, streaming: false }, 40);
    assert.ok(broken.planner < ok.planner * 0.5 && broken.reviewer < ok.reviewer * 0.5);
  });
});

describe('Router – speed band', () => {
  const fastCaps = { tokensPerSec: 190, ttftMs: 1000 };
  const slowCaps = { tokensPerSec: 19, ttftMs: 7000 };

  it('keeps a model ten times slower out of the steps that wait for everyone, unless nothing else is left', () => {
    const cfg = config({ endpoints: [{ name: 'a', baseUrl: 'http://127.0.0.1:1/v1' }, { name: 'b', baseUrl: 'http://127.0.0.1:2/v1' }] });
    const r = routerFor(cfg, [caps('fast', 'a', fastCaps), caps('slow', 'b', slowCaps), caps('new', 'b')]);
    assert.deepEqual(r.pick('coder', 3).map((h) => h.caps.model).sort(), ['fast', 'new'], 'unmeasured models are not judged');
    assert.equal(r.inSpeedBand(r.get('slow@b')!, 'coder'), false);
    assert.deepEqual(r.pick('reviewer', 1, ['fast@a', 'new@b']).map((h) => h.caps.model), ['slow'], 'the only one left is still used');
    assert.deepEqual(r.pick('reviewer', 1, ['fast@a', 'new@b'], { strictBand: true }), [], 'strict: not waited for');
    assert.equal(r.pick('summarizer', 3).length, 3, 'light, spread-out work uses every model');
    r.speedBand = 0;
    assert.equal(r.pick('coder', 3).length, 3, 'band off after an escalation');
  });

  it('judges by the live speed once a model has answered a few requests', () => {
    const cfg = config({ endpoints: [{ name: 'a', baseUrl: 'http://127.0.0.1:1/v1' }] });
    const r = routerFor(cfg, [caps('fast', 'a', fastCaps), caps('slow', 'a', slowCaps)]);
    const slow = r.get('slow@a')!;
    slow.health.successes = 5;
    slow.health.ewmaMsPerToken = 8; // the free tier got quick again
    assert.equal(r.inSpeedBand(slow, 'coder'), true);
  });
});

describe('time line of a bench run', () => {
  it('names the phases that took time and counts one candidate\'s checks as build/tests', async () => {
    const t = new TimingTracker();
    const s = 1_000_000;
    for (const e of [
      { type: 'run.start', ts: s },
      { type: 'run.plan', ts: s + 5000, data: { fast: true } },
      { type: 'worker.start', ts: s + 5000, source: 'T1-1' },
      { type: 'worker.end', ts: s + 65_000, source: 'T1-1', data: { status: 'done' } },
      { type: 'subtask.winner', ts: s + 95_000, source: 'T1' },
      { type: 'run.verify', ts: s + 120_000 },
      { type: 'run.requirements', ts: s + 120_000 },
    ]) t.onEvent(e as unknown as KEvent);
    const r = t.result(s + 121_000);
    assert.equal(r.selection, 0);
    assert.equal(r.verify, 55, '30 s checks of the only candidate + 25 s final verification');
    assert.equal(r.multiModel, 0);
    const bench = (await import(new URL('../../../scripts/bench.mjs', import.meta.url).href)) as { timingLine: (t: unknown) => string };
    assert.match(bench.timingLine(r), /triage 5 s · coding 60 s · build\/tests 55 s \(total 121 s, multi-model 0%\)/);
  });
});
