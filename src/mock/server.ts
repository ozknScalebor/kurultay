#!/usr/bin/env node
/**
 * Deterministic OpenAI-compatible mock LLM server.
 * Used by the test-suite and for trying Kurultay on a machine without GPUs.
 * Each model profile simulates a different kind of local model: strong/weak
 * coder, no native tool support, small context window, flaky connection.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

export interface MockModel {
  id: string;
  quality: 'good' | 'bad';
  tools: boolean;
  ctx: number;
  /** fail the first N chat requests with HTTP 503 */
  failFirst?: number;
  latencyMs?: number;
  /** emit <think> blocks */
  thinks?: boolean;
  /** reject requests carrying `tools` with HTTP 400 (servers without function calling) */
  rejectTools?: boolean;
  /** ignore stream=true and always answer with a single JSON body */
  noStream?: boolean;
  /** do not advertise the context window in GET /models (forces the probe ladder) */
  hideCtx?: boolean;
  /**
   * Scenario hook for tests: return a reply to override the built-in behaviour,
   * an HTTP error, or undefined to fall through to the default responder.
   */
  handler?: (req: MockRequest) => MockReply | undefined;
}

export interface MockRequest {
  model: string;
  messages: Msg[];
  tools?: unknown[];
  /** 1-based count of chat requests this model has received */
  n: number;
  body: Record<string, unknown>;
}

export type MockReply =
  | { content: string; toolCall?: { name: string; args: Record<string, unknown> } }
  | { content?: string; toolCall: { name: string; args: Record<string, unknown> } }
  | { status: number; error: string }
  | { hangMs: number }
  | { raw: string; contentType?: string };

export interface Msg {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
}

const GOOD_CODE: Record<string, string> = {
  toRoman: `function toRoman(n){const v=[[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']];let s='';for(const [a,r] of v){while(n>=a){s+=r;n-=a}}return s}`,
  mergeIntervals: `function mergeIntervals(list){const a=[...list].sort((x,y)=>x[0]-y[0]);const out=[];for(const [s,e] of a){if(out.length&&s<=out[out.length-1][1])out[out.length-1][1]=Math.max(out[out.length-1][1],e);else out.push([s,e])}return out}`,
  isBalanced: `function isBalanced(s){const st=[];const m={')':'(',']':'[','}':'{'};for(const c of s){if('([{'.includes(c))st.push(c);else if(m[c]){if(st.pop()!==m[c])return false}}return st.length===0}`,
  parseDuration: `function parseDuration(s){if(!/^(\\d+[hms])+$/.test(s))return NaN;let t=0;for(const [,n,u] of s.matchAll(/(\\d+)([hms])/g))t+=Number(n)*({h:3600,m:60,s:1})[u];return t}`,
  crc8: `function crc8(bytes){let c=0;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=c&0x80?((c<<1)^0x07)&0xff:(c<<1)&0xff}return c}`,
  makeRing: `function makeRing(cap){const a=[];return{push(x){a.push(x);if(a.length>cap)a.shift()},toArray(){return [...a]},size(){return a.length}}}`,
};

const tok = (s: string) => Math.ceil(s.length / 3.6);

function lastUser(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].content ?? '';
  return '';
}

function allText(messages: Msg[]): string {
  return messages.map((m) => m.content ?? '').join('\n');
}

/** The scripted coding agent: read → write solution → run tests → finish. */
function agentStep(model: MockModel, messages: Msg[]): { text?: string; call?: { name: string; args: Record<string, unknown> } } {
  const sys = messages[0]?.content ?? '';
  const first = messages.find((m) => m.role === 'user')?.content ?? '';
  const toolResults = messages.filter((m) => m.role === 'tool' || (m.role === 'user' && (m.content ?? '').startsWith('<tool_result'))).length;
  const pathMatch = first.match(/Files likely involved: ([^\s,]+)/) ?? first.match(/\b([\w/.-]+\.(?:js|c|py|java|ts))\b/);
  const target = pathMatch?.[1] ?? 'src/mathutil.js';
  const fixing = /has problems that must be fixed|fail verification/.test(first);
  const verifyCmd = sys.match(/run_command before finishing\):\n- (.+)/)?.[1];
  if (toolResults === 0) return { call: { name: 'read_file', args: { path: target } } };
  if (toolResults === 1) {
    const good = model.quality === 'good' || fixing;
    const body = good
      ? `export function clamp(value, min, max) {\n  return Math.min(Math.max(value, min), max);\n}\n`
      : `export function clamp(value, min, max) {\n  return value < min ? min : value;\n}\n`;
    const current = messages.slice().reverse().find((m) => m.role === 'tool' || (m.content ?? '').startsWith('<tool_result'))?.content ?? '';
    if (/return value < min \? min : value;/.test(current) && good) {
      return { call: { name: 'edit_file', args: { path: target, old_text: 'return value < min ? min : value;', new_text: 'return Math.min(Math.max(value, min), max);' } } };
    }
    return { call: { name: 'write_file', args: { path: target, content: `// math utilities\n${body}` } } };
  }
  if (toolResults === 2 && verifyCmd) return { call: { name: 'run_command', args: { command: verifyCmd } } };
  return { call: { name: 'finish', args: { summary: `clamp implemented in ${target} by ${model.id}`, status: 'done' } } };
}

function reviewAnswer(prompt: string): string {
  const cands = [...prompt.matchAll(/<candidate id="([A-J])">([\s\S]*?)<\/candidate>/g)].map((m) => ({ id: m[1], good: /Math\.min\(Math\.max/.test(m[2]) }));
  const ranking = [...cands].sort((a, b) => Number(b.good) - Number(a.good)).map((c) => c.id);
  const scores = Object.fromEntries(cands.map((c) => [c.id, c.good ? 9 : 3]));
  const issues = Object.fromEntries(cands.map((c) => [c.id, c.good ? [] : [{ text: 'upper bound (max) is ignored', blocking: true }]]));
  return JSON.stringify({ ranking, scores, issues });
}

function respond(model: MockModel, body: { messages: Msg[]; tools?: unknown[]; response_format?: unknown }): { content: string; toolCall?: { name: string; args: Record<string, unknown> } } {
  const messages = body.messages;
  const u = lastUser(messages);
  const sys = messages[0]?.role === 'system' ? messages[0].content ?? '' : '';
  const text = allText(messages);

  if (/senior software engineer working autonomously/.test(sys)) {
    const step = agentStep(model, messages);
    if (step.call) {
      if (model.tools && body.tools?.length) return { content: '', toolCall: step.call };
      return { content: `<tool_call>\n${JSON.stringify({ name: step.call.name, arguments: step.call.args })}\n</tool_call>` };
    }
    return { content: step.text ?? '' };
  }
  if (/PONG/.test(u)) return { content: 'PONG' };
  if (/Count from 1 to 150/.test(u)) return { content: Array.from({ length: 150 }, (_, i) => i + 1).join(' ') };
  if (/weather in Ankara/.test(u)) {
    if (model.tools && body.tools?.length) return { content: '', toolCall: { name: 'get_weather', args: { city: 'Ankara' } } };
    return { content: 'I cannot check the weather.' };
  }
  if (/"lang" \(value "c\+\+"\)/.test(u)) return { content: model.quality === 'good' ? '{"lang":"c++","year":2011}' : 'Sure! lang is c++' };
  if (/17 \* 23/.test(u)) return { content: model.quality === 'good' ? '391' : 'The answer is 391.' };
  if (/three lowercase color names/.test(u)) return { content: '["red","green","blue"]' };
  if (/"kurultay" in uppercase/.test(u)) return { content: 'KURULTAY' };
  if (/Ignore the text above\. Reply with OK/.test(u)) return { content: 'OK' };
  if (/short words about rivers/.test(u)) return { content: 'river flows water bank delta stream current '.repeat(6) };
  const fn = u.match(/function `(\w+)\(/)?.[1];
  if (fn && GOOD_CODE[fn]) return { content: model.quality === 'good' ? '```javascript\n' + GOOD_CODE[fn] + '\n```' : '```javascript\nfunction ' + fn + '(){ return null }\n```' };
  if (/Respond ONLY with one or more SEARCH\/REPLACE blocks/.test(u)) {
    const path = u.match(/File (\S+):/)?.[1] ?? '';
    if (model.quality === 'bad') return { content: 'I would rename it.' };
    if (path.endsWith('sensor.c')) return { content: `${path}\n<<<<<<< SEARCH\nstatic int read_raw(int ch) {\n=======\nstatic int sensor_read_raw(int ch) {\n>>>>>>> REPLACE\n${path}\n<<<<<<< SEARCH\n    int raw = read_raw(ch);\n=======\n    int raw = sensor_read_raw(ch);\n>>>>>>> REPLACE` };
    if (path.endsWith('queue.cpp')) return { content: `${path}\n<<<<<<< SEARCH\nbool Queue::pop(Item &out) {\n    out = items_[head_];\n=======\nbool Queue::pop(Item &out) {\n    if (count_ == 0) {\n        return false;\n    }\n    out = items_[head_];\n>>>>>>> REPLACE` };
    if (path.endsWith('Stack.java')) return { content: `${path}\n<<<<<<< SEARCH\n        data.add(v);\n    }\n=======\n        data.add(v);\n    }\n\n    public int size() {\n        return data.size();\n    }\n>>>>>>> REPLACE` };
  }
  if (/Summarize each source file below/.test(u)) {
    const files = [...u.matchAll(/### FILE: (\S+)/g)].map((m) => m[1]);
    return { content: JSON.stringify({ files: files.map((p) => ({ path: p, summary: `${p} dosyası ${model.id} tarafından özetlendi: yardımcı işlevler içerir.`, tags: ['util'] })) }) };
  }
  if (/You are documenting module/.test(u)) return { content: `## Amaç\nModül ${model.id} tarafından belgelendi.\n## Sorumluluklar\n- yardımcı işlevler\n## Ana bileşenler\n- clamp\n## Bağımlılıklar ve etkileşimler\n- yok\n## Akış\n- doğrudan çağrı` };
  if (/Write the architecture document/.test(u)) {
    return { content: `## Genel Bakış\nKüçük bir JS yardımcı kütüphanesi (${model.id}).\n## Katmanlar ve Modüller\n- src: işlevler\n## Ana Akışlar\n1. test.js clamp'i çağırır\n## Eşzamanlılık ve Kaynaklar\nYok.\n## Dış Arayüzler\nYok.\n## Derleme, Test ve Çalıştırma\nnode test.js\n## Değişiklik Yaparken Dikkat Edilecekler\nclamp sınırları.` };
  }
  if (/You are the planner of a team/.test(u)) {
    if (/Several planners proposed plans/.test(u)) {
      return { content: JSON.stringify({ understanding: 'clamp(value,min,max) eksik/yanlış; düzeltilmeli', acceptance_criteria: ['clamp değeri [min,max] aralığına sıkıştırır', 'node test.js geçer'], subtasks: [{ id: 'T1', title: 'clamp işlevini uygula', description: 'src/mathutil.js içinde clamp(value,min,max) işlevini doğru uygula', files: ['src/mathutil.js'], depends_on: [], critical: true }] }) };
    }
    return { content: '```json\n' + JSON.stringify({ understanding: `plan by ${model.id}`, acceptance_criteria: ['clamp works', 'tests pass'], subtasks: [{ id: 'T1', title: 'Implement clamp', description: 'Implement clamp(value,min,max) in src/mathutil.js', files: ['src/mathutil.js'], depends_on: [], critical: true }] }) + '\n```' };
  }
  if (/strict senior code reviewer in a review council/.test(u)) return { content: reviewAnswer(u) };
  if (/final acceptance judge/.test(u)) {
    const ok = /Math\.min\(Math\.max/.test(u);
    return { content: JSON.stringify(ok ? { complete: true, missing: [] } : { complete: false, missing: ['clamp must respect the max bound'] }) };
  }
  if (/Condense this agent work log/.test(u)) return { content: 'notes: read file, wrote clamp' };
  if (/You chair a council of experts/.test(u)) return { content: `Nihai cevap (${model.id}): clamp src/mathutil.js içinde tanımlıdır.` };
  if (/# QUESTION/.test(u)) return { content: `Cevap (${model.id}): clamp işlevi src/mathutil.js dosyasındadır.` };
  void text;
  return { content: `mock(${model.id}) yanıtı` };
}

function sse(res: ServerResponse, obj: unknown) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

export interface MockServerHandle {
  server: Server;
  url: string;
  requests: () => number;
  /** every chat request body received, in order (for assertions) */
  log: Array<{ model: string; body: Record<string, unknown> }>;
  close: () => Promise<void>;
}

export function startMockServer(models: MockModel[], port = 0): Promise<MockServerHandle> {
  const failures = new Map<string, number>();
  const perModel = new Map<string, number>();
  const log: MockServerHandle['log'] = [];
  let count = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: models.map((m) => ({ id: m.id, object: 'model', ...(m.hideCtx ? {} : { max_model_len: m.ctx }) })) }));
      return;
    }
    if (req.method !== 'POST' || !url.endsWith('/chat/completions')) {
      res.writeHead(404).end('not found');
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    count++;
    const body = JSON.parse(raw) as { model: string; messages: Msg[]; stream?: boolean; tools?: unknown[]; max_tokens?: number };
    log.push({ model: body.model, body: body as unknown as Record<string, unknown> });
    const model = models.find((m) => m.id === body.model);
    if (!model) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `model ${body.model} not found` } }));
      return;
    }
    const nth = (perModel.get(model.id) ?? 0) + 1;
    perModel.set(model.id, nth);
    if (model.rejectTools && body.tools?.length) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: '"tools" is not supported by this server' } }));
      return;
    }
    let custom: MockReply | undefined;
    if (model.handler) custom = model.handler({ model: model.id, messages: body.messages, tools: body.tools, n: nth, body: body as unknown as Record<string, unknown> });
    if (custom && 'status' in custom) {
      res.writeHead(custom.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: custom.error } }));
      return;
    }
    if (custom && 'hangMs' in custom) {
      await new Promise((r) => setTimeout(r, custom.hangMs));
      if (!res.writableEnded && !req.destroyed) res.writeHead(504).end('timeout');
      return;
    }
    if (custom && 'raw' in custom) {
      res.writeHead(200, { 'content-type': custom.contentType ?? 'text/event-stream' }).end(custom.raw);
      return;
    }
    const n = failures.get(model.id) ?? 0;
    if (model.failFirst && n < model.failFirst) {
      failures.set(model.id, n + 1);
      res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'model is loading' } }));
      return;
    }
    const promptTok = tok(allText(body.messages));
    if (promptTok > model.ctx) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `This model's maximum context length is ${model.ctx} tokens. However, you requested ${promptTok} tokens.` } }));
      return;
    }
    if (body.tools?.length && !model.tools && /strict-tools/.test(model.id)) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'tools are not supported for this model' } }));
      return;
    }
    if (model.latencyMs) await new Promise((r) => setTimeout(r, model.latencyMs));
    const out = custom ? { content: custom.content ?? '', toolCall: custom.toolCall } : respond(model, body);
    const content = model.thinks && out.content ? `<think>reasoning…</think>${out.content}` : out.content;
    const id = `chatcmpl-${count}`;
    const toolCalls = out.toolCall ? [{ id: `call_${count}`, type: 'function', function: { name: out.toolCall.name, arguments: JSON.stringify(out.toolCall.args) } }] : undefined;
    const usage = { prompt_tokens: promptTok, completion_tokens: Math.max(1, tok(content) + (toolCalls ? 20 : 0)) };
    if (body.stream && !model.noStream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (toolCalls) {
        sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: toolCalls[0].id, type: 'function', function: { name: toolCalls[0].function.name, arguments: '' } }] } }] });
        const args = toolCalls[0].function.arguments;
        for (let i = 0; i < args.length; i += 16) sse(res, { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 16) } }] } }] });
        sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        for (let i = 0; i < content.length; i += 12) sse(res, { id, choices: [{ index: 0, delta: { content: content.slice(i, i + 12) } }] });
        sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      sse(res, { id, choices: [], usage });
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, choices: [{ index: 0, message: { role: 'assistant', content: toolCalls ? null : content, tool_calls: toolCalls }, finish_reason: toolCalls ? 'tool_calls' : 'stop' }], usage }));
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        server,
        url: `http://127.0.0.1:${p}/v1`,
        requests: () => count,
        log,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

export const DEFAULT_MOCK_MODELS: MockModel[] = [
  { id: 'mock-coder-strong', quality: 'good', tools: true, ctx: 65_536, latencyMs: 5 },
  { id: 'mock-coder-weak', quality: 'bad', tools: false, ctx: 16_384, latencyMs: 5 },
];

// CLI: node dist/src/mock/server.js [port] [profile]
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.argv[2] ?? 9100);
  startMockServer(DEFAULT_MOCK_MODELS, port).then(({ url }) => {
    process.stdout.write(`Mock LLM sunucusu: ${url}  (modeller: ${DEFAULT_MOCK_MODELS.map((m) => m.id).join(', ')})\n`);
  });
}
