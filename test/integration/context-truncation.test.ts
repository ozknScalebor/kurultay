import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Materializer } from '../../src/agent/workspace.js';
import { ProjectIndex } from '../../src/index/project-index.js';
import { startMockServer, type MockModel, type MockServerHandle } from '../../src/mock/server.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { caps, config, isAgent, lastUser, recordingBus, routerFor, tmpProject } from '../helpers.js';

const servers: MockServerHandle[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});
async function mock(models: MockModel[]) {
  const s = await startMockServer(models);
  servers.push(s);
  return s;
}

describe('truncated answers (finish_reason = length)', () => {
  it('retries structured answers once with a larger budget', async () => {
    const s = await mock([{ id: 'm', quality: 'good', tools: true, ctx: 65536, handler: (q) => (Number(q.body.max_tokens) < 1000 ? { content: '{"plan": [1, 2', finish: 'length' } : { content: '{"plan":[1,2,3]}' }) }]);
    const bus = recordingBus();
    const r = routerFor(config({ endpoints: [{ name: 'e', baseUrl: s.url }] }), [caps('m', 'e', { maxOutputTokens: 4096 })], bus);
    const res = await r.chat({ messages: [{ role: 'user', content: 'plan' }], jsonMode: true, maxTokens: 600 });
    assert.equal(res.content, '{"plan":[1,2,3]}');
    assert.deepEqual(s.log.map((l) => l.body.max_tokens), [600, 1200]);
    assert.ok(bus.types().includes('llm.truncated'));
    assert.ok(res.usage.completionTokens > 0);
  });

  it('continues plain text answers and joins the parts', async () => {
    const s = await mock([
      {
        id: 'm',
        quality: 'good',
        tools: true,
        ctx: 65536,
        handler: (q) => {
          const sofar = q.messages.find((m) => m.role === 'assistant')?.content ?? '';
          return !sofar ? { content: 'Birinci kısım;', finish: 'length' } : !sofar.includes('ikinci') ? { content: 'ikinci kısım;', finish: 'length' } : { content: 'son.' };
        },
      },
    ]);
    const r = routerFor(config({ endpoints: [{ name: 'e', baseUrl: s.url }] }), [caps('m', 'e')]);
    const res = await r.chat({ messages: [{ role: 'user', content: 'anlat' }], maxTokens: 300 });
    assert.equal(res.content, 'Birinci kısım;ikinci kısım;son.');
    assert.equal(res.finishReason, 'stop');
    assert.equal(s.log.length, 3);
    assert.match(lastUser(s.log[1].body.messages as Array<{ role: string; content: string }>), /Continue exactly where you stopped/);
  });

  it('keeps the partial answer when there is no room to grow or the follow-up fails', async () => {
    let calls = 0;
    const s = await mock([
      {
        id: 'm',
        quality: 'good',
        tools: true,
        ctx: 3000,
        handler: (q) => {
          calls++;
          // the continuation request (it carries the partial answer) fails
          return q.messages.some((m) => m.role === 'assistant') ? { status: 400, error: 'boom' } : { content: '{"x":', finish: 'length' };
        },
      },
    ]);
    const r = routerFor(config({ endpoints: [{ name: 'e', baseUrl: s.url }] }), [caps('m', 'e', { contextWindow: 3000 })]);
    const atCeiling = await r.chat({ messages: [{ role: 'user', content: 'x' }], jsonMode: true, maxTokens: 2600 });
    assert.equal(atCeiling.content, '{"x":', 'no larger budget fits the window');
    assert.equal(calls, 1);
    const failed = await r.chat({ messages: [{ role: 'user', content: 'y' }], maxTokens: 100 });
    assert.equal(failed.content, '{"x":', 'continuation failed → partial kept');
  });

  it('gives reasoning models a larger default output budget', async () => {
    const s = await mock([
      { id: 'think', quality: 'good', tools: true, ctx: 65536 },
      { id: 'plain', quality: 'good', tools: true, ctx: 65536 },
    ]);
    const r = routerFor(config({ endpoints: [{ name: 'e', baseUrl: s.url }] }), [caps('think', 'e', { thinking: true, maxOutputTokens: 4096 }), caps('plain', 'e', { maxOutputTokens: 4096 })]);
    await r.chat({ messages: [{ role: 'user', content: 'Reply with exactly the word PONG and nothing else.' }] }, { only: ['think@e'] });
    await r.chat({ messages: [{ role: 'user', content: 'Reply with exactly the word PONG and nothing else.' }] }, { only: ['plain@e'] });
    assert.deepEqual(s.log.map((l) => [l.model, l.body.max_tokens]), [
      ['think', 8192],
      ['plain', 4096],
    ]);
  });
});

describe('per-model context budget', () => {
  it('a small model in the fleet does not shrink the context of large ones', async () => {
    const arch = Array.from({ length: 2000 }, (_, i) => `- Mimari not ${i}: modül ${i} sürücü katmanına bağlıdır.`).join('\n');
    const root = tmpProject({ 'src/a.c': 'int a = 1;\n', '.kurultay/ARCHITECTURE.md': `# Mimari\n${arch}` });
    const seen: Record<string, number> = {};
    const handler = (id: string) => (q: { messages: Array<{ role: string; content: string | null }> }) => {
      if (isAgent(q.messages)) {
        const first = q.messages.find((m) => m.role === 'user')?.content ?? '';
        seen[id] ??= first.length;
        return { toolCall: { name: 'finish', args: { summary: 'ok' } } };
      }
      if (/planner of a team/.test(lastUser(q.messages))) return { content: JSON.stringify({ subtasks: [{ id: 'T1', title: 't', description: 'd' }] }) };
      return undefined;
    };
    const s = await mock([
      { id: 'big', quality: 'good', tools: true, ctx: 131072, handler: handler('big') },
      { id: 'tiny', quality: 'good', tools: true, ctx: 8192, handler: handler('tiny') },
    ]);
    const cfg = config({ endpoints: [{ name: 'e', baseUrl: s.url }], orchestrator: { maxIterations: 1 } });
    const router = routerFor(cfg, [caps('big', 'e', { contextWindow: 131072 }), caps('tiny', 'e', { contextWindow: 8192 })]);
    const index = new ProjectIndex(root, join(root, '.kurultay'));
    index.build();
    await new Orchestrator(root, cfg, router, new Materializer(root, join(root, '.kurultay')), index, recordingBus()).run('change a', { mode: 'race', dryRun: true });
    assert.ok(seen.big && seen.tiny, JSON.stringify(seen));
    assert.ok(seen.big > seen.tiny * 4, `big model got a much larger context (${seen.big} vs ${seen.tiny} chars)`);
  });
});
