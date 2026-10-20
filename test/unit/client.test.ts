import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { after, describe, it } from 'node:test';
import { OpenAICompatClient, toLlmError } from '../../src/llm/client.js';
import { LlmError } from '../../src/llm/types.js';
import { startMockServer, type MockServerHandle } from '../../src/mock/server.js';

const servers: MockServerHandle[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

function client(baseUrl: string, apiKey?: string, headers?: Record<string, string>) {
  return new OpenAICompatClient({ name: 't', baseUrl, apiKey, headers });
}

describe('OpenAICompatClient', () => {
  it('parses a non-streaming response with reasoning and tool calls', async () => {
    const s = await startMockServer([
      { id: 'ns', quality: 'good', tools: true, ctx: 8192, noStream: true, handler: () => ({ toolCall: { name: 'read_file', args: { path: 'a.c' } } }) },
    ]);
    servers.push(s);
    const r = await client(s.url).chat('ns', { messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'read_file', description: '', parameters: {} } }] });
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].function.name, 'read_file');
    assert.deepEqual(JSON.parse(r.toolCalls[0].function.arguments), { path: 'a.c' });
    assert.equal(r.finishReason, 'tool_calls');
    assert.equal(r.model, 'ns@t');
  });

  it('strips <think> blocks from streamed content into thinking', async () => {
    const s = await startMockServer([{ id: 'th', quality: 'good', tools: true, ctx: 8192, thinks: true }]);
    servers.push(s);
    const tokens: string[] = [];
    const r = await client(s.url).chat('th', { messages: [{ role: 'user', content: 'Reply with exactly the word PONG and nothing else.' }], onToken: (t) => tokens.push(t) });
    assert.equal(r.content, 'PONG');
    assert.match(r.thinking, /reasoning/);
    assert.ok(tokens.length > 1, 'tokens are streamed incrementally');
    assert.ok(r.ttftMs >= 0 && r.durationMs >= r.ttftMs);
  });

  it('ignores malformed SSE lines and estimates usage when the server omits it', async () => {
    const raw = ['data: {"choices":[{"delta":{"content":"Hello "}}]}', 'data: {not json', ': keep-alive comment', 'data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}', 'data: [DONE]', ''].join('\n');
    const s = await startMockServer([{ id: 'raw', quality: 'good', tools: true, ctx: 8192, handler: () => ({ raw }) }]);
    servers.push(s);
    const r = await client(s.url).chat('raw', { messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.content, 'Hello world');
    assert.ok(r.usage.completionTokens > 0);
    assert.equal(r.usage.promptTokens, 0);
  });

  it('turns an in-stream error object into a server error', async () => {
    const raw = 'data: {"error":{"message":"CUDA out of memory"}}\n\n';
    const s = await startMockServer([{ id: 'oom', quality: 'good', tools: true, ctx: 8192, handler: () => ({ raw }) }]);
    servers.push(s);
    await assert.rejects(client(s.url).chat('oom', { messages: [{ role: 'user', content: 'x' }] }), (e: unknown) => e instanceof LlmError && e.kind === 'server' && /CUDA/.test(e.message));
  });

  it('classifies HTTP errors', async () => {
    const s = await startMockServer([
      { id: 'r429', quality: 'good', tools: true, ctx: 8192, handler: () => ({ status: 429, error: 'slow down' }) },
      { id: 'ctx', quality: 'good', tools: true, ctx: 10 },
    ]);
    servers.push(s);
    const c = client(s.url);
    await assert.rejects(c.chat('r429', { messages: [{ role: 'user', content: 'x' }] }), (e: unknown) => e instanceof LlmError && e.kind === 'rate_limit' && e.retryable);
    await assert.rejects(c.chat('ctx', { messages: [{ role: 'user', content: 'a long prompt that exceeds the tiny window' }] }), (e: unknown) => e instanceof LlmError && e.kind === 'context_length' && !e.retryable);
    await assert.rejects(c.chat('missing', { messages: [{ role: 'user', content: 'x' }] }), (e: unknown) => e instanceof LlmError && e.kind === 'not_found');
  });

  it('reports connection failures as network errors', async () => {
    await assert.rejects(client('http://127.0.0.1:9/v1').chat('m', { messages: [{ role: 'user', content: 'x' }], timeoutMs: 3000 }), (e: unknown) => e instanceof LlmError && (e.kind === 'network' || e.kind === 'timeout') && e.retryable);
    assert.equal(toLlmError(new Error('The operation was aborted due to timeout'), 'm').kind, 'timeout');
  });

  it('sends auth and custom headers, omits auth for apiKey "none", and lists models with context windows', async () => {
    const seen: IncomingHttpHeaders[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'vllm-model', max_model_len: 32768 }, { id: 'lmstudio-model', max_context_length: '16384' }, { id: 'llamacpp', meta: { n_ctx_train: 4096 } }, { name: 'ollama-style' }] }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const models = await client(`http://127.0.0.1:${port}/v1`, 'sk-123', { 'x-team': 'kurultay' }).listModels();
      assert.deepEqual(models, [
        { id: 'vllm-model', contextWindow: 32768 },
        { id: 'lmstudio-model', contextWindow: 16384 },
        { id: 'llamacpp', contextWindow: 4096 },
        { id: 'ollama-style', contextWindow: undefined },
      ]);
      assert.equal(seen[0].authorization, 'Bearer sk-123');
      assert.equal(seen[0]['x-team'], 'kurultay');
      await client(`http://127.0.0.1:${port}/v1`, 'none').listModels();
      assert.equal(seen[1].authorization, undefined);
    } finally {
      server.close();
    }
  });

  it('sends sampling options, json mode, stop words and extra body fields', async () => {
    const s = await startMockServer([{ id: 'opts', quality: 'good', tools: true, ctx: 8192 }]);
    servers.push(s);
    await client(s.url).chat('opts', { messages: [{ role: 'user', content: 'x' }], temperature: 0.3, maxTokens: 77, jsonMode: true, stop: ['END'], stream: false }, { top_k: 20 });
    const body = s.log[s.log.length - 1].body;
    assert.equal(body.temperature, 0.3);
    assert.equal(body.max_tokens, 77);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.deepEqual(body.stop, ['END']);
    assert.equal(body.top_k, 20);
    assert.equal(body.stream, false);
    assert.equal(body.tools, undefined, 'no empty tools array is sent');
  });
});
