import type { EndpointConfig } from '../config.js';
import { withTimeout } from '../util/async.js';
import { stripThinking } from '../util/text.js';
import { LlmError, type ChatRequest, type ChatResult, type ToolCall } from './types.js';

/**
 * Dependency-free client for OpenAI-compatible /chat/completions endpoints
 * (vLLM, llama.cpp server, Ollama, LM Studio, TGI, LiteLLM, SGLang ...).
 */
/** Client for one model: its own apiKey (config.models["model@endpoint"].apiKey) wins over the endpoint's. */
export function clientFor(ep: EndpointConfig, override?: { apiKey?: string }): OpenAICompatClient {
  return new OpenAICompatClient(override?.apiKey ? { ...ep, apiKey: override.apiKey } : ep);
}

export class OpenAICompatClient {
  constructor(readonly endpoint: EndpointConfig) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...(this.endpoint.headers ?? {}) };
    if (this.endpoint.apiKey && this.endpoint.apiKey !== 'none') h.authorization = `Bearer ${this.endpoint.apiKey}`;
    return h;
  }

  async listModels(signal?: AbortSignal): Promise<Array<{ id: string; contextWindow?: number }>> {
    const t = withTimeout(signal, 30_000);
    try {
      const res = await fetch(`${this.endpoint.baseUrl}/models`, { headers: this.headers(), signal: t.signal });
      if (!res.ok) throw classifyHttp(res.status, await safeText(res), `${this.endpoint.name}/models`);
      const body = (await res.json()) as { data?: Array<Record<string, unknown>>; models?: Array<Record<string, unknown>> };
      const items = body.data ?? body.models ?? [];
      return items
        .map((m) => ({
          id: String(m.id ?? m.name ?? m.model ?? ''),
          // vLLM: max_model_len, llama.cpp: meta.n_ctx_train, LM Studio: max_context_length
          contextWindow: num(m.max_model_len) ?? num(m.context_length) ?? num(m.max_context_length) ?? num((m.meta as Record<string, unknown> | undefined)?.n_ctx_train),
        }))
        .filter((m) => m.id);
    } catch (e) {
      throw toLlmError(e, `${this.endpoint.name}/models`);
    } finally {
      t.dispose();
    }
  }

  /** OpenAI-compatible POST /embeddings (vLLM, llama.cpp --embedding, Ollama, LM Studio, TEI). */
  async embed(model: string, input: string[], signal?: AbortSignal, timeoutMs = 120_000): Promise<number[][]> {
    const t = withTimeout(signal, timeoutMs);
    try {
      const res = await fetch(`${this.endpoint.baseUrl}/embeddings`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ model, input }), signal: t.signal });
      if (!res.ok) throw classifyHttp(res.status, await safeText(res), `${model}@${this.endpoint.name}/embeddings`);
      const body = (await res.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
      const data = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (data.length !== input.length || data.some((d) => !Array.isArray(d.embedding))) throw new LlmError(`unexpected embeddings response (${data.length}/${input.length})`, 'server', undefined, model);
      return data.map((d) => d.embedding!);
    } catch (e) {
      throw toLlmError(e, `${model}@${this.endpoint.name}/embeddings`);
    } finally {
      t.dispose();
    }
  }

  async chat(model: string, req: ChatRequest, extraBody?: Record<string, unknown>): Promise<ChatResult> {
    const modelKey = `${model}@${this.endpoint.name}`;
    const stream = req.stream !== false;
    const body: Record<string, unknown> = {
      model,
      messages: req.messages,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      ...(req.stop?.length ? { stop: req.stop } : {}),
      ...(req.tools?.length ? { tools: req.tools, tool_choice: req.toolChoice ?? 'auto' } : {}),
      ...(req.jsonSchema
        ? { response_format: { type: 'json_schema', json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: false } } }
        : req.jsonMode
          ? { response_format: { type: 'json_object' } }
          : {}),
      ...(extraBody ?? {}),
    };
    const started = Date.now();
    const t = new Watchdog(req.signal, {
      totalMs: req.timeoutMs ?? this.endpoint.timeoutMs ?? 10 * 60_000,
      // first-token / idle watchdogs only make sense for streamed responses
      firstTokenMs: stream ? req.firstTokenTimeoutMs : undefined,
      idleMs: stream ? req.idleTimeoutMs : undefined,
    });
    try {
      const res = await fetch(`${this.endpoint.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: t.signal,
      });
      if (!res.ok) throw classifyHttp(res.status, await safeText(res), modelKey, res.headers.get('retry-after'));
      const ctype = res.headers.get('content-type') ?? '';
      if (stream && ctype.includes('text/event-stream') && res.body) {
        return await readStream(res.body, started, modelKey, req.onToken, () => t.activity());
      }
      t.activity();
      // non-streaming (or server ignored stream=true)
      const json = (await res.json()) as OpenAIResponse;
      return fromNonStream(json, started, modelKey, req.onToken);
    } catch (e) {
      if (req.signal?.aborted) throw new LlmError('aborted', 'aborted', undefined, modelKey);
      if (t.fired) throw new LlmError(`timeout (${modelKey}): ${t.fired}`, 'timeout', undefined, modelKey);
      throw toLlmError(e, modelKey);
    } finally {
      t.dispose();
    }
  }
}

/**
 * Request watchdog with three clocks (Codex stream_idle_timeout, OpenCode chunkTimeout):
 *  - total: hard limit for the whole request
 *  - first token: the model must start answering (any SSE data) within this time
 *  - idle: once streaming, the gap between chunks may not exceed this
 * A hung local model therefore fails in minutes instead of after the total limit.
 */
export class Watchdog {
  private readonly ctrl = new AbortController();
  private readonly timers: { total?: NodeJS.Timeout; first?: NodeJS.Timeout; idle?: NodeJS.Timeout } = {};
  private readonly onAbort: () => void;
  private started = false;
  /** human readable reason when a watchdog clock fired */
  fired = '';

  constructor(
    private readonly parent: AbortSignal | undefined,
    private readonly o: { totalMs: number; firstTokenMs?: number; idleMs?: number },
  ) {
    this.onAbort = () => this.ctrl.abort(parent?.reason ?? new Error('aborted'));
    if (parent) {
      if (parent.aborted) this.ctrl.abort(parent.reason);
      else parent.addEventListener('abort', this.onAbort, { once: true });
    }
    this.timers.total = setTimeout(() => this.fire(`total time of ${secs(o.totalMs)} exceeded`), o.totalMs);
    if (o.firstTokenMs && o.firstTokenMs > 0) this.timers.first = setTimeout(() => this.fire(`no first token within ${secs(o.firstTokenMs!)}`), o.firstTokenMs);
  }

  get signal(): AbortSignal {
    return this.ctrl.signal;
  }

  /** call on every received chunk */
  activity(): void {
    if (this.fired) return;
    if (!this.started) {
      this.started = true;
      clearTimeout(this.timers.first);
    }
    if (this.o.idleMs && this.o.idleMs > 0) {
      clearTimeout(this.timers.idle);
      this.timers.idle = setTimeout(() => this.fire(`stream silent for ${secs(this.o.idleMs!)}`), this.o.idleMs);
    }
  }

  private fire(reason: string): void {
    if (this.fired || this.ctrl.signal.aborted) return;
    this.fired = reason;
    this.ctrl.abort(new Error(`timeout: ${reason}`));
  }

  dispose(): void {
    clearTimeout(this.timers.total);
    clearTimeout(this.timers.first);
    clearTimeout(this.timers.idle);
    this.parent?.removeEventListener('abort', this.onAbort);
  }
}

function secs(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

interface OpenAIResponse {
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string; reasoning?: string; tool_calls?: ToolCall[] };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 2000);
  } catch {
    return '';
  }
}

/** Parse a Retry-After header (seconds or HTTP date) into ms. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

export function classifyHttp(status: number, text: string, model: string, retryAfter?: string | null): LlmError {
  const lower = text.toLowerCase();
  const msg = `HTTP ${status} (${model}): ${text.slice(0, 400)}`;
  const ra = parseRetryAfter(retryAfter);
  if (status === 429) return new LlmError(msg, 'rate_limit', status, model, ra);
  if (status === 503 && ra !== undefined) return new LlmError(msg, 'server', status, model, ra);
  if (
    /context length|maximum context|context_length_exceeded|too many tokens|prompt is too long|exceeds the (model'?s )?(maximum|max)|n_ctx|reduce the length/.test(lower)
  ) {
    return new LlmError(msg, 'context_length', status, model);
  }
  if (status === 429) return new LlmError(msg, 'rate_limit', status, model);
  if (status === 401 || status === 403) return new LlmError(msg, 'auth', status, model);
  if (status === 404) return new LlmError(msg, 'not_found', status, model);
  if (status === 408 || status >= 500) return new LlmError(msg, 'server', status, model);
  return new LlmError(msg, 'bad_request', status, model);
}

export function toLlmError(e: unknown, model: string): LlmError {
  if (e instanceof LlmError) return e;
  const err = e as Error & { cause?: { code?: string } };
  const m = err?.message ?? String(e);
  if (/timeout/i.test(m) || err?.name === 'TimeoutError') return new LlmError(`timeout (${model}): ${m}`, 'timeout', undefined, model);
  if (err?.name === 'AbortError' && /timeout/i.test(String((err as { cause?: unknown }).cause ?? ''))) {
    return new LlmError(`timeout (${model})`, 'timeout', undefined, model);
  }
  return new LlmError(`connection error (${model}): ${m}${err?.cause?.code ? ' [' + err.cause.code + ']' : ''}`, 'network', undefined, model);
}

function fromNonStream(json: OpenAIResponse, started: number, model: string, onToken?: (s: string) => void): ChatResult {
  const choice = json.choices?.[0];
  const raw = choice?.message?.content ?? '';
  const split = stripThinking(raw);
  const thinking = [choice?.message?.reasoning_content, choice?.message?.reasoning, split.thinking].filter(Boolean).join('\n');
  if (split.content && onToken) onToken(split.content);
  const now = Date.now();
  return {
    content: split.content,
    thinking,
    toolCalls: normalizeToolCalls(choice?.message?.tool_calls ?? []),
    finishReason: choice?.finish_reason ?? 'stop',
    usage: { promptTokens: json.usage?.prompt_tokens ?? 0, completionTokens: json.usage?.completion_tokens ?? 0 },
    ttftMs: now - started,
    durationMs: now - started,
    model,
  };
}

function normalizeToolCalls(calls: Array<Partial<ToolCall>>): ToolCall[] {
  return calls
    .filter((c) => c?.function?.name)
    .map((c, i) => ({
      id: c.id || `call_${i}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'function' as const,
      function: { name: c.function!.name, arguments: c.function!.arguments ?? '{}' },
    }));
}

/** Parse an SSE stream from /chat/completions with stream=true. Exported for tests. */
export async function readStream(
  body: ReadableStream<Uint8Array>,
  started: number,
  model: string,
  onToken?: (s: string) => void,
  onActivity?: () => void,
): Promise<ChatResult> {
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let finishReason = '';
  let ttft = -1;
  const usage = { promptTokens: 0, completionTokens: 0 };
  const calls: Array<{ id?: string; name: string; args: string }> = [];

  const handle = (data: string) => {
    if (data === '[DONE]') return;
    let chunk: {
      choices?: Array<{
        delta?: {
          content?: string | null;
          reasoning_content?: string | null;
          reasoning?: string | null;
          tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
        };
        finish_reason?: string | null;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.error) throw new LlmError(`stream error (${model}): ${chunk.error.message ?? 'unknown'}`, 'server', undefined, model);
    if (chunk.usage) {
      usage.promptTokens = chunk.usage.prompt_tokens ?? usage.promptTokens;
      usage.completionTokens = chunk.usage.completion_tokens ?? usage.completionTokens;
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const d = choice.delta ?? {};
    const r = d.reasoning_content ?? d.reasoning;
    if (r) {
      if (ttft < 0) ttft = Date.now() - started;
      reasoning += r;
    }
    if (d.content) {
      if (ttft < 0) ttft = Date.now() - started;
      content += d.content;
      onToken?.(d.content);
    }
    if (d.tool_calls) {
      if (ttft < 0) ttft = Date.now() - started;
      for (const tc of d.tool_calls) {
        const idx = tc.index ?? calls.length;
        const slot = (calls[idx] ??= { name: '', args: '' });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data:')) handle(line.slice(5).trim());
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith('data:')) handle(tail.slice(5).trim());
  } finally {
    reader.releaseLock();
  }

  const split = stripThinking(content);
  const now = Date.now();
  return {
    content: split.content,
    thinking: [reasoning, split.thinking].filter(Boolean).join('\n'),
    toolCalls: normalizeToolCalls(calls.filter(Boolean).map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } }))),
    finishReason: finishReason || 'stop',
    usage: {
      promptTokens: usage.promptTokens,
      // some servers omit usage in streams – estimate from text
      completionTokens: usage.completionTokens || Math.ceil((content.length + reasoning.length) / 3.6),
    },
    ttftMs: ttft < 0 ? now - started : ttft,
    durationMs: now - started,
    model,
  };
}
