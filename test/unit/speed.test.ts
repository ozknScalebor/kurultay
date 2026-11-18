import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { multiModelNote, renderTiming, TimingTracker } from '../../src/orchestrator/timing.js';
import { RateLimiter } from '../../src/util/async.js';
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
