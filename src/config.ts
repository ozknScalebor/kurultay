import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type Role = 'planner' | 'coder' | 'summarizer' | 'reviewer' | 'judge' | 'fast';
export const ALL_ROLES: Role[] = ['planner', 'coder', 'summarizer', 'reviewer', 'judge', 'fast'];

export interface EndpointConfig {
  /** short unique name, e.g. "gpu1" */
  name: string;
  /** OpenAI-compatible base URL, e.g. http://10.1.2.3:8000/v1 */
  baseUrl: string;
  apiKey?: string;
  /** Restrict to these model ids. Empty/undefined = discover via GET /models */
  models?: string[];
  /** Max simultaneous requests to this endpoint (shared by its models). 0 = probe decides */
  maxConcurrency?: number;
  /** total time limit per request (overrides llm.timeoutMs) */
  timeoutMs?: number;
  /** overrides llm.firstTokenTimeoutMs for this endpoint */
  firstTokenTimeoutMs?: number;
  /** overrides llm.idleTimeoutMs for this endpoint */
  idleTimeoutMs?: number;
  headers?: Record<string, string>;
  disabled?: boolean;
}

export interface ModelOverride {
  contextWindow?: number;
  maxOutputTokens?: number;
  /** force-enable / disable native tool calling */
  nativeTools?: boolean;
  /** pin roles instead of using probe scores */
  roles?: Role[];
  disabled?: boolean;
  temperature?: number;
  /** extra body fields merged into every request (e.g. {"top_k": 20}) */
  extraBody?: Record<string, unknown>;
  /** per-model timeouts (override endpoint and llm settings) */
  timeoutMs?: number;
  firstTokenTimeoutMs?: number;
  idleTimeoutMs?: number;
}

/**
 * Request watchdogs and what happens when a model stops answering.
 * Ideas: Codex stream_idle_timeout_ms, OpenCode/Kilo chunkTimeout,
 * oh-my-openagent runtime fallback.
 */
export interface LlmConfig {
  /** hard limit for one request, ms */
  timeoutMs: number;
  /** no first token (content, reasoning or tool call) within this time → timeout; 0 = off */
  firstTokenTimeoutMs: number;
  /** extra first-token allowance per prompt token (long prompts need prefill time), ms */
  prefillMsPerToken: number;
  /** stream silent for this long after it started → timeout; 0 = off */
  idleTimeoutMs: number;
  /** how often a timed-out request is retried on the SAME model before failing over (default 0) */
  timeoutRetries: number;
  /** a model that timed out is skipped by every worker for this long (doubles on repeats, ×8 max); 0 = off */
  timeoutCooldownMs: number;
  /** a worker whose model failed continues on the replacement and never returns to the failed one */
  stickyFailover: boolean;
}

export interface VerifyConfig {
  /** shell commands; empty string = skip */
  build?: string;
  test?: string;
  lint?: string;
  timeoutMs?: number;
}

export type RunMode = 'auto' | 'single' | 'split' | 'race' | 'council';

export interface OrchestratorConfig {
  defaultMode: RunMode;
  /** how many models compete in race mode */
  raceWidth: number;
  /** how many reviewers in council */
  councilSize: number;
  /** plan → execute → verify → requirement-check loops */
  maxIterations: number;
  maxStepsPerWorker: number;
  /** stop a worker after this many failing tool calls in a row */
  maxConsecutiveErrors?: number;
  /** ask before merging results into the working tree */
  confirmMerge: boolean;
}

export interface IndexConfig {
  include: string[];
  exclude: string[];
  maxFileBytes: number;
  /** language for generated summaries (tr/en) */
  summaryLanguage: string;
  repoMapTokens: number;
}

export interface ToolsConfig {
  allowCommands: boolean;
  /** an existing file must be read before it is edited/overwritten/deleted */
  requireReadBeforeEdit: boolean;
  commandTimeoutMs: number;
  /** regexes; commands matching any are refused */
  denyPatterns: string[];
}

export interface SkillsConfig {
  /** extra skill directories / files */
  paths: string[];
  /** skill names to ignore */
  disabled: string[];
  /** also read ~/.kurultay/skills, ~/.agents/skills, ~/.claude/skills */
  includeUser: boolean;
  /** max skills preloaded per worker (explicit selections not counted) */
  maxPreload: number;
}

export interface KurultayConfig {
  endpoints: EndpointConfig[];
  models: Record<string, ModelOverride>;
  verify: VerifyConfig;
  orchestrator: OrchestratorConfig;
  index: IndexConfig;
  tools: ToolsConfig;
  skills: SkillsConfig;
  llm: LlmConfig;
  /** UI language */
  language: 'tr' | 'en';
  /** where per-project state lives (relative to project root) */
  stateDir: string;
}

export const DEFAULT_CONFIG: Omit<KurultayConfig, 'endpoints'> = {
  models: {},
  verify: { build: '', test: '', lint: '', timeoutMs: 15 * 60_000 },
  orchestrator: {
    defaultMode: 'auto',
    raceWidth: 3,
    councilSize: 3,
    maxIterations: 4,
    maxStepsPerWorker: 40,
    maxConsecutiveErrors: 6,
    confirmMerge: false,
  },
  index: {
    include: [],
    exclude: [],
    maxFileBytes: 512 * 1024,
    summaryLanguage: 'tr',
    repoMapTokens: 2048,
  },
  tools: {
    allowCommands: true,
    requireReadBeforeEdit: true,
    commandTimeoutMs: 10 * 60_000,
    denyPatterns: [
      '\\brm\\s+-rf\\s+/(\\s|$)',
      '\\bmkfs\\b',
      '\\bdd\\s+if=',
      ':\\(\\)\\s*\\{\\s*:\\|:&\\s*\\};:',
      '\\bshutdown\\b',
      '\\breboot\\b',
      '\\bgit\\s+push\\b',
      '\\bcurl\\b[^|]*\\|\\s*(ba)?sh',
    ],
  },
  skills: { paths: [], disabled: [], includeUser: true, maxPreload: 3 },
  llm: {
    timeoutMs: 10 * 60_000,
    firstTokenTimeoutMs: 180_000,
    prefillMsPerToken: 2,
    idleTimeoutMs: 90_000,
    timeoutRetries: 0,
    timeoutCooldownMs: 120_000,
    stickyFailover: true,
  },
  language: 'tr',
  stateDir: '.kurultay',
};

/** Per-user Kurultay folder (global config, capability cache, console history). KURULTAY_HOME overrides. */
export function kurultayHome(): string {
  return process.env.KURULTAY_HOME || join(homedir(), '.kurultay');
}

export const CONFIG_FILE_NAMES = ['kurultay.config.json', '.kurultay/config.json'];

function interpolateEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_m, name: string, def?: string) => process.env[name] ?? def ?? '');
  }
  if (Array.isArray(value)) return value.map(interpolateEnv);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateEnv(v);
    return out;
  }
  return value;
}

function deepMerge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return (over === undefined ? base : (over as T));
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(b, v) : v;
  }
  return out as T;
}

export class ConfigError extends Error {}

export function validateConfig(cfg: KurultayConfig): void {
  if (!Array.isArray(cfg.endpoints) || cfg.endpoints.length === 0) {
    throw new ConfigError('Yapılandırmada en az bir "endpoints" girdisi olmalı.');
  }
  const names = new Set<string>();
  for (const ep of cfg.endpoints) {
    if (!ep.name || !/^[A-Za-z0-9_.-]+$/.test(ep.name)) throw new ConfigError(`Geçersiz endpoint adı: "${ep.name}"`);
    if (names.has(ep.name)) throw new ConfigError(`Endpoint adı tekrar ediyor: ${ep.name}`);
    names.add(ep.name);
    try {
      const u = new URL(ep.baseUrl);
      if (!/^https?:$/.test(u.protocol)) throw new Error();
    } catch {
      throw new ConfigError(`Endpoint "${ep.name}" için geçersiz baseUrl: ${ep.baseUrl}`);
    }
  }
  const modes: RunMode[] = ['auto', 'single', 'split', 'race', 'council'];
  if (!modes.includes(cfg.orchestrator.defaultMode)) throw new ConfigError(`Geçersiz defaultMode: ${cfg.orchestrator.defaultMode}`);
  for (const k of ['timeoutMs', 'firstTokenTimeoutMs', 'prefillMsPerToken', 'idleTimeoutMs', 'timeoutRetries', 'timeoutCooldownMs'] as const) {
    const v = cfg.llm[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new ConfigError(`llm.${k} sıfır veya pozitif bir sayı olmalı (değer: ${JSON.stringify(v)})`);
  }
  if (cfg.llm.timeoutMs < 1000) throw new ConfigError('llm.timeoutMs en az 1000 ms olmalı');
}

export function findConfigFile(projectRoot: string, explicit?: string): string | undefined {
  if (explicit) return resolve(explicit);
  for (const n of CONFIG_FILE_NAMES) {
    const p = join(projectRoot, n);
    if (existsSync(p)) return p;
  }
  const home = join(kurultayHome(), 'config.json');
  if (existsSync(home)) return home;
  return undefined;
}

export function loadConfig(projectRoot: string, explicit?: string): { config: KurultayConfig; path: string } {
  const path = findConfigFile(projectRoot, explicit);
  if (!path || !existsSync(path)) {
    throw new ConfigError(
      'Yapılandırma bulunamadı. Proje kökünde "kurultay init" çalıştırın veya kurultay.config.json oluşturun.',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError(`${path} okunamadı: ${(e as Error).message}`);
  }
  const config = parseConfig(raw);
  return { config, path };
}

export function parseConfig(raw: unknown): KurultayConfig {
  const merged = deepMerge({ ...DEFAULT_CONFIG, endpoints: [] } as KurultayConfig, interpolateEnv(raw));
  merged.endpoints = (merged.endpoints || []).map((e) => ({ ...e, baseUrl: e.baseUrl.replace(/\/+$/, '') }));
  validateConfig(merged);
  return merged;
}

export function modelKey(model: string, endpoint: string): string {
  return `${model}@${endpoint}`;
}

export const SAMPLE_CONFIG = {
  $comment:
    'Kurultay yapılandırması. Her endpoint OpenAI-uyumlu olmalı (vLLM, llama.cpp server, Ollama, LM Studio, TGI, LiteLLM...). apiKey içinde ${ORTAM_DEGISKENI} kullanılabilir.',
  endpoints: [
    { name: 'gpu1', baseUrl: 'http://127.0.0.1:8000/v1', apiKey: '${GPU1_API_KEY:-none}', maxConcurrency: 0 },
    { name: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'ollama', models: [] },
  ],
  models: {},
  verify: { build: '', test: '', lint: '' },
  orchestrator: { defaultMode: 'auto', raceWidth: 3, councilSize: 3, maxIterations: 4, maxStepsPerWorker: 40, confirmMerge: false },
  index: { include: [], exclude: [], summaryLanguage: 'tr', repoMapTokens: 2048 },
  language: 'tr',
};
