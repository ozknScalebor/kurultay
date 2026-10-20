import { ALL_ROLES, type KurultayConfig, type ModelOverride, type Role } from '../config.js';
import { Semaphore, sleep } from '../util/async.js';
import type { EventBus } from '../util/events.js';
import { estimateTokens } from '../util/text.js';
import { OpenAICompatClient } from './client.js';
import { defaultCapabilities, type ModelCapabilities } from './models.js';
import { LlmError, type ChatRequest, type ChatResult } from './types.js';

interface Health {
  consecutiveFailures: number;
  circuitOpenUntil: number;
  successes: number;
  failures: number;
  /** exponentially-weighted latency per completion token, ms */
  ewmaMsPerToken: number;
  lastError?: string;
}

export interface ModelHandle {
  caps: ModelCapabilities;
  client: OpenAICompatClient;
  override: ModelOverride;
  health: Health;
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
}

export interface RouterStats {
  key: string;
  active: number;
  queued: number;
  limit: number;
  successes: number;
  failures: number;
  circuitOpen: boolean;
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

  constructor(
    readonly config: KurultayConfig,
    private readonly bus?: EventBus,
  ) {}

  /** Register models from probe results (or discovered ids with default caps). */
  register(caps: ModelCapabilities[]): void {
    for (const c of caps) {
      const ep = this.config.endpoints.find((e) => e.name === c.endpoint);
      if (!ep || ep.disabled) continue;
      // capabilities.json may be older than the config: honour the endpoint's model whitelist
      if (ep.models?.length && !ep.models.includes(c.model)) continue;
      const override = this.config.models[c.key] ?? this.config.models[c.model] ?? {};
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
        client: new OpenAICompatClient(ep),
        override,
        health: { consecutiveFailures: 0, circuitOpenUntil: 0, successes: 0, failures: 0, ewmaMsPerToken: 0 },
      });
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
              this.bus?.warn('router', `${ep.name}: model listesi alınamadı – ${(e as Error).message}`);
            }
          }
          for (const m of ids) {
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
        lastError: h.health.lastError,
      };
    });
  }

  private available(h: ModelHandle, now = Date.now()): boolean {
    return h.caps.reachable && h.health.circuitOpenUntil <= now;
  }

  /** Score for picking a model for a role, discounted by current load. */
  private score(h: ModelHandle, role: Role | undefined): number {
    const base = role ? h.caps.roleScores[role] ?? 0.5 : 0.5;
    const s = this.slotsFor(h.caps.endpoint);
    const load = (s.inUse + s.queued) / Math.max(1, s.limit);
    const reliability = (h.health.successes + 1) / (h.health.successes + h.health.failures + 2);
    return base * (0.55 + 0.45 * reliability) * (1 / (1 + 0.6 * load));
  }

  /**
   * Rank candidate models for a request.
   * `minContext` filters out models whose window cannot hold the prompt.
   */
  rank(role?: Role, opts: { exclude?: string[]; only?: string[]; minContext?: number; includeUnavailable?: boolean } = {}): ModelHandle[] {
    const now = Date.now();
    return this.list()
      .filter((h) => (opts.only ? opts.only.includes(h.caps.key) : true))
      .filter((h) => !opts.exclude?.includes(h.caps.key))
      .filter((h) => opts.includeUnavailable || this.available(h, now))
      .filter((h) => !opts.minContext || h.caps.contextWindow >= opts.minContext)
      .sort((a, b) => this.score(b, role) - this.score(a, role));
  }

  /** Pick up to n distinct models for a role, spreading across endpoints first. */
  pick(role: Role, n: number, exclude: string[] = []): ModelHandle[] {
    const ranked = this.rank(role, { exclude });
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

  private onSuccess(h: ModelHandle, r: ChatResult): void {
    h.health.consecutiveFailures = 0;
    h.health.successes++;
    const perTok = r.usage.completionTokens > 0 ? r.durationMs / r.usage.completionTokens : r.durationMs;
    h.health.ewmaMsPerToken = h.health.ewmaMsPerToken ? 0.8 * h.health.ewmaMsPerToken + 0.2 * perTok : perTok;
  }

  private onFailure(h: ModelHandle, e: LlmError): void {
    h.health.failures++;
    h.health.lastError = e.message;
    if (e.kind === 'context_length' || e.kind === 'bad_request' || e.kind === 'aborted') return;
    h.health.consecutiveFailures++;
    if (e.kind === 'auth' || e.kind === 'not_found') {
      h.health.circuitOpenUntil = Date.now() + 10 * 60_000;
      this.bus?.warn('router', `${h.caps.key} devre dışı (10 dk): ${e.kind}`);
      return;
    }
    if (h.health.consecutiveFailures >= CIRCUIT_THRESHOLD) {
      const cooldown = CIRCUIT_COOLDOWN_MS * Math.min(8, 2 ** (h.health.consecutiveFailures - CIRCUIT_THRESHOLD));
      h.health.circuitOpenUntil = Date.now() + cooldown;
      this.bus?.warn('router', `${h.caps.key} devre kesici açık (${Math.round(cooldown / 1000)} sn)`, { error: e.message });
    }
  }

  /** Call one specific model with retries (no fallback). */
  async callModel(h: ModelHandle, req: ChatRequest, attempts = 3): Promise<ChatResult> {
    const slots = this.slotsFor(h.caps.endpoint);
    let lastErr: LlmError | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (h.health.circuitOpenUntil > Date.now()) {
        throw new LlmError(`${h.caps.key} devre kesici açık`, 'circuit_open', undefined, h.caps.key);
      }
      await slots.acquire(req.signal);
      const maxTokens = req.maxTokens ?? Math.min(h.caps.maxOutputTokens, 8192);
      try {
        this.bus?.emitEvent('llm.request', { source: h.caps.key, data: { purpose: req.purpose, attempt } });
        const r = await h.client.chat(
          h.caps.model,
          {
            ...req,
            maxTokens,
            temperature: req.temperature ?? h.override.temperature,
            jsonMode: req.jsonMode && h.caps.jsonMode,
            stream: req.stream ?? h.caps.streaming,
          },
          h.override.extraBody,
        );
        this.onSuccess(h, r);
        this.bus?.emitEvent('llm.response', {
          source: h.caps.key,
          data: { purpose: req.purpose, ms: r.durationMs, in: r.usage.promptTokens, out: r.usage.completionTokens },
        });
        return r;
      } catch (e) {
        const err = e instanceof LlmError ? e : new LlmError(String(e), 'network', undefined, h.caps.key);
        lastErr = err;
        this.onFailure(h, err);
        this.bus?.emitEvent('llm.error', { source: h.caps.key, message: err.message, data: { kind: err.kind, attempt } });
        if (!err.retryable || attempt === attempts) throw err;
        const backoff = Math.min(30_000, 1000 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
        await sleep(err.kind === 'rate_limit' ? backoff * 2 : backoff, req.signal);
      } finally {
        slots.release();
      }
    }
    throw lastErr ?? new LlmError('bilinmeyen hata', 'server', undefined, h.caps.key);
  }

  /**
   * Route a chat request: best model for the role first, then fall back.
   * When every model fails with connection-type errors, wait and retry
   * until `recoveryWaitMs` elapses (bağlantı koparsa bekle-tekrar dene).
   */
  async chat(req: ChatRequest, opts: RouteOptions = {}): Promise<ChatResult> {
    if (this.models.size === 0) throw new LlmError('Kayıtlı model yok – endpoint yapılandırmasını ve "kurultay probe" çıktısını kontrol edin', 'not_found');
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
        throw new LlmError('İstenen kısıtlara uyan model yok', 'not_found');
      }

      for (const h of candidates) {
        if (req.signal?.aborted) throw new LlmError('aborted', 'aborted');
        try {
          return await this.callModel(h, req, opts.attemptsPerModel ?? 3);
        } catch (e) {
          const err = e as LlmError;
          lastErr = err;
          if (err.kind === 'aborted') throw err;
          tried.add(h.caps.key);
          this.bus?.info('router', `${h.caps.key} başarısız (${err.kind}), sıradaki modele geçiliyor`);
        }
      }

      const connectionTrouble = !lastErr || ['network', 'timeout', 'server', 'rate_limit', 'circuit_open'].includes(lastErr.kind);
      if (!connectionTrouble || Date.now() >= deadline) break;
      round++;
      const wait = Math.min(60_000, 5000 * 2 ** Math.min(round - 1, 4));
      this.bus?.warn('router', `Tüm modeller erişilemez durumda; ${Math.round(wait / 1000)} sn sonra tekrar denenecek`, { round });
      await sleep(wait, req.signal);
      tried.clear();
      // let open circuits be re-tested after waiting
      for (const h of this.models.values()) {
        if (h.health.circuitOpenUntil > Date.now() && h.health.consecutiveFailures < 10) h.health.circuitOpenUntil = 0;
      }
    }
    throw lastErr ?? new LlmError('Uygun model bulunamadı', 'not_found');
  }
}
