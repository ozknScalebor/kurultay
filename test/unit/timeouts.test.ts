import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { toTextProtocol } from '../../src/agent/worker.js';
import { ConfigError, parseConfig, validateConfig } from '../../src/config.js';
import { OpenAICompatClient, Watchdog } from '../../src/llm/client.js';
import { LlmError, type ChatMessage } from '../../src/llm/types.js';
import { startMockServer, type MockServerHandle } from '../../src/mock/server.js';
import { councilReview, type Candidate } from '../../src/orchestrator/council.js';
import { caps, config, lastUser, recordingBus, routerFor } from '../helpers.js';

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

const client = (url: string) => new OpenAICompatClient({ name: 't', baseUrl: url });
const fail = async (p: Promise<unknown>): Promise<LlmError> => {
  try {
    await p;
  } catch (e) {
    return e as LlmError;
  }
  throw new Error('expected a failure');
};

describe('request watchdog', () => {
  it('fails fast when no first token arrives', async () => {
    const s = await mock([{ id: 'hang', quality: 'good', tools: true, ctx: 8192, handler: () => ({ hangMs: 3000 }) }]);
    const t0 = Date.now();
    const e = await fail(client(s.url).chat('hang', { ...PING, firstTokenTimeoutMs: 150, timeoutMs: 60_000 }));
    assert.equal(e.kind, 'timeout');
    assert.match(e.message, /ilk token gelmedi/);
    assert.ok(Date.now() - t0 < 2000);
  });

  it('fails when a started stream goes silent', async () => {
    const s = await mock([{ id: 'stall', quality: 'good', tools: true, ctx: 8192, handler: () => ({ stallAfter: ['Hel', 'lo'], stallMs: 3000 }) }]);
    const tokens: string[] = [];
    const e = await fail(client(s.url).chat('stall', { ...PING, firstTokenTimeoutMs: 1000, idleTimeoutMs: 150, onToken: (t) => tokens.push(t) }));
    assert.equal(e.kind, 'timeout');
    assert.match(e.message, /sessiz kaldı/);
    assert.deepEqual(tokens, ['Hel', 'lo'], 'the stream had started');
  });

  it('reports the total limit and leaves healthy streams alone', async () => {
    const s = await mock([
      { id: 'slowstream', quality: 'good', tools: true, ctx: 8192, handler: () => ({ stallAfter: ['a'], stallMs: 3000 }) },
      { id: 'fine', quality: 'good', tools: true, ctx: 8192, latencyMs: 20 },
      { id: 'blocking', quality: 'good', tools: true, ctx: 8192, noStream: true, latencyMs: 120 },
    ]);
    const total = await fail(client(s.url).chat('slowstream', { ...PING, timeoutMs: 200 }));
    assert.match(total.message, /toplam süre 200 ms aşıldı/);
    const ok = await client(s.url).chat('fine', { ...PING, firstTokenTimeoutMs: 2000, idleTimeoutMs: 2000 });
    assert.equal(ok.content, 'PONG');
    // first-token/idle clocks do not apply to non-streaming requests (the whole answer arrives at once)
    const ns = await client(s.url).chat('blocking', { ...PING, stream: false, firstTokenTimeoutMs: 10, idleTimeoutMs: 10 });
    assert.equal(ns.content, 'PONG');
  });

  it('keeps user aborts distinct from timeouts', async () => {
    const s = await mock([{ id: 'hang2', quality: 'good', tools: true, ctx: 8192, handler: () => ({ hangMs: 3000 }) }]);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    const e = await fail(client(s.url).chat('hang2', { ...PING, signal: ctrl.signal, firstTokenTimeoutMs: 5000 }));
    assert.equal(e.kind, 'aborted');
    const pre = new AbortController();
    pre.abort();
    const w = new Watchdog(pre.signal, { totalMs: 1000 });
    assert.equal(w.signal.aborted, true);
    assert.equal(w.fired, '');
    w.activity();
    w.dispose();
  });
});

describe('router: models that stop answering', () => {
  it('derives timeouts: model > endpoint > llm defaults, first-token grows with the prompt', () => {
    const cfg = config({
      endpoints: [
        { name: 'e', baseUrl: 'http://127.0.0.1:1/v1', firstTokenTimeoutMs: 5000 },
        { name: 'f', baseUrl: 'http://127.0.0.1:2/v1' },
      ],
      models: { 'm2@e': { idleTimeoutMs: 7000, timeoutMs: 8000 } },
      llm: { firstTokenTimeoutMs: 1000, prefillMsPerToken: 1, idleTimeoutMs: 3000, timeoutMs: 60_000 },
    });
    const r = routerFor(cfg, [caps('m1', 'e'), caps('m2', 'e'), caps('m3', 'f')]);
    assert.deepEqual(r.timeoutsFor(r.get('m1@e')!, 100), { timeoutMs: 60_000, firstTokenTimeoutMs: 5100, idleTimeoutMs: 3000 });
    assert.deepEqual(r.timeoutsFor(r.get('m2@e')!, 0), { timeoutMs: 8000, firstTokenTimeoutMs: 5000, idleTimeoutMs: 7000 });
    assert.deepEqual(r.timeoutsFor(r.get('m3@f')!, 100_000), { timeoutMs: 60_000, firstTokenTimeoutMs: 60_000, idleTimeoutMs: 3000 }, 'capped by the total');
    const off = routerFor(config({ endpoints: [{ name: 'e', baseUrl: 'http://x/v1' }], llm: { firstTokenTimeoutMs: 0, idleTimeoutMs: 0 } }), [caps('m', 'e')]);
    assert.deepEqual(off.timeoutsFor(off.get('m@e')!, 10), { timeoutMs: 600_000, firstTokenTimeoutMs: undefined, idleTimeoutMs: undefined });
  });

  it('does not retry a hung model; quarantines it so every caller moves on', async () => {
    let hits = 0;
    const s = await mock([
      { id: 'hung', quality: 'good', tools: true, ctx: 32768, handler: () => (hits++, { hangMs: 3000 }) },
      { id: 'alive', quality: 'good', tools: true, ctx: 32768 },
    ]);
    const bus = recordingBus();
    const r = routerFor(config({ endpoints: [{ name: 'e', baseUrl: s.url }], llm: { firstTokenTimeoutMs: 150, prefillMsPerToken: 0 } }), [caps('hung', 'e'), caps('alive', 'e')], bus);
    const t0 = Date.now();
    const a = await r.chat(PING, { prefer: ['hung@e'] });
    assert.equal(a.model, 'alive@e');
    assert.equal(hits, 1, 'no second attempt on the hung model');
    assert.ok(Date.now() - t0 < 2000);
    const b = await r.chat(PING, { prefer: ['hung@e'] });
    assert.equal(b.model, 'alive@e');
    assert.equal(hits, 1, 'quarantined: not even tried again');
    const st = r.stats().find((x) => x.key === 'hung@e')!;
    assert.equal(st.circuitOpen, true);
    assert.equal(st.timeouts, 1);
    assert.ok(bus.types().includes('model.quarantine'));
  });

  it('timeoutRetries and timeoutCooldownMs are configurable', async () => {
    let hits = 0;
    const s = await mock([
      { id: 'hung', quality: 'good', tools: true, ctx: 32768, handler: () => (hits++, { hangMs: 3000 }) },
      { id: 'alive', quality: 'good', tools: true, ctx: 32768 },
    ]);
    const r = routerFor(config({ endpoints: [{ name: 'e', baseUrl: s.url }], llm: { firstTokenTimeoutMs: 100, prefillMsPerToken: 0, timeoutRetries: 1, timeoutCooldownMs: 0 } }), [caps('hung', 'e'), caps('alive', 'e')]);
    await r.chat(PING, { prefer: ['hung@e'], retryBaseMs: 1 });
    assert.equal(hits, 2, 'one retry on the same model');
    assert.equal(r.stats().find((x) => x.key === 'hung@e')!.circuitOpen, false, 'no quarantine when cooldown is 0');
  });

  it('validates the llm section', () => {
    assert.throws(() => validateConfig(parseConfig({ endpoints: [{ name: 'e', baseUrl: 'http://x/v1' }], llm: { idleTimeoutMs: -1 } })), ConfigError);
    assert.throws(() => validateConfig(parseConfig({ endpoints: [{ name: 'e', baseUrl: 'http://x/v1' }], llm: { timeoutMs: 10 } })), /en az 1000/);
    assert.throws(() => validateConfig(parseConfig({ endpoints: [{ name: 'e', baseUrl: 'http://x/v1' }], llm: { timeoutRetries: 'x' } })), /llm\.timeoutRetries/);
    validateConfig(parseConfig({ endpoints: [{ name: 'e', baseUrl: 'http://x/v1' }] }));
  });
});

describe('independent review', () => {
  const cand = (id: string, author: string, authors?: string[]): Candidate => ({ id, author, authors, diff: `+${id}`, summary: 's' });
  const REVIEW = /strict senior code reviewer/;

  it('a single candidate is never reviewed by a model that wrote it, even on fallback', async () => {
    const seen: string[] = [];
    const s = await mock([
      { id: 'author', quality: 'good', tools: true, ctx: 65536, handler: (q) => (REVIEW.test(lastUser(q.messages)) ? (seen.push('author'), { content: '{"ranking":["A"],"scores":{},"issues":{}}' }) : undefined) },
      { id: 'helper', quality: 'good', tools: true, ctx: 65536, handler: (q) => (REVIEW.test(lastUser(q.messages)) ? (seen.push('helper'), { status: 500, error: 'down' }) : undefined) },
      { id: 'other', quality: 'good', tools: true, ctx: 65536, handler: (q) => (REVIEW.test(lastUser(q.messages)) ? (seen.push('other'), { content: '{"ranking":["A"],"scores":{"A":7},"issues":{"A":[{"text":"null deref","priority":1,"confidence":0.9}]}}' }) : undefined) },
    ]);
    const r = routerFor(config({ endpoints: [{ name: 'e', baseUrl: s.url }] }), [caps('author', 'e'), caps('helper', 'e'), caps('other', 'e')]);
    // helper also wrote part of the code (it took over after a failover) – it must not review either
    const v = await councilReview(r, { task: 't', acceptance: [], candidates: [cand('T1', 'author@e', ['author@e', 'helper@e'])], reviewers: 1, contextTokens: 8000 });
    assert.ok(!seen.includes('author') && !seen.includes('helper'));
    assert.deepEqual(v.reviews.map((x) => x.reviewer), ['other@e']);
    assert.equal(v.independent, true);
    assert.equal(v.winnerIssues[0].blocking, true);
  });

  it('skips review (and says so) when only the author is available', async () => {
    let asked = 0;
    const s = await mock([{ id: 'solo', quality: 'good', tools: true, ctx: 65536, handler: () => (asked++, undefined) }]);
    const bus = recordingBus();
    const r = routerFor(config({ endpoints: [{ name: 'e', baseUrl: s.url }] }), [caps('solo', 'e')]);
    const v = await councilReview(r, { task: 't', acceptance: [], candidates: [cand('T1', 'solo@e')], reviewers: 1, contextTokens: 8000, bus });
    assert.equal(asked, 0);
    assert.equal(v.independent, false);
    assert.equal(v.winner?.id, 'T1');
    assert.ok(bus.ofType('log.warn').some((e) => /bağımsız gözden geçiren yok/.test(e.message ?? '')));
  });

  it('ignores votes a reviewer gives to its own candidate', async () => {
    const s = await mock(
      ['ma', 'mb'].map((id) => ({
        id,
        quality: 'good' as const,
        tools: true,
        ctx: 65536,
        // both reviewers rank the candidate written by "ma" first
        handler: (q: { messages: Array<{ role: string; content: string | null }> }) => {
          const p = lastUser(q.messages);
          const labels = [...p.matchAll(/<candidate id="([A-J])">[\s\S]*?\+(\w+)/g)].map((m) => ({ label: m[1], id: m[2] }));
          const order = [...labels].sort((a) => (a.id === 'X' ? -1 : 1)).map((l) => l.label);
          return { content: JSON.stringify({ ranking: order, scores: {}, issues: {} }) };
        },
      })),
    );
    const r = routerFor(config({ endpoints: [{ name: 'e', baseUrl: s.url }] }), [caps('ma', 'e'), caps('mb', 'e')]);
    const v = await councilReview(r, { task: 't', acceptance: [], candidates: [cand('X', 'ma@e'), cand('Y', 'mb@e')], reviewers: 2, contextTokens: 8000 });
    assert.equal(v.reviews.length, 2);
    const pts = Object.fromEntries(v.ranking.map((x) => [x.id, x.points]));
    assert.equal(pts.X, pts.Y, "ma's vote for its own X is dropped, leaving one vote each");
    assert.equal(v.independent, false, 'an author reviewed (another candidate) – not fully independent');
  });
});

describe('transcript conversion on failover', () => {
  it('turns native tool calls into the text protocol', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      {
        role: 'assistant',
        content: 'looking',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.c"}' } },
          { id: 'c2', type: 'function', function: { name: 'list_dir', arguments: 'not json' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'int a;' },
      { role: 'tool', tool_call_id: 'c2', content: 'a.c' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c3', type: 'function', function: { name: 'finish', arguments: '' } }] },
      { role: 'tool', tool_call_id: 'zz', content: 'orphan' },
    ];
    const out = toTextProtocol(msgs);
    assert.ok(out.every((m) => m.role !== 'tool' && !m.tool_calls));
    assert.equal(out[2].content, 'looking\n<tool_call>\n{"name":"read_file","arguments":{"path":"a.c"}}\n</tool_call>\n<tool_call>\n{"name":"list_dir","arguments":{"raw":"not json"}}\n</tool_call>');
    assert.equal(out[3].role, 'user');
    assert.equal(out[3].content, '<tool_result name="read_file">\nint a;\n</tool_result>\n<tool_result name="list_dir">\na.c\n</tool_result>');
    assert.match(out[4].content!, /^<tool_call>\n\{"name":"finish","arguments":\{\}\}/);
    assert.match(out[5].content!, /<tool_result name="tool">\norphan/);
  });
});
