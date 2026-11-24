import { NON_CHAT_MODEL } from '../index/embeddings.js';
import { ALL_ROLES, DEFAULT_CONFIG, type KurultayConfig, type LlmConfig, type ModelOverride, type Role } from '../config.js';
import { RateLimiter, Semaphore, errorMessage, sleep } from '../util/async.js';
import type { EventBus } from '../util/events.js';
import { estimateTokens } from '../util/text.js';
import { OpenAICompatClient, clientFor } from './client.js';
import type { ModelStats } from './stats.js';
import { defaultCapabilities, type ModelCapabilities } from './models.js';
import { LlmError, type ChatMessage, type ChatRequest, type ChatResult } from './types.js';
import { presetBody, presetFor, type SamplingPreset } from './presets.js';

interface Health {
  consecutiveFailures: number;
  circuitOpenUntil: number;
  successes: number;
  failures: number;
  /** exponentially-weighted latency per completion token, ms */
  ewmaMsPerToken: number;
  /** timeouts in a row (drives the quarantine length) */
  consecutiveTimeouts: number;
  timeouts: number;
  lastError?: string;
}

/** Roles the main model is preferred for; reviews and judging stay with the other models. */
const PRIMARY_ROLES = new Set<Role>(['coder', 'planner']);

/** Short structured answers that do not need hidden reasoning (see Router.quickThinking). */
const QUICK_PURPOSE = /^(plan\.(draft|judge)|localize\.|summary\.|analyze\.|condense$|ask\.chair$|toolshim$)/;

export interface ModelHandle {
  caps: ModelCapabilities;
  client: OpenAICompatClient;
  override: ModelOverride;
  health: Health;
  /** publisher-recommended sampling for this model (undefined = server defaults) */
  preset?: SamplingPreset;
  /** the server rejected the preset's extra sampling fields once */
  presetRejected?: boolean;
  /**
   * Learned output headroom: a model whose structured answers were cut off (typically a
   * reasoning model spending the budget on hidden thinking) starts later requests with
   * this multiple of the requested max_tokens instead of being cut and asked again.
   */
  outputBoost?: number;
  /** the server rejected chat_template_kwargs / reasoning_effort */
  thinkOffRejected?: boolean;
}

export interface RouteOptions {
  role?: Role;
  /** try these model keys first, in order */
  prefer?: string[];
  /** never use these model keys */
  exclude?: string[];
  /** only use exactly these model keys (no other fallback) */
  only?: string[];
  /** fail over to other models when the preferred ones are exhausted (default true) */
  fallback?: boolean;
  /** attempts per model for retryable errors (default 3) */
  attemptsPerModel?: number;
  /** when every model is unreachable, keep waiting up to this long for recovery (default 10 min) */
  recoveryWaitMs?: number;
  /** base delay of the exponential retry backoff (default 1000 ms) */
  retryBaseMs?: number;
  /** first wait between recovery rounds, doubled each round up to 60 s (default 5 s) */
  recoveryIntervalMs?: number;
}

export interface RouterStats {
  key: string;
  active: number;
  queued: number;
  limit: number;
  successes: number;
  failures: number;
  circuitOpen: boolean;
  timeouts: number;
  lastError?: string;
}

const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 30_000;

/**
 * Model pool + router: per-endpoint concurrency slots, retry with exponential
 * backoff, circuit breaker, role/load-aware model selection and automatic
 * fallback to other models (or waiting for recovery when all are down).
 */
export class Router {
  readonly models = new Map<string, ModelHandle>();
  private readonly endpointSlots = new Map<string, Semaphore>();
  /** requests-per-minute limiters by endpoint name (endpoints behind one key share one) */
  private readonly rpm = new Map<string, RateLimiter>();

  constructor(
    readonly config: KurultayConfig,
    private readonly bus?: EventBus,
  ) {
    this.speedBand = config.orchestrator?.speedBand ?? 3;
  }

  /** Register models from probe results (or discovered ids with default caps). */
  register(caps: ModelCapabilities[]): void {
    for (const c of caps) {
      const ep = this.config.endpoints.find((e) => e.name === c.endpoint);
      if (!ep || ep.disabled) continue;
      // capabilities.json may be older than the config: honour the endpoint's model whitelist
      if (ep.models?.length && !ep.models.includes(c.model)) continue;
      const own = this.config.models[c.key] ?? this.config.models[c.model] ?? {};
      // endpoint-wide roles (the helper section) apply unless the model sets its own
      const override: ModelOverride = ep.roles?.length ? { roles: ep.roles, rolesOnly: ep.rolesOnly, ...own } : own;
      if (override.disabled) continue;
      const merged: ModelCapabilities = {
        ...c,
        contextWindow: override.contextWindow ?? c.contextWindow,
        maxOutputTokens: override.maxOutputTokens ?? c.maxOutputTokens,
        nativeTools: override.nativeTools ?? c.nativeTools,
        roleScores: override.roles
          ? (Object.fromEntries(ALL_ROLES.map((r) => [r, override.roles!.includes(r) ? 1 : Math.min(0.2, c.roleScores[r])])) as Record<Role, number>)
          : c.roleScores,
      };
      this.models.set(c.key, {
        caps: merged,
        client: clientFor(ep, override),
        override,
        preset: override.preset === false || this.config.llm.samplingPresets === false ? undefined : presetFor(c.model),
        health: { consecutiveFailures: 0, circuitOpenUntil: 0, successes: 0, failures: 0, ewmaMsPerToken: 0, consecutiveTimeouts: 0, timeouts: 0 },
      });
      if (ep.requestsPerMinute && ep.requestsPerMinute > 0 && !this.rpm.has(ep.name)) {
        // one limiter per provider key: a free tier counts every model of the key together
        const same = this.config.endpoints.find((o) => o.name !== ep.name && this.rpm.has(o.name) && o.baseUrl === ep.baseUrl && (o.apiKey ?? '') === (ep.apiKey ?? ''));
        this.rpm.set(ep.name, same ? this.rpm.get(same.name)! : new RateLimiter(ep.requestsPerMinute));
      }
      if (!this.endpointSlots.has(ep.name)) {
        const limit = ep.maxConcurrency && ep.maxConcurrency > 0 ? ep.maxConcurrency : Math.max(1, c.maxConcurrency || 2);
        this.endpointSlots.set(ep.name, new Semaphore(limit));
      } else if (!(ep.maxConcurrency && ep.maxConcurrency > 0) && c.maxConcurrency) {
        const s = this.endpointSlots.get(ep.name)!;
        s.setLimit(Math.max(s.limit, c.maxConcurrency));
      }
    }
  }

  /** Discover models from endpoints when no probe results exist. */
  async discover(signal?: AbortSignal): Promise<ModelCapabilities[]> {
    const out: ModelCapabilities[] = [];
    await Promise.all(
      this.config.endpoints
        .filter((e) => !e.disabled)
        .map(async (ep) => {
          let ids: Array<{ id: string; contextWindow?: number }> = ep.models?.length ? ep.models.map((id) => ({ id })) : [];
          if (!ids.length) {
            try {
              ids = await new OpenAICompatClient(ep).listModels(signal);
            } catch (e) {
              this.bus?.warn('router', `${ep.name}: could not list models – ${(e as Error).message}`);
            }
          }
          for (const m of ids) {
            if (NON_CHAT_MODEL.test(m.id)) continue; // embedding / reranker models cannot chat
            const c = defaultCapabilities(m.id, ep.name);
            if (m.contextWindow) c.contextWindow = m.contextWindow;
            out.push(c);
          }
        }),
    );
    return out;
  }

  list(): ModelHandle[] {
    return [...this.models.values()];
  }

  get size(): number {
    return this.models.size;
  }

  get(key: string): ModelHandle | undefined {
    return this.models.get(key);
  }

  slotsFor(endpoint: string): Semaphore {
    let s = this.endpointSlots.get(endpoint);
    if (!s) {
      s = new Semaphore(2);
      this.endpointSlots.set(endpoint, s);
    }
    return s;
  }

  /** Total parallel capacity across all endpoints. */
  totalCapacity(): number {
    let n = 0;
    for (const s of this.endpointSlots.values()) n += s.limit;
    return Math.max(1, n);
  }

  stats(): RouterStats[] {
    const now = Date.now();
    return this.list().map((h) => {
      const s = this.slotsFor(h.caps.endpoint);
      return {
        key: h.caps.key,
        active: s.inUse,
        queued: s.queued,
        limit: s.limit,
        successes: h.health.successes,
        failures: h.health.failures,
        circuitOpen: h.health.circuitOpenUntil > now,
        timeouts: h.health.timeouts,
        lastError: h.health.lastError,
      };
    });
  }

  private available(h: ModelHandle, now = Date.now()): boolean {
    return h.caps.reachable && h.health.circuitOpenUntil <= now;
  }

  /**
   * A model that keeps answering only after others did (hedged requests won by the backup):
   * keep it out of new work for a while, like an open circuit breaker.
   */
  markStalled(key: string, ms = 5 * 60_000): void {
    const h = this.models.get(key);
    if (!h) return;
    h.health.circuitOpenUntil = Math.max(h.health.circuitOpenUntil, Date.now() + ms);
    this.bus?.warn('router', `${key} answers too late; not used for new work for ${Math.round(ms / 60_000)} min`);
  }

  /** Score for picking a model for a role, discounted by current load. */
  /** learned per-role quality (set by createApp; tests run without) */
  learned: ModelStats | undefined;

  /** Record how a model did in a role (verified code, usable plan/review …). */
  recordOutcome(key: string, role: Role, ok: boolean | number): void {
    if (!this.models.has(key)) return;
    this.learned?.record(key, role, ok);
    this.bus?.emitEvent('model.outcome', { source: key, data: { role, ok } });
  }

  private score(h: ModelHandle, role: Role | undefined): number {
    const prior = role ? h.caps.roleScores[role] ?? 0.5 : 0.5;
    // probe score is the prior; real outcomes (stats) move it
    const base = role && this.learned ? this.learned.quality(h.caps.key, role, prior) : prior;
    const s = this.slotsFor(h.caps.endpoint);
    const load = (s.inUse + s.queued) / Math.max(1, s.limit);
    const reliability = (h.health.successes + 1) / (h.health.successes + h.health.failures + 2);
    return base * (0.55 + 0.45 * reliability) * (1 / (1 + 0.6 * load)) * (this.isPrimary(h) && role && PRIMARY_ROLES.has(role) ? 1.6 : 1);
  }

  /** The configured main model (ModelOverride.primary or orchestrator.primaryModel). */
  isPrimary(h: ModelHandle): boolean {
    const p = this.config.orchestrator?.primaryModel;
    return !!h.override.primary || (!!p && (h.caps.key === p || h.caps.model === p));
  }

  /**
   * Rank candidate models for a request.
   * `minContext` filters out models whose window cannot hold the prompt.
   */
  rank(role?: Role, opts: { exclude?: string[]; only?: string[]; minContext?: number; includeUnavailable?: boolean } = {}): ModelHandle[] {
    const now = Date.now();
    const list = this.list()
      .filter((h) => (opts.only ? opts.only.includes(h.caps.key) : true))
      .filter((h) => !opts.exclude?.includes(h.caps.key))
      .filter((h) => opts.includeUnavailable || this.available(h, now))
      .filter((h) => !opts.minContext || h.caps.contextWindow >= opts.minContext)
      .sort((a, b) => this.score(b, role) - this.score(a, role));
    // rolesOnly models (helpers) only do their own roles – unless nothing else is left
    if (!role) return list;
    const allowed = list.filter((h) => this.allows(h, role));
    if (allowed.length) return allowed;
    // the proper models were excluded on purpose (e.g. the authors of the code under review):
    // a helper must not step in for them
    if (opts.exclude?.length && this.list().some((h) => opts.exclude!.includes(h.caps.key) && this.allows(h, role))) return [];
    return list;
  }

  /** May this model take work of this role? (rolesOnly restricts it to its pinned roles) */
  allows(h: ModelHandle, role: Role): boolean {
    return !h.override.rolesOnly || !!h.override.roles?.includes(role);
  }

  /** Pick up to n distinct models for a role, spreading across endpoints first. */
  /**
   * Speed band: a model this many times slower than the best model of the role is left out of
   * the steps that wait for every participant (plan drafts, race, reviews, judges) – the slowest
   * member sets the pace of such a step ("The Tail at Scale"). 0 = off. The orchestrator turns it
   * off to escalate to the slower (often stronger) models when the fast ones failed.
   */
  speedBand: number;

  /**
   * Expected milliseconds per output token including the wait for the first token: the live
   * average once a model has answered a few requests, the probe's numbers before that.
   * undefined = unknown (never measured).
   */
  msPerToken(h: ModelHandle): number | undefined {
    if (h.health.successes >= 3 && h.health.ewmaMsPerToken > 0) return h.health.ewmaMsPerToken;
    if (h.caps.tokensPerSec > 0) return (h.caps.ttftMs + (800 * 1000) / h.caps.tokensPerSec) / 800;
    return undefined;
  }

  /** Is the model within the speed band of the role's best model? Unmeasured models are. */
  inSpeedBand(h: ModelHandle, role: Role): boolean {
    const band = this.speedBand;
    // summaries and other light work are spread over every model for throughput – nobody waits
    // for one particular answer there, so the band only applies to the deciding roles
    if (!band || role === 'summarizer' || role === 'fast') return true;
    const ref = this.rank(role)[0];
    const a = this.msPerToken(h);
    const b = ref && this.msPerToken(ref);
    if (!a || !b) return true;
    return a <= band * b;
  }

  /**
   * Pick up to n distinct models for a role, spreading across endpoints first. Models outside
   * the speed band are left out; with `strictBand` none of them is used even when that leaves
   * nobody, otherwise the band is ignored when it would leave nobody.
   */
  pick(role: Role, n: number, exclude: string[] = [], opts: { strictBand?: boolean } = {}): ModelHandle[] {
    const all = this.rank(role, { exclude });
    const fast = all.filter((h) => this.inSpeedBand(h, role));
    const ranked = fast.length || opts.strictBand ? fast : all;
    const chosen: ModelHandle[] = [];
    const usedEndpoints = new Set<string>();
    for (const h of ranked) {
      if (chosen.length >= n) break;
      if (!usedEndpoints.has(h.caps.endpoint)) {
        chosen.push(h);
        usedEndpoints.add(h.caps.endpoint);
      }
    }
    for (const h of ranked) {
      if (chosen.length >= n) break;
      if (!chosen.includes(h)) chosen.push(h);
    }
    return chosen;
  }

  best(role: Role, exclude: string[] = []): ModelHandle | undefined {
    return this.rank(role, { exclude })[0];
  }

  private get llm(): LlmConfig {
    return { ...DEFAULT_CONFIG.llm, ...(this.config.llm ?? {}) };
  }

  /**
   * Sampling for one request. Precedence: the model's configured temperature/extraBody >
   * the publisher preset (agentic calls only) > the caller's temperature.
   */
  samplingFor(h: ModelHandle, req: ChatRequest): { temperature?: number; body?: Record<string, unknown>; noThink: boolean } {
    const p = h.preset;
    const usePreset = !!p && !!req.agentic;
    const temperature = h.override.temperature ?? (usePreset && p!.temperature !== undefined ? p!.temperature : req.temperature);
    let body = usePreset && !h.presetRejected ? presetBody(p!) : undefined;
    const quick = this.quickThinking(h, req);
    if (quick) body = { ...body, ...quick };
    return { temperature, body: body && Object.keys(body).length ? body : undefined, noThink: (!!p?.hybridThinking && h.override.thinking !== true) || (!!quick && !!p?.hybridThinking) };
  }

  /**
   * Request fields that switch hidden reasoning off for a short structured answer.
   * `chat_template_kwargs.enable_thinking` is read by the Qwen3 / GLM chat templates in
   * vLLM, SGLang and llama.cpp (llama-server); `reasoning_effort` by gpt-oss. Servers or
   * templates that do not know them ignore them; a server that rejects them is
   * remembered and asked without them.
   */
  quickThinking(h: ModelHandle, req: ChatRequest): Record<string, unknown> | undefined {
    if (req.agentic || h.thinkOffRejected || h.override.thinking === true || this.llm.quickStructured === false) return undefined;
    if (!QUICK_PURPOSE.test(req.purpose ?? '')) return undefined;
    const id = h.caps.model.toLowerCase();
    if (/gpt-?oss/.test(id)) return { reasoning_effort: 'low' };
    if (!h.caps.thinking && !/qwen-?3|qwq|glm-?4\.[5-9]|deepseek-?(r1|v3\.[1-9])|thinking|reason/.test(id)) return undefined;
    return { chat_template_kwargs: { enable_thinking: false } };
  }

  /** Timeouts for one model: model override > endpoint > llm defaults; first-token grows with the prompt. */
  timeoutsFor(h: ModelHandle, promptTokens: number): { timeoutMs: number; firstTokenTimeoutMs?: number; idleTimeoutMs?: number } {
    const l = this.llm;
    const ep = h.client.endpoint;
    const first = h.override.firstTokenTimeoutMs ?? ep.firstTokenTimeoutMs ?? l.firstTokenTimeoutMs;
    const idle = h.override.idleTimeoutMs ?? ep.idleTimeoutMs ?? l.idleTimeoutMs;
    const total = h.override.timeoutMs ?? ep.timeoutMs ?? l.timeoutMs;
    return {
      timeoutMs: total,
      firstTokenTimeoutMs: first > 0 ? Math.min(total, first + Math.round(promptTokens * l.prefillMsPerToken)) : undefined,
      idleTimeoutMs: idle > 0 ? idle : undefined,
    };
  }

  private onSuccess(h: ModelHandle, r: ChatResult): void {
    h.health.consecutiveFailures = 0;
    h.health.consecutiveTimeouts = 0;
    h.health.successes++;
    const perTok = r.usage.completionTokens > 0 ? r.durationMs / r.usage.completionTokens : r.durationMs;
    h.health.ewmaMsPerToken = h.health.ewmaMsPerToken ? 0.8 * h.health.ewmaMsPerToken + 0.2 * perTok : perTok;
  }

  private onFailure(h: ModelHandle, e: LlmError): void {
    h.health.failures++;
    h.health.lastError = e.message;
    if (e.kind === 'context_length' || e.kind === 'bad_request' || e.kind === 'aborted') return;
    h.health.consecutiveFailures++;
    if (e.kind === 'timeout') {
      // a model that stops answering is quarantined for every worker (oh-my-openagent runtime fallback)
      h.health.timeouts++;
      h.health.consecutiveTimeouts++;
      const base = this.llm.timeoutCooldownMs;
      if (base > 0) {
        const cooldown = base * Math.min(8, 2 ** (h.health.consecutiveTimeouts - 1));
        h.health.circuitOpenUntil = Math.max(h.health.circuitOpenUntil, Date.now() + cooldown);
        this.bus?.emitEvent('model.quarantine', { source: h.caps.key, message: e.message, data: { ms: cooldown } });
        this.bus?.warn('router', `${h.caps.key} stopped answering; paused for ${Math.round(cooldown / 1000)} s, work moves to the other models`, { error: e.message });
        return;
      }
    }
    if (e.kind === 'auth' || e.kind === 'not_found') {
      h.health.circuitOpenUntil = Date.now() + 10 * 60_000;
      this.bus?.warn('router', `${h.caps.key} disabled for 10 min: ${e.kind}`);
      return;
    }
    if (h.health.consecutiveFailures >= CIRCUIT_THRESHOLD) {
      const cooldown = CIRCUIT_COOLDOWN_MS * Math.min(8, 2 ** (h.health.consecutiveFailures - CIRCUIT_THRESHOLD));
      h.health.circuitOpenUntil = Date.now() + cooldown;
      this.bus?.warn('router', `${h.caps.key} circuit breaker open (${Math.round(cooldown / 1000)} s)`, { error: e.message });
    }
  }

  /**
   * The answer hit max_tokens (finish_reason "length"). Structured answers
   * (JSON, tool calls) or answers that are only reasoning are retried once
   * with a larger budget; plain text is continued up to two times. Without
   * this a cut-off JSON plan looks like a "bad model" and triggers failover.
   */
  private async recoverTruncation(h: ModelHandle, req: ChatRequest, first: ChatResult, maxTokens: number, send: (tokens: number, messages?: ChatRequest['messages']) => Promise<ChatResult>): Promise<ChatResult> {
    const promptTokens = estimateTokens(req.messages.map((m) => (m.content ?? '') + (m.tool_calls ? JSON.stringify(m.tool_calls) : '')).join('\n'));
    const room = h.caps.contextWindow - promptTokens - 256;
    const ceiling = Math.min(room, Math.max(h.override.maxOutputTokens ?? h.caps.maxOutputTokens, 16_384));
    const structured = !!req.jsonMode || !!req.tools?.length || first.toolCalls.length > 0 || !first.content.trim();
    this.bus?.emitEvent('llm.truncated', { source: h.caps.key, data: { purpose: req.purpose, maxTokens, structured } });
    const add = (a: ChatResult, b: ChatResult): ChatResult => ({
      ...b,
      content: a.content + b.content,
      thinking: [a.thinking, b.thinking].filter(Boolean).join('\n'),
      usage: { promptTokens: a.usage.promptTokens + b.usage.promptTokens, completionTokens: a.usage.completionTokens + b.usage.completionTokens },
      durationMs: a.durationMs + b.durationMs,
    });
    try {
      if (structured) {
        const bigger = Math.min(ceiling, maxTokens * 2);
        if (bigger <= maxTokens * 1.2) return first;
        this.bus?.debug('router', `${h.caps.key} answer was cut at ${maxTokens} tokens; asking again with ${bigger}`);
        h.outputBoost = Math.min(4, (h.outputBoost ?? 1) * 2);
        const again = await send(bigger);
        return { ...again, usage: { promptTokens: first.usage.promptTokens + again.usage.promptTokens, completionTokens: first.usage.completionTokens + again.usage.completionTokens } };
      }
      let r = first;
      for (let round = 0; round < 2 && r.finishReason === 'length'; round++) {
        const next = await send(Math.min(maxTokens, Math.max(256, ceiling)), [
          ...req.messages,
          { role: 'assistant', content: r.content },
          { role: 'user', content: 'Continue exactly where you stopped. Do not repeat anything you already wrote.' },
        ]);
        r = add(r, next);
      }
      return r;
    } catch {
      return first; // the partial answer is still better than nothing
    }
  }

  /** Call one specific model with retries (no fallback). */
  async callModel(h: ModelHandle, req: ChatRequest, attempts = 3, retryBaseMs = 1000): Promise<ChatResult> {
    const slots = this.slotsFor(h.caps.endpoint);
    let lastErr: LlmError | undefined;
    const promptEstimate = estimateTokens(req.messages.map((m) => (m.content ?? '') + (m.tool_calls ? JSON.stringify(m.tool_calls) : '')).join('\n'));
    const limits = this.timeoutsFor(h, promptEstimate);
    let timeouts = 0;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (h.health.circuitOpenUntil > Date.now()) {
        throw new LlmError(`${h.caps.key} circuit breaker open`, 'circuit_open', undefined, h.caps.key);
      }
      const q0 = Date.now();
      await slots.acquire(req.signal);
      const queued = Date.now() - q0;
      if (queued > 250) this.bus?.emitEvent('llm.wait', { source: h.caps.key, data: { reason: 'slot', ms: queued, purpose: req.purpose } });
      const limiter = this.rpm.get(h.caps.endpoint);
      if (limiter) {
        let waited = 0;
        try {
          waited = await limiter.take(req.signal);
        } catch (e) {
          slots.release();
          throw new LlmError(errorMessage(e), 'aborted', undefined, h.caps.key);
        }
        if (waited > 0) this.bus?.emitEvent('llm.wait', { source: h.caps.key, data: { reason: 'rate_limit', ms: waited, purpose: req.purpose } });
      }
      // reasoning models spend part of the output budget on thinking – give them more room
      // a small structured budget (3000 for a plan) is consumed by the thinking alone when the
      // model cannot switch it off (Kimi K3) – floor it, bounded by the room left in the window
      const room = Math.max(1024, h.caps.contextWindow - promptEstimate - 256);
      const thinkingFloor = Math.min(room, Math.max(8192, Math.min(h.caps.maxOutputTokens, 32_768)));
      const asked = h.caps.thinking
        ? Math.max(req.maxTokens ?? 0, thinkingFloor)
        : (req.maxTokens ?? Math.min(h.caps.maxOutputTokens, 8192));
      const maxTokens = h.outputBoost && req.maxTokens ? Math.round(Math.min(asked * h.outputBoost, Math.max(asked, h.caps.contextWindow - promptEstimate - 256))) : asked;
      try {
        const send = async (tokens: number, messages = req.messages): Promise<ChatResult> => {
          // prompt estimate + window: the console shows how full each model's context is while it works
          const prompt = messages === req.messages ? promptEstimate : estimateTokens(messages.map((m) => m.content ?? '').join('\n'));
          this.bus?.emitEvent('llm.request', { source: h.caps.key, data: { purpose: req.purpose, attempt, prompt, window: h.caps.contextWindow, maxTokens: tokens, ...(req.promptParts ? { parts: req.promptParts } : {}) } });
          const sampling = this.samplingFor(h, req);
          const res = await h.client.chat(
            h.caps.model,
            {
              ...req,
              messages: sampling.noThink ? withNoThink(messages) : messages,
              timeoutMs: req.timeoutMs ?? limits.timeoutMs,
              firstTokenTimeoutMs: req.firstTokenTimeoutMs ?? limits.firstTokenTimeoutMs,
              idleTimeoutMs: req.idleTimeoutMs ?? limits.idleTimeoutMs,
              maxTokens: tokens,
              temperature: sampling.temperature,
              jsonMode: (req.jsonMode || !!req.jsonSchema) && h.caps.jsonMode,
              // constrained decoding unless this server is known not to support it
              jsonSchema: req.jsonSchema && h.caps.jsonSchema !== false ? req.jsonSchema : undefined,
              stream: req.stream ?? h.caps.streaming,
            },
            sampling.body || h.override.extraBody ? { ...sampling.body, ...h.override.extraBody } : undefined,
          );
          this.bus?.emitEvent('llm.response', {
            source: h.caps.key,
            data: { purpose: req.purpose, ms: res.durationMs, in: res.usage.promptTokens, out: res.usage.completionTokens, finish: res.finishReason, window: h.caps.contextWindow },
          });
          return res;
        };
        let r = await send(maxTokens);
        if (r.finishReason === 'length') r = await this.recoverTruncation(h, req, r, maxTokens, send);
        this.onSuccess(h, r);
        return r;
      } catch (e) {
        const err = e instanceof LlmError ? e : new LlmError(String(e), 'network', undefined, h.caps.key);
        // server rejected the preset's sampling fields (top_k, min_p…) → drop them and retry
        if (err.kind === 'bad_request' && h.preset && !h.presetRejected && req.agentic && /top_k|top_p|min_p|repetition|repeat_penalty|unrecognized|unknown|extra/i.test(err.message)) {
          h.presetRejected = true;
          this.bus?.info('router', `${h.caps.key} rejects extra sampling fields; using the server defaults`);
          attempt--;
          continue;
        }
        // server rejected the switch that turns thinking off → remember and retry with thinking
        if (err.kind === 'bad_request' && !h.thinkOffRejected && this.quickThinking(h, req) && /chat_template_kwargs|enable_thinking|reasoning_effort|unrecognized|unknown|extra/i.test(err.message)) {
          h.thinkOffRejected = true;
          this.bus?.info('router', `${h.caps.key} rejects chat_template_kwargs; structured answers keep thinking`);
          attempt--;
          continue;
        }
        // server rejected json_schema → remember and retry right away with plain JSON mode
        if (err.kind === 'bad_request' && req.jsonSchema && h.caps.jsonSchema !== false && /response_format|json_schema|schema|guided|grammar/i.test(err.message)) {
          h.caps.jsonSchema = false;
          this.bus?.info('router', `${h.caps.key} does not support json_schema; using JSON mode`);
          attempt--;
          continue;
        }
        lastErr = err;
        this.onFailure(h, err);
        const final = !err.retryable || attempt === attempts || (err.kind === 'timeout' && timeouts + 1 > this.llm.timeoutRetries);
        this.bus?.emitEvent('llm.error', { source: h.caps.key, message: err.message, data: { kind: err.kind, attempt, purpose: req.purpose, retry: !final } });
        if (!err.retryable || attempt === attempts) throw err;
        // a hung model is not retried by default – fail over immediately (llm.timeoutRetries)
        if (err.kind === 'timeout' && ++timeouts > this.llm.timeoutRetries) throw err;
        const backoff = Math.min(30_000, retryBaseMs * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
        // honour Retry-After (OpenCode model-retry), but never wait more than 5 minutes per attempt
        // a reused keep-alive connection the server (or a proxy) already closed: retry at once
        const dropped = err.kind === 'network' && attempt === 1 && /ECONNRESET|EPIPE|socket hang up|other side closed|UND_ERR_SOCKET/i.test(err.message);
        const wait = dropped ? 0 : err.retryAfterMs !== undefined ? Math.min(5 * 60_000, Math.max(backoff, err.retryAfterMs)) : err.kind === 'rate_limit' ? backoff * 2 : backoff;
        if (err.kind === 'rate_limit') this.bus?.emitEvent('llm.wait', { source: h.caps.key, data: { reason: 'rate_limit', ms: Math.round(wait), purpose: req.purpose } });
        await sleep(wait, req.signal);
      } finally {
        slots.release();
      }
    }
    throw lastErr ?? new LlmError('unknown error', 'server', undefined, h.caps.key);
  }

  /**
   * Route a chat request: best model for the role first, then fall back.
   * When every model fails with connection-type errors, wait and retry
   * until `recoveryWaitMs` elapses (wait and retry when the connection drops).
   */
  async chat(req: ChatRequest, opts: RouteOptions = {}): Promise<ChatResult> {
    if (this.models.size === 0) throw new LlmError('No registered model – check the endpoint configuration and the output of "kurultay probe"', 'not_found');
    const promptTokens = estimateTokens(req.messages.map((m) => m.content ?? '').join('\n')) + 512;
    const deadline = Date.now() + (opts.recoveryWaitMs ?? 10 * 60_000);
    const tried = new Set<string>();
    let lastErr: LlmError | undefined;
    let round = 0;

    while (true) {
      const ordered: ModelHandle[] = [];
      const pushKey = (k: string) => {
        const h = this.models.get(k);
        if (h && !ordered.includes(h)) ordered.push(h);
      };
      opts.prefer?.forEach(pushKey);
      const allowFallback = opts.fallback !== false || !opts.prefer?.length;
      if (allowFallback) {
        for (const h of this.rank(opts.role, { exclude: opts.exclude, only: opts.only, minContext: promptTokens })) {
          if (!ordered.includes(h)) ordered.push(h);
        }
        // if nothing fits the context, still try the biggest windows
        if (!ordered.length) {
          for (const h of this.rank(opts.role, { exclude: opts.exclude, only: opts.only }).sort((a, b) => b.caps.contextWindow - a.caps.contextWindow)) {
            ordered.push(h);
          }
        }
      }
      const candidates = ordered.filter((h) => !opts.exclude?.includes(h.caps.key) && (!opts.only || opts.only.includes(h.caps.key)) && !tried.has(h.caps.key));
      if (!candidates.length && !lastErr && !this.rank(opts.role, { exclude: opts.exclude, only: opts.only, includeUnavailable: true }).length) {
        throw new LlmError('No model matches the requested constraints', 'not_found');
      }

      for (const h of candidates) {
        if (req.signal?.aborted) throw new LlmError('aborted', 'aborted');
        try {
          return await this.callModel(h, req, opts.attemptsPerModel ?? 3, opts.retryBaseMs ?? 1000);
        } catch (e) {
          const err = e as LlmError;
          lastErr = err;
          if (err.kind === 'aborted') throw err;
          tried.add(h.caps.key);
          this.bus?.info('router', `${h.caps.key} failed (${err.kind}), trying the next model`);
        }
      }

      const connectionTrouble = !lastErr || ['network', 'timeout', 'server', 'rate_limit', 'circuit_open'].includes(lastErr.kind);
      if (!connectionTrouble || Date.now() >= deadline) break;
      round++;
      const wait = Math.min(60_000, (opts.recoveryIntervalMs ?? 5000) * 2 ** Math.min(round - 1, 4), Math.max(0, deadline - Date.now()));
      this.bus?.warn('router', `All models are unreachable; retrying in ${Math.round(wait / 1000)} s`, { round });
      await sleep(wait, req.signal);
      tried.clear();
      // let open circuits be re-tested after waiting
      for (const h of this.models.values()) {
        if (h.health.circuitOpenUntil > Date.now() && h.health.consecutiveFailures < 10) h.health.circuitOpenUntil = 0;
      }
    }
    throw lastErr ?? new LlmError('No suitable model found', 'not_found');
  }
}

/** Qwen3 hybrid models: the /no_think soft switch at the end of the system prompt turns reasoning off. */
export function withNoThink(messages: ChatMessage[]): ChatMessage[] {
  const i = messages.findIndex((m) => m.role === 'system');
  if (i >= 0) {
    if ((messages[i].content ?? '').includes('/no_think')) return messages;
    return messages.map((m, j) => (j === i ? { ...m, content: `${m.content ?? ''}\n/no_think` } : m));
  }
  return [{ role: 'system', content: '/no_think' }, ...messages];
}
