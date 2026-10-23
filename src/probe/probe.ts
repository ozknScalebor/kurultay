import { NON_CHAT_MODEL } from '../index/embeddings.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EndpointConfig, KurultayConfig } from '../config.js';
import { OpenAICompatClient, clientFor } from '../llm/client.js';
import { computeRoleScores, defaultCapabilities, type CapabilitiesFile, type ModelCapabilities } from '../llm/models.js';
import { LlmError, type ChatRequest, type ChatResult, type ToolSpec } from '../llm/types.js';
import { errorMessage, mapLimit, sleep } from '../util/async.js';
import type { EventBus } from '../util/events.js';
import { tryExtractJson } from '../util/text.js';
import { CODING_TASKS, EDIT_TASKS, editTaskPrompt, evaluateCodingAnswer, evaluateEditAnswer } from './bench.js';

export interface ProbeOptions {
  /** full measurement: context ladder up to 256k, concurrency up to 16, every benchmark task */
  deep?: boolean;
  /** connectivity + features only (no benchmark) */
  quick?: boolean;
  /** base delay between reachability retries while a model is loading (default 1000 ms) */
  retryDelayMs?: number;
  signal?: AbortSignal;
  /** probe only these models (keys "model@endpoint"); others are left out of the result */
  only?: (key: string) => boolean;
  /** called before every step: the console prints one tidy line per model */
  onStep?: (key: string, step: string, index: number, total: number) => void;
}

/** Benchmark tasks per level: standard probes keep it short (a few minutes per model at most). */
const STANDARD_TASKS = 2;

const WEATHER_TOOL: ToolSpec = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};

class ModelProber {
  constructor(
    private readonly client: OpenAICompatClient,
    private readonly caps: ModelCapabilities,
    private readonly bus: EventBus | undefined,
    private readonly opts: ProbeOptions,
  ) {}

  private steps(): string[] {
    const s = ['connect', 'speed', 'tool calling', 'JSON', 'instructions', 'context window'];
    if (!this.opts.quick) s.push('coding', 'editing');
    return s;
  }

  private step(name: string): void {
    const all = this.steps();
    this.opts.onStep?.(this.caps.key, name, all.indexOf(name) + 1, all.length);
  }

  private async call(req: ChatRequest): Promise<ChatResult> {
    return this.client.chat(this.caps.model, { timeoutMs: 120_000, signal: this.opts.signal, temperature: 0, ...req });
  }

  /** Output budget: reasoning models spend tokens on thinking before they answer. */
  private budget(normal: number): number {
    return this.caps.thinking ? Math.max(normal * 4, 2048) : normal;
  }

  async run(): Promise<ModelCapabilities> {
    const c = this.caps;
    c.notes = [];
    const started = Date.now();
    // 1. basic reachability (non-streaming) – retry a little while the server is loading the model
    this.step('connect');
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await this.call({ messages: [{ role: 'user', content: 'Reply with exactly the word PONG and nothing else.' }], stream: false, maxTokens: 512 });
        c.reachable = true;
        if (r.thinking) c.thinking = true;
        if (!/PONG/i.test(r.content)) c.notes.push('did not follow the PONG instruction');
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
        if (!(e instanceof LlmError) || !e.retryable || attempt === 3) break;
        await sleep(Math.min(10_000, (this.opts.retryDelayMs ?? 1000) * 2 ** (attempt - 1)), this.opts.signal);
      }
    }
    if (lastErr) {
      c.reachable = false;
      c.notes.push(`unreachable: ${errorMessage(lastErr)}`);
      this.bus?.warn(`probe:${c.key}`, `unreachable: ${errorMessage(lastErr)}`);
      return c;
    }

    // 2. streaming + speed
    this.step('speed');
    try {
      const r = await this.call({
        messages: [{ role: 'user', content: 'Count from 1 to 60, numbers separated by single spaces. Output only the numbers.' }],
        stream: true,
        maxTokens: this.budget(400),
      });
      c.streaming = true;
      c.ttftMs = r.ttftMs;
      const genMs = Math.max(1, r.durationMs - r.ttftMs);
      c.tokensPerSec = Math.round((r.usage.completionTokens / genMs) * 1000 * 10) / 10;
      if (r.thinking) c.thinking = true;
    } catch (e) {
      c.streaming = false;
      c.notes.push(`streaming failed: ${errorMessage(e)}`);
    }

    // 3. native tool calling
    this.step('tool calling');
    try {
      const r = await this.call({
        messages: [{ role: 'user', content: 'What is the weather in Ankara right now? Use the available tool.' }],
        tools: [WEATHER_TOOL],
        toolChoice: 'auto',
        maxTokens: this.budget(512),
      });
      const tc = r.toolCalls.find((t) => t.function.name === 'get_weather');
      const args = tc ? tryExtractJson<{ city?: string }>(tc.function.arguments) : undefined;
      c.nativeTools = !!tc && /ankara/i.test(args?.city ?? '');
      if (!c.nativeTools) c.notes.push('no working native tool calling → prompt-based tool calls will be used');
    } catch (e) {
      c.nativeTools = false;
      c.notes.push(`tool calling error: ${errorMessage(e)}`);
    }

    // 4. JSON mode + constrained decoding (response_format json_schema)
    this.step('JSON');
    let instr = 0;
    try {
      const r = await this.call({
        messages: [{ role: 'user', content: 'Return a JSON object with keys "lang" (value "c++") and "year" (value 2011). JSON only.' }],
        jsonMode: true,
        maxTokens: this.budget(256),
      });
      const j = tryExtractJson<{ lang?: string; year?: number }>(r.content);
      c.jsonMode = !!j && j.lang === 'c++';
      if (c.jsonMode && Number(j?.year) === 2011) instr += 1;
    } catch {
      c.jsonMode = false;
    }
    try {
      const r = await this.call({
        messages: [{ role: 'user', content: 'Return the programming language C++ and the year 2011 as JSON.' }],
        jsonSchema: { name: 'probe', schema: { type: 'object', properties: { lang: { type: 'string', enum: ['c++'] }, year: { type: 'integer' } }, required: ['lang', 'year'] } },
        maxTokens: this.budget(256),
      });
      const j = tryExtractJson<{ lang?: string; year?: number }>(r.content);
      c.jsonSchema = !!j && j.lang === 'c++';
    } catch {
      c.jsonSchema = false;
    }

    // 5. instruction following
    this.step('instructions');
    const instructionChecks: Array<[string, (s: string) => boolean]> = [
      ['What is 17 * 23? Answer with only the number.', (s) => s.trim() === '391'],
      ['Return a JSON array of exactly three lowercase color names. JSON only.', (s) => {
        const a = tryExtractJson<unknown[]>(s);
        return Array.isArray(a) && a.length === 3 && a.every((x) => typeof x === 'string' && x === x.toLowerCase());
      }],
      ['Write the word "kurultay" in uppercase letters, nothing else.', (s) => s.trim().replace(/[."']/g, '') === 'KURULTAY'],
    ];
    const checks = this.opts.deep ? instructionChecks : instructionChecks.slice(0, STANDARD_TASKS);
    for (const [q, ok] of checks) {
      try {
        const r = await this.call({ messages: [{ role: 'user', content: q }], maxTokens: this.budget(256) });
        if (ok(r.content)) instr += 1;
      } catch {
        /* counts as failure */
      }
    }
    c.instructionScore = Math.round((instr / (checks.length + 1)) * 1000) / 1000;

    // 6. context window
    this.step('context window');
    await this.probeContext();

    if (!this.opts.quick) {
      // 7. coding mini benchmark
      this.step('coding');
      const coding = this.opts.deep ? CODING_TASKS : CODING_TASKS.slice(0, STANDARD_TASKS);
      let codeTotal = 0;
      for (const task of coding) {
        try {
          const r = await this.call({
            messages: [
              { role: 'system', content: 'You are an expert programmer. Answer with a single ```javascript code block containing only the function. No explanations.' },
              { role: 'user', content: task.prompt },
            ],
            maxTokens: this.budget(1024),
          });
          codeTotal += evaluateCodingAnswer(task, r.content);
        } catch (e) {
          c.notes.push(`benchmark ${task.id}: ${errorMessage(e)}`);
        }
      }
      c.codingScore = Math.round((codeTotal / coding.length) * 1000) / 1000;

      // 8. edit format accuracy
      this.step('editing');
      const edits = this.opts.deep ? EDIT_TASKS : EDIT_TASKS.slice(0, STANDARD_TASKS);
      let editTotal = 0;
      for (const t of edits) {
        try {
          const r = await this.call({ messages: [{ role: 'user', content: editTaskPrompt(t) }], maxTokens: this.budget(1024) });
          editTotal += evaluateEditAnswer(t, r.content);
        } catch {
          /* zero */
        }
      }
      c.editScore = Math.round((editTotal / edits.length) * 1000) / 1000;
    }
    c.probedAt = new Date().toISOString();
    c.probeSeconds = Math.round((Date.now() - started) / 100) / 10;
    return c;
  }

  /**
   * Context window. A window the server reports (vLLM max_model_len, llama.cpp n_ctx…)
   * is trusted. Otherwise a short ladder (8k → 32k, 16k if 32k fails) finds it; --deep
   * climbs to 256k.
   */
  private async probeContext(): Promise<void> {
    const c = this.caps;
    const reported = c.contextWindow > 0 ? c.contextWindow : undefined;
    if (reported && !this.opts.deep) {
      c.maxOutputTokens = Math.max(1024, Math.min(16_384, Math.floor(reported / 4)));
      return;
    }
    const ladder = this.opts.deep ? [8_192, 16_384, 32_768, 65_536, 131_072, 262_144] : [8_192, 32_768];
    const filler = 'lorem ipsum dolor sit amet consectetur ';
    // calibrate tokens-per-char with the server's own tokenizer (usage.prompt_tokens)
    let tokPerChar = 1 / 3.6;
    try {
      const sample = filler.repeat(60);
      const r = await this.call({ messages: [{ role: 'user', content: `${sample}\nReply OK.` }], maxTokens: 4, stream: false });
      if (r.usage.promptTokens > 50) tokPerChar = r.usage.promptTokens / (sample.length + 12);
    } catch {
      /* keep heuristic */
    }
    const fits = async (size: number): Promise<boolean | undefined> => {
      const chars = Math.floor((size * 0.88) / tokPerChar);
      const text = filler.repeat(Math.ceil(chars / filler.length)).slice(0, chars);
      try {
        await this.call({ messages: [{ role: 'user', content: `${text}\n\nIgnore the text above. Reply with OK.` }], maxTokens: 8, stream: false, timeoutMs: 300_000 });
        return true;
      } catch (e) {
        if (e instanceof LlmError && e.kind === 'context_length') return false;
        c.notes.push(`context test ${size}: ${errorMessage(e)}`);
        return undefined;
      }
    };
    let lastOk = 0;
    let failedAt = 0;
    for (const size of ladder) {
      if (reported && size > reported) break;
      const ok = await fits(size);
      if (ok) lastOk = size;
      else {
        failedAt = size;
        break;
      }
    }
    // standard ladder skips 16k: try it when 32k did not fit
    if (!this.opts.deep && failedAt === 32_768 && lastOk === 8_192 && (await fits(16_384))) lastOk = 16_384;
    const top = ladder[ladder.length - 1];
    const highestTestable = reported ? Math.max(...ladder.filter((s) => s <= reported), 0) : top;
    if (reported && lastOk >= highestTestable) {
      c.contextWindow = reported; // every rung up to the reported window passed
    } else if (lastOk) {
      c.contextWindow = lastOk; // server is effectively limited below what it reports
      if (!reported && lastOk === top && !this.opts.deep) c.notes.push(`context at least ${top} (kurultay probe --deep measures more)`);
    } else {
      c.contextWindow = reported || 4096;
    }
    c.maxOutputTokens = Math.max(1024, Math.min(16_384, Math.floor(c.contextWindow / 4)));
  }
}

/** Measure aggregate throughput as parallelism grows; returns best concurrency. */
async function probeConcurrency(
  client: OpenAICompatClient,
  model: string,
  deep: boolean,
  bus?: EventBus,
  signal?: AbortSignal,
): Promise<{ concurrency: number; aggregateTps: number }> {
  const levels = deep ? [1, 2, 4, 8, 16] : [1, 2, 4];
  let best = { concurrency: 1, aggregateTps: 0 };
  for (const n of levels) {
    const started = Date.now();
    try {
      const results = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          client.chat(model, {
            messages: [{ role: 'user', content: `Write ${30 + i} short words about rivers, separated by spaces.` }],
            maxTokens: 96,
            temperature: 0.7,
            signal,
            timeoutMs: 180_000,
          }),
        ),
      );
      const tokens = results.reduce((s, r) => s + r.usage.completionTokens, 0);
      const tps = (tokens / Math.max(1, Date.now() - started)) * 1000;
      bus?.debug(`probe:${model}@${client.endpoint.name}`, `concurrency ${n}: ${tps.toFixed(1)} tok/s in total`);
      if (tps > best.aggregateTps * 1.15) best = { concurrency: n, aggregateTps: Math.round(tps * 10) / 10 };
      else break; // no meaningful gain → saturated
    } catch (e) {
      bus?.warn(`probe:${model}@${client.endpoint.name}`, `concurrency ${n} failed: ${errorMessage(e)}`);
      break;
    }
  }
  // without --deep the ramp stops at 4: a server that still scales gets a bit more headroom
  if (!deep && best.concurrency === 4) best = { ...best, concurrency: 6 };
  return best;
}

async function probeEndpoint(ep: EndpointConfig, cfg: KurultayConfig, bus: EventBus | undefined, opts: ProbeOptions): Promise<ModelCapabilities[]> {
  const listClient = new OpenAICompatClient(ep);
  let ids: Array<{ id: string; contextWindow?: number }> = [];
  try {
    const listed = await listClient.listModels(opts.signal);
    ids = ep.models?.length ? ep.models.map((id) => listed.find((m) => m.id === id) ?? { id }) : listed;
  } catch (e) {
    if (ep.models?.length) ids = ep.models.map((id) => ({ id }));
    else {
      bus?.error(`probe:${ep.name}`, `cannot list the models and the config names none: ${errorMessage(e)}`);
      return [];
    }
  }
  // skip embedding / reranker models – they cannot chat
  ids = ids.filter((m) => !NON_CHAT_MODEL.test(m.id)).filter((m) => !opts.only || opts.only(`${m.id}@${ep.name}`));
  if (!ids.length) return [];

  const out: ModelCapabilities[] = [];
  // models on the same endpoint are probed one after another (shared GPU → fair timing)
  for (const m of ids) {
    const caps = defaultCapabilities(m.id, ep.name);
    // 0 = unknown: the ladder measures it instead of trusting the 32k default
    caps.contextWindow = m.contextWindow ?? 0;
    const ov = cfg.models[caps.key] ?? cfg.models[m.id];
    if (ov?.contextWindow) caps.contextWindow = ov.contextWindow;
    const r = await new ModelProber(clientFor(ep, ov), caps, bus, opts).run();
    bus?.emitEvent('probe.model', { source: r.key, data: { reachable: r.reachable, seconds: r.probeSeconds } });
    out.push(r);
  }
  const reachable = out.filter((c) => c.reachable);
  if (reachable.length) {
    const fastest = [...reachable].sort((a, b) => b.tokensPerSec - a.tokensPerSec)[0];
    const ov = cfg.models[fastest.key] ?? cfg.models[fastest.model];
    const conc = ep.maxConcurrency && ep.maxConcurrency > 0
      ? { concurrency: ep.maxConcurrency, aggregateTps: 0 }
      : await probeConcurrency(clientFor(ep, ov), fastest.model, !!opts.deep, bus, opts.signal);
    for (const c of out) {
      c.maxConcurrency = conc.concurrency;
      c.aggregateTokensPerSec = conc.aggregateTps;
    }
  }
  return out;
}

/** Probe every endpoint in parallel and compute role scores across the fleet. */
export async function probeAll(cfg: KurultayConfig, bus?: EventBus, opts: ProbeOptions = {}): Promise<CapabilitiesFile> {
  const eps = cfg.endpoints.filter((e) => !e.disabled);
  const perEndpoint = await mapLimit(eps, eps.length, (ep) =>
    probeEndpoint(ep, cfg, bus, opts).catch((e) => {
      bus?.error(`probe:${ep.name}`, errorMessage(e));
      return [] as ModelCapabilities[];
    }),
  );
  return withRoleScores(perEndpoint.flat());
}

function withRoleScores(models: ModelCapabilities[]): CapabilitiesFile {
  const fleetMaxTps = Math.max(0, ...models.filter((m) => m.reachable).map((m) => m.tokensPerSec));
  for (const m of models) {
    m.roleScores = m.reachable ? computeRoleScores(m, fleetMaxTps) : { planner: 0, coder: 0, summarizer: 0, reviewer: 0, judge: 0, fast: 0 };
  }
  return { version: 1, generatedAt: new Date().toISOString(), models };
}

/**
 * Merge a new probe into a saved profile: re-measured models replace their old
 * entries, the rest are kept, role scores are recomputed for the whole fleet.
 */
export function mergeCapabilities(prev: CapabilitiesFile | undefined, next: CapabilitiesFile): CapabilitiesFile {
  const fresh = new Set(next.models.map((m) => m.key));
  return withRoleScores([...(prev?.models ?? []).filter((m) => !fresh.has(m.key)), ...next.models]);
}

/**
 * Models of the configuration that have no saved profile yet (explicit model lists
 * are compared directly; endpoints without a list are asked for /models).
 */
export async function unprofiledModels(cfg: KurultayConfig, saved: CapabilitiesFile | undefined, signal?: AbortSignal): Promise<string[]> {
  const have = new Set((saved?.models ?? []).map((m) => m.key));
  const out: string[] = [];
  for (const ep of cfg.endpoints.filter((e) => !e.disabled)) {
    let ids = ep.models ?? [];
    if (!ids.length) {
      try {
        ids = (await new OpenAICompatClient(ep).listModels(signal ?? AbortSignal.timeout(10_000))).map((m) => m.id);
      } catch {
        ids = [];
      }
    }
    for (const id of ids) if (!NON_CHAT_MODEL.test(id) && !have.has(`${id}@${ep.name}`)) out.push(`${id}@${ep.name}`);
  }
  return out;
}

export function writeCapabilities(stateDir: string, file: CapabilitiesFile): { json: string; md: string } {
  mkdirSync(stateDir, { recursive: true });
  const json = join(stateDir, 'capabilities.json');
  const md = join(stateDir, 'CAPABILITIES.md');
  writeFileSync(json, JSON.stringify(file, null, 2));
  writeFileSync(md, renderCapabilitiesMarkdown(file));
  return { json, md };
}

export function renderCapabilitiesMarkdown(file: CapabilitiesFile): string {
  const rows = file.models.map((m) => {
    const best = Object.entries(m.roleScores).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([r]) => r).join(', ');
    return `| ${m.key} | ${m.reachable ? 'yes' : 'no'} | ${m.contextWindow.toLocaleString('en')} | ${m.nativeTools ? 'native' : 'prompt'} | ${m.jsonMode ? 'yes' : '-'} | ${m.thinking ? 'yes' : '-'} | ${m.tokensPerSec} | ${m.ttftMs} | ${m.maxConcurrency} | ${m.codingScore} | ${m.editScore} | ${m.instructionScore} | ${best} |`;
  });
  const notes = file.models.filter((m) => m.notes.length).map((m) => `- **${m.key}**: ${m.notes.join('; ')}`);
  return `# Model Capability Report

Generated: ${file.generatedAt}

| Model | Reachable | Context | Tools | JSON | Thinking | tok/s | TTFT ms | Parallel | Coding | Editing | Instructions | Best roles |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

## Role scores

| Model | planner | coder | summarizer | reviewer | judge | fast |
|---|---|---|---|---|---|---|
${file.models.map((m) => `| ${m.key} | ${m.roleScores.planner} | ${m.roleScores.coder} | ${m.roleScores.summarizer} | ${m.roleScores.reviewer} | ${m.roleScores.judge} | ${m.roleScores.fast} |`).join('\n')}

${notes.length ? '## Notes\n\n' + notes.join('\n') + '\n' : ''}`;
}
