import { NON_CHAT_MODEL } from '../index/embeddings.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EndpointConfig, KurultayConfig } from '../config.js';
import { OpenAICompatClient } from '../llm/client.js';
import { computeRoleScores, defaultCapabilities, type CapabilitiesFile, type ModelCapabilities } from '../llm/models.js';
import { LlmError, type ChatRequest, type ChatResult, type ToolSpec } from '../llm/types.js';
import { errorMessage, mapLimit, sleep } from '../util/async.js';
import type { EventBus } from '../util/events.js';
import { tryExtractJson } from '../util/text.js';
import { CODING_TASKS, EDIT_TASKS, editTaskPrompt, evaluateCodingAnswer, evaluateEditAnswer } from './bench.js';

export interface ProbeOptions {
  /** probe context up to 256k and concurrency up to 16 */
  deep?: boolean;
  /** skip benchmark (connectivity + features only) */
  quick?: boolean;
  /** base delay between reachability retries while a model is loading (default 1000 ms) */
  retryDelayMs?: number;
  signal?: AbortSignal;
}

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

  private log(msg: string) {
    this.bus?.info(`probe:${this.caps.key}`, msg);
  }

  private async call(req: ChatRequest): Promise<ChatResult> {
    return this.client.chat(this.caps.model, { timeoutMs: 180_000, signal: this.opts.signal, temperature: 0, ...req });
  }

  async run(): Promise<ModelCapabilities> {
    const c = this.caps;
    c.notes = [];
    // 1. basic reachability (non-streaming) – retry while the server is loading the model
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const r = await this.call({ messages: [{ role: 'user', content: 'Reply with exactly the word PONG and nothing else.' }], stream: false, maxTokens: 512 });
        c.reachable = true;
        if (r.thinking) c.thinking = true;
        if (!/PONG/i.test(r.content)) c.notes.push('PONG talimatına uymadı');
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
        if (!(e instanceof LlmError) || !e.retryable || attempt === 5) break;
        this.log(`yanıt yok (${e.kind}), ${attempt}. tekrar deneniyor…`);
        await sleep(Math.min(20_000, (this.opts.retryDelayMs ?? 1000) * 2 ** (attempt - 1)), this.opts.signal);
      }
    }
    if (lastErr) {
      c.reachable = false;
      c.notes.push(`erişilemedi: ${errorMessage(lastErr)}`);
      this.log(`erişilemedi: ${errorMessage(lastErr)}`);
      return c;
    }
    this.log('erişilebilir');

    // 2. streaming + speed
    try {
      const r = await this.call({
        messages: [{ role: 'user', content: 'Count from 1 to 150, numbers separated by single spaces. Output only the numbers.' }],
        stream: true,
        maxTokens: 1024,
      });
      c.streaming = true;
      c.ttftMs = r.ttftMs;
      const genMs = Math.max(1, r.durationMs - r.ttftMs);
      c.tokensPerSec = Math.round((r.usage.completionTokens / genMs) * 1000 * 10) / 10;
      if (r.thinking) c.thinking = true;
    } catch (e) {
      c.streaming = false;
      c.notes.push(`streaming çalışmadı: ${errorMessage(e)}`);
    }

    // 3. native tool calling
    try {
      const r = await this.call({
        messages: [{ role: 'user', content: 'What is the weather in Ankara right now? Use the available tool.' }],
        tools: [WEATHER_TOOL],
        toolChoice: 'auto',
        maxTokens: 1024,
      });
      const tc = r.toolCalls.find((t) => t.function.name === 'get_weather');
      const args = tc ? tryExtractJson<{ city?: string }>(tc.function.arguments) : undefined;
      c.nativeTools = !!tc && /ankara/i.test(args?.city ?? '');
      if (!c.nativeTools) c.notes.push('native tool calling yok/bozuk → prompt tabanlı araç çağrısı kullanılacak');
    } catch (e) {
      c.nativeTools = false;
      c.notes.push(`tool calling hatası: ${errorMessage(e)}`);
    }

    // 4. JSON mode + instruction following
    let instr = 0;
    try {
      const r = await this.call({
        messages: [{ role: 'user', content: 'Return a JSON object with keys "lang" (value "c++") and "year" (value 2011). JSON only.' }],
        jsonMode: true,
        maxTokens: 512,
      });
      const j = tryExtractJson<{ lang?: string; year?: number }>(r.content);
      c.jsonMode = !!j && j.lang === 'c++';
      if (c.jsonMode && Number(j?.year) === 2011) instr += 1;
    } catch {
      c.jsonMode = false;
    }
    // constrained decoding (response_format json_schema): vLLM guided decoding, llama.cpp grammars …
    try {
      const r = await this.call({
        messages: [{ role: 'user', content: 'Return the programming language C++ and the year 2011 as JSON.' }],
        jsonSchema: { name: 'probe', schema: { type: 'object', properties: { lang: { type: 'string', enum: ['c++'] }, year: { type: 'integer' } }, required: ['lang', 'year'] } },
        maxTokens: 256,
      });
      const j = tryExtractJson<{ lang?: string; year?: number }>(r.content);
      c.jsonSchema = !!j && j.lang === 'c++';
    } catch {
      c.jsonSchema = false;
    }
    const instructionChecks: Array<[string, (s: string) => boolean]> = [
      ['What is 17 * 23? Answer with only the number.', (s) => s.trim() === '391'],
      ['Return a JSON array of exactly three lowercase color names. JSON only.', (s) => {
        const a = tryExtractJson<unknown[]>(s);
        return Array.isArray(a) && a.length === 3 && a.every((x) => typeof x === 'string' && x === x.toLowerCase());
      }],
      ['Write the word "kurultay" in uppercase letters, nothing else.', (s) => s.trim().replace(/[."']/g, '') === 'KURULTAY'],
    ];
    for (const [q, ok] of instructionChecks) {
      try {
        const r = await this.call({ messages: [{ role: 'user', content: q }], maxTokens: 512 });
        if (ok(r.content)) instr += 1;
      } catch {
        /* counts as failure */
      }
    }
    c.instructionScore = Math.round((instr / (instructionChecks.length + 1)) * 1000) / 1000;

    // 5. context window
    await this.probeContext();

    if (this.opts.quick) {
      c.probedAt = new Date().toISOString();
      return c;
    }

    // 6. coding mini benchmark
    let codeTotal = 0;
    for (const task of CODING_TASKS) {
      try {
        const r = await this.call({
          messages: [
            { role: 'system', content: 'You are an expert programmer. Answer with a single ```javascript code block containing only the function. No explanations.' },
            { role: 'user', content: task.prompt },
          ],
          maxTokens: 2048,
        });
        const s = evaluateCodingAnswer(task, r.content);
        codeTotal += s;
      } catch (e) {
        c.notes.push(`benchmark ${task.id}: ${errorMessage(e)}`);
      }
    }
    c.codingScore = Math.round((codeTotal / CODING_TASKS.length) * 1000) / 1000;

    // 7. edit format accuracy
    let editTotal = 0;
    for (const t of EDIT_TASKS) {
      try {
        const r = await this.call({ messages: [{ role: 'user', content: editTaskPrompt(t) }], maxTokens: 2048 });
        editTotal += evaluateEditAnswer(t, r.content);
      } catch {
        /* zero */
      }
    }
    c.editScore = Math.round((editTotal / EDIT_TASKS.length) * 1000) / 1000;
    c.probedAt = new Date().toISOString();
    this.log(`kod=${c.codingScore} edit=${c.editScore} talimat=${c.instructionScore} hız=${c.tokensPerSec} tok/s`);
    return c;
  }

  /** Ladder of prompt sizes until the server reports a context overflow. */
  private async probeContext(): Promise<void> {
    const c = this.caps;
    const reported = c.contextWindow > 0 ? c.contextWindow : undefined;
    const ladder = this.opts.deep ? [8_192, 16_384, 32_768, 65_536, 131_072, 262_144] : [8_192, 16_384, 32_768];
    // If the server reported a window, trust it but verify the largest rung below it.
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
    let lastOk = 0;
    for (const size of ladder) {
      if (reported && size > reported) break;
      const chars = Math.floor((size * 0.88) / tokPerChar);
      const text = filler.repeat(Math.ceil(chars / filler.length)).slice(0, chars);
      try {
        await this.call({
          messages: [{ role: 'user', content: `${text}\n\nIgnore the text above. Reply with OK.` }],
          maxTokens: 8,
          stream: false,
          timeoutMs: 300_000,
        });
        lastOk = size;
      } catch (e) {
        if (e instanceof LlmError && e.kind === 'context_length') break;
        c.notes.push(`bağlam testi ${size}: ${errorMessage(e)}`);
        break;
      }
    }
    const top = ladder[ladder.length - 1];
    const highestTestable = reported ? Math.max(...ladder.filter((s) => s <= reported), 0) : top;
    if (reported && lastOk >= highestTestable) {
      c.contextWindow = reported; // every rung up to the reported window passed
    } else if (lastOk) {
      c.contextWindow = lastOk; // server is effectively limited below what it reports
      if (!reported && lastOk === top) c.notes.push(`bağlam en az ${top} (daha fazlası için --deep)`);
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
  const levels = deep ? [1, 2, 4, 8, 16] : [1, 2, 4, 8];
  let best = { concurrency: 1, aggregateTps: 0 };
  for (const n of levels) {
    const started = Date.now();
    try {
      const results = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          client.chat(model, {
            messages: [{ role: 'user', content: `Write ${40 + i} short words about rivers, separated by spaces.` }],
            maxTokens: 160,
            temperature: 0.7,
            signal,
            timeoutMs: 240_000,
          }),
        ),
      );
      const tokens = results.reduce((s, r) => s + r.usage.completionTokens, 0);
      const tps = (tokens / Math.max(1, Date.now() - started)) * 1000;
      bus?.info(`probe:${model}@${client.endpoint.name}`, `eşzamanlılık ${n}: toplam ${tps.toFixed(1)} tok/s`);
      if (tps > best.aggregateTps * 1.15) best = { concurrency: n, aggregateTps: Math.round(tps * 10) / 10 };
      else break; // no meaningful gain → saturated
    } catch (e) {
      bus?.warn(`probe:${model}@${client.endpoint.name}`, `eşzamanlılık ${n} başarısız: ${errorMessage(e)}`);
      break;
    }
  }
  return best;
}

async function probeEndpoint(ep: EndpointConfig, cfg: KurultayConfig, bus: EventBus | undefined, opts: ProbeOptions): Promise<ModelCapabilities[]> {
  const client = new OpenAICompatClient(ep);
  let ids: Array<{ id: string; contextWindow?: number }> = [];
  try {
    const listed = await client.listModels(opts.signal);
    ids = ep.models?.length ? ep.models.map((id) => listed.find((m) => m.id === id) ?? { id }) : listed;
  } catch (e) {
    if (ep.models?.length) ids = ep.models.map((id) => ({ id }));
    else {
      bus?.error(`probe:${ep.name}`, `model listesi alınamadı ve config'de model belirtilmemiş: ${errorMessage(e)}`);
      return [];
    }
  }
  // skip embedding / reranker models – they cannot chat
  ids = ids.filter((m) => !NON_CHAT_MODEL.test(m.id));
  bus?.info(`probe:${ep.name}`, `${ids.length} model bulundu: ${ids.map((m) => m.id).join(', ')}`);

  const out: ModelCapabilities[] = [];
  // models on the same endpoint are probed sequentially (shared GPU → fair timing)
  for (const m of ids) {
    const caps = defaultCapabilities(m.id, ep.name);
    // 0 = unknown: the ladder must measure it instead of trusting the 32k default
    caps.contextWindow = m.contextWindow ?? 0;
    const ov = cfg.models[caps.key] ?? cfg.models[m.id];
    if (ov?.contextWindow) caps.contextWindow = ov.contextWindow;
    out.push(await new ModelProber(client, caps, bus, opts).run());
  }
  const reachable = out.filter((c) => c.reachable);
  if (reachable.length) {
    const fastest = [...reachable].sort((a, b) => b.tokensPerSec - a.tokensPerSec)[0];
    const conc = ep.maxConcurrency && ep.maxConcurrency > 0
      ? { concurrency: ep.maxConcurrency, aggregateTps: 0 }
      : await probeConcurrency(client, fastest.model, !!opts.deep, bus, opts.signal);
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
  const models = perEndpoint.flat();
  const fleetMaxTps = Math.max(0, ...models.filter((m) => m.reachable).map((m) => m.tokensPerSec));
  for (const m of models) {
    m.roleScores = m.reachable ? computeRoleScores(m, fleetMaxTps) : { planner: 0, coder: 0, summarizer: 0, reviewer: 0, judge: 0, fast: 0 };
  }
  return { version: 1, generatedAt: new Date().toISOString(), models };
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
    return `| ${m.key} | ${m.reachable ? '✅' : '❌'} | ${m.contextWindow.toLocaleString('en')} | ${m.nativeTools ? 'native' : 'prompt'} | ${m.jsonMode ? '✓' : '–'} | ${m.thinking ? '✓' : '–'} | ${m.tokensPerSec} | ${m.ttftMs} | ${m.maxConcurrency} | ${m.codingScore} | ${m.editScore} | ${m.instructionScore} | ${best} |`;
  });
  const notes = file.models.filter((m) => m.notes.length).map((m) => `- **${m.key}**: ${m.notes.join('; ')}`);
  return `# Model Yetenek Raporu

Oluşturulma: ${file.generatedAt}

| Model | Erişim | Bağlam | Araç | JSON | Düşünme | tok/s | TTFT ms | Paralel | Kod | Edit | Talimat | En iyi roller |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

## Rol puanları

| Model | planner | coder | summarizer | reviewer | judge | fast |
|---|---|---|---|---|---|---|
${file.models.map((m) => `| ${m.key} | ${m.roleScores.planner} | ${m.roleScores.coder} | ${m.roleScores.summarizer} | ${m.roleScores.reviewer} | ${m.roleScores.judge} | ${m.roleScores.fast} |`).join('\n')}

${notes.length ? '## Notlar\n\n' + notes.join('\n') + '\n' : ''}`;
}
