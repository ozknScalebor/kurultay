import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LspConfig } from './lsp/client.js';
import type { McpConfig } from './mcp/manager.js';

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
  /** default roles for every model of this endpoint (a model's own `roles` wins) */
  roles?: Role[];
  /** models of this endpoint only take their roles (set for the `helper` section) */
  rolesOnly?: boolean;
  /**
   * Provider request limit (free tiers: e.g. NVIDIA NIM 40). Requests are spaced so the limit is
   * never hit; endpoints with the same base URL and key share it. 0/unset = no limit.
   */
  requestsPerMinute?: number;
}

export interface ModelOverride {
  /**
   * The main model: preferred for coding and planning; the other models add candidates,
   * reviews and the light work around it (`orchestrator.primaryModel` is the short form).
   */
  primary?: boolean;
  /** API key for this model only (default: the endpoint's key) */
  apiKey?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** force-enable / disable native tool calling */
  nativeTools?: boolean;
  /** pin roles instead of using probe scores */
  roles?: Role[];
  /** use this model ONLY for its `roles` (other work goes to other models; it is a last resort when no other model is up) */
  rolesOnly?: boolean;
  disabled?: boolean;
  temperature?: number;
  /** false = do not apply the publisher's recommended sampling (llm/presets.ts) to this model */
  preset?: boolean;
  /**
   * Hybrid reasoning models (Qwen3): false (the default for them) adds the /no_think switch,
   * true keeps the hidden reasoning on.
   */
  thinking?: boolean;
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
  /** apply the publishers' recommended sampling settings to known model families (default true) */
  samplingPresets: boolean;
  /**
   * Switch a reasoning model's hidden thinking off for short structured answers (plans,
   * localisation, summaries) – they then come back in seconds instead of minutes. Coding,
   * reviews and the requirement check keep thinking. Default true.
   */
  quickStructured?: boolean;
  /**
   * Context ladder of a worker, as shares of (window − output reserve):
   * at `microcompactAt` old tool outputs are cleared (newest first kept); at `compactAt` the
   * middle of the conversation becomes a hand-off summary; above 100% the summary keeps fewer
   * recent turns. Defaults 0.6 and 0.85 (Qwen Code / Claude Code auto-compaction at 85%).
   */
  microcompactAt?: number;
  /**
   * Hedged requests: a worker step that takes 2.5× its model's usual time (at least
   * hedgeMinMs, 30 s; 2 min before the first measured step) is also sent to the best other
   * coder; the first answer wins. Default true.
   */
  hedge?: boolean;
  hedgeMinMs?: number;
  compactAt?: number;
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
  /** how many candidates compete in race mode */
  raceWidth: number;
  /**
   * with fewer models than raceWidth, sample the best models again (default true). Repeated
   * sampling raises the chance that one candidate is right (Agentless, SWE-Gym best@k).
   */
  repeatModels?: boolean;
  /** run every candidate against its rivals' reproducing tests to pick the winner (default true) */
  crossTest?: boolean;
  /** narrow the code down (files → functions) before the workers start (default true; projects with 8+ files) */
  localize?: boolean;
  /** save the winning, verified conversations as fine-tuning data (sessions/<id>/trajectories.jsonl; default true) */
  saveTrajectories?: boolean;
  /**
   * Small tasks (short description, 1–2 files to change) skip the plan council and go
   * straight to the coders (default true; only in auto mode without plan approval).
   */
  fastPath?: boolean;
  /**
   * Models more than this many times slower than the best one stay out of the steps that wait
   * for every participant (plan drafts, race, reviews, judges); they come in when the fast
   * models fail. Default 3; 0 turns the band off.
   */
  speedBand?: number;
  /** race mode with build/tests: the main model tries alone first, the race starts only if it fails (default true) */
  cascade?: boolean;
  /** plan drafts of the plan step (default 1: the main model plans; mode "council" asks 3) */
  planDrafts?: number;
  /** short tasks: the coders start at once and the localisation joins them as a hint (default true) */
  parallelLocalize?: boolean;
  /** most files a fast-path task may touch (default 6) */
  fastPathMaxFiles?: number;
  /** model id or key of the main model (see ModelOverride.primary) */
  primaryModel?: string;
  /**
   * In a race, once one candidate is done the others get this share of the time it took
   * (at least 90 s) to finish; slower ones are stopped. 0 = wait for all (default 0.5).
   */
  raceGrace?: number;
  /** the grace period is never shorter than this (default 90 s) */
  raceGraceMinSeconds?: number;
  /** grace after a candidate that passed the build and tests: share of its time (default 0.15) and minimum (15 s) */
  raceGraceVerified?: number;
  raceGraceVerifiedMinSeconds?: number;
  /** how many reviewers in council */
  councilSize: number;
  /** plan → execute → verify → requirement-check loops */
  maxIterations: number;
  maxStepsPerWorker: number;
  /** stop a worker after this many failing tool calls in a row */
  maxConsecutiveErrors?: number;
  /** ask before merging results into the working tree */
  confirmMerge: boolean;
  /** tell workers to reproduce bugs with a failing test first and to leave tests behind (default true) */
  testFirst?: boolean;
  /** show the plan and wait for approval/feedback before writing code (console /plan, run --approve-plan) */
  approvePlan?: boolean;
  /** stop the run (resumable) after this many prompt+completion tokens; 0 = unlimited */
  maxTokens?: number;
  /** stop the run (resumable) after this many minutes; 0 = unlimited */
  maxMinutes?: number;
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
  /**
   * lines read_file returns when no range is given (default 100; 800 for models with a window
   * of 64k tokens or more – they get a whole source file in one step instead of three)
   */
  readWindow?: number;
  /**
   * read-ahead: a read_file answer also names where the types and functions the shown code
   * uses are defined in other project files – the agent's likely next lookup (default true)
   */
  readAhead?: boolean;
  /**
   * Tool output longer than this (characters) is saved in full to
   * .kurultay/tool-output/ and the model gets the start and the end, the file's path and a
   * sha256 of the whole output; it can read_file the rest (default 8000).
   */
  maxToolOutputChars?: number;
  /** characters of a spilled output shown to the model, split between start and end (default 4000) */
  toolOutputPreviewChars?: number;
  /** a re-read of an unchanged file range returns a short note instead of the content again (default true) */
  readCache?: boolean;
  /**
   * MCP tool declarations are sent with every request. When they would take more than this
   * many tokens, the model gets two small tools instead – mcp_describe(name) and
   * mcp_call(name, arguments) – plus a one-line list of the tools (default 1500).
   */
  mcpToolBudgetTokens?: number;
  /** force one edit format for every model (default: the format the probe measured best per model) */
  editFormat?: 'tool' | 'search_replace' | 'whole';
  allowCommands: boolean;
  /** an existing file must be read before it is edited/overwritten/deleted */
  requireReadBeforeEdit: boolean;
  commandTimeoutMs: number;
  /** regexes; commands matching any are refused */
  denyPatterns: string[];
  /**
   * where builds/tests/commands run: "sandbox" = per-worker copies under
   * .kurultay/sandboxes (parallel, project untouched), "inplace" = the real tree
   * with the overlay applied temporarily (serialised; reuses existing build dirs)
   */
  isolation: 'sandbox' | 'inplace';
  /**
   * compiler check after every edit: "auto" (C/C++ via compile_commands.json or the
   * local compiler, Java via javac), "off", or {".ext": "command {file}"}
   */
  syntaxCheck: 'auto' | 'off' | Record<string, string>;
  /** Java projects that must stay on an older Java: javac --release N in the post-edit check (e.g. 8) */
  javaRelease?: number;
  sandbox: { size: number; exclude: string[]; link: string[] };
  /** "deny" (default): denyPatterns only; "allow": every command segment must match the allow-list */
  commandPolicy?: 'deny' | 'allow';
  /** extra allow-list regexes for commandPolicy "allow" */
  allowPatterns?: string[];
  /** remove KEY/TOKEN/SECRET/PASSWORD… variables from model commands' environment (default true) */
  scrubEnv?: boolean;
  /** environment variable names to keep even though they look secret */
  envPassthrough?: string[];
  /** OS-level sandbox for model commands: "off" (default), "auto" (bubblewrap when usable), "bwrap" (required) */
  osSandbox?: 'off' | 'auto' | 'bwrap';
  /** allow network inside the OS sandbox (default false) */
  osSandboxNetwork?: boolean;
  /** extra writable paths inside the OS sandbox (e.g. ~/.m2, ~/.gradle caches) */
  osSandboxWritable?: string[];
}

export interface EmbeddingsConfig {
  /** "auto" (default): use an embedding model if an endpoint lists one; "off": BM25 only */
  mode?: 'auto' | 'off';
  /** endpoint name serving the embedding model (default: search all / the first) */
  endpoint?: string;
  /** embedding model id (default: the first id that looks like one: *embed*, bge-, e5-, gte-) */
  model?: string;
  timeoutMs?: number;
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

export interface JiraConfig {
  /** e.g. https://jira.company.local (Server / Data Center) or https://company.atlassian.net (Cloud) */
  url: string;
  /** user name (Server/DC with password) or e-mail address (Cloud with an API token) */
  username?: string;
  password?: string;
  /** personal access token (Server/DC, sent as Bearer) or Cloud API token (sent with the e-mail as username) */
  token?: string;
  /** the word that hands an issue to Kurultay (default "@kurultay"), looked for in the description */
  mention?: string;
  /** replaces the built-in query (assigned to you, mention in the description, not done) */
  jql?: string;
  /** minutes between two looks at Jira in watch mode (default 5) */
  intervalMinutes?: number;
  /**
   * optional: Jira project key → repository URL when issues of several projects live in
   * different repositories ("*" = any other project). Without it gitlab.repo is used. A line
   * "repo: <url>" in the description overrides both for one issue.
   */
  repos?: Record<string, string>;
  /** write the result (merge request, summary, tests) as a comment on the issue (default true) */
  comment?: boolean;
  /** move the issue to this status after the merge request was opened (e.g. "In Review"; default: leave it) */
  transition?: string;
}

export interface GitLabConfig {
  /** the repository the Jira work is done in, e.g. https://gitlab.company.local/team/app.git */
  repo?: string;
  /** GitLab base URL, e.g. https://gitlab.company.local (default: taken from the repository URL) */
  url?: string;
  /** user name and password for git over HTTPS */
  username?: string;
  password?: string;
  /** personal access token (scope api): opens the merge request through the API; without it git push options are used */
  token?: string;
  /** branch the merge request targets (default: the repository's default branch) */
  targetBranch?: string;
  /** where the repositories are cloned (default ~/.kurultay/jira-work) */
  workDir?: string;
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
  embeddings?: EmbeddingsConfig;
  /** MCP servers whose tools the workers may use: {"servers": {"name": {"command": "...", "args": []}}} */
  mcp?: McpConfig;
  /** LSP servers for diagnostics after edits: {"servers": {"clangd": {"command": "clangd", "extensions": [".c", ".cpp", ".h"]}}} */
  lsp?: LspConfig;
  /** Jira: issues assigned to you that mention @kurultay are done and sent as merge requests (`kurultay jira`) */
  jira?: JiraConfig;
  /** GitLab access for the Jira work: clone, push, merge request */
  gitlab?: GitLabConfig;
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
    summaryLanguage: 'en',
    repoMapTokens: 2048,
  },
  tools: {
    allowCommands: true,
    requireReadBeforeEdit: true,
    commandTimeoutMs: 10 * 60_000,
    isolation: 'sandbox',
    syntaxCheck: 'auto',
    sandbox: { size: 4, exclude: ['.git', '.kurultay', '.svn', '.hg', 'build', 'out', 'target', 'bin', 'obj', 'cmake-build-debug', 'cmake-build-release', '.gradle', '.idea', '.vs', '__pycache__', '.pytest_cache', 'dist', 'coverage'], link: ['node_modules'] },
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
    samplingPresets: true,
  },
  language: 'en',
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
    throw new ConfigError('The configuration needs at least one endpoint ("baseUrl" or "endpoints").');
  }
  const names = new Set<string>();
  for (const ep of cfg.endpoints) {
    if (!ep.name || !/^[A-Za-z0-9_.-]+$/.test(ep.name)) throw new ConfigError(`Invalid endpoint name: "${ep.name}"`);
    if (names.has(ep.name)) throw new ConfigError(`Duplicate endpoint name: ${ep.name}`);
    names.add(ep.name);
    try {
      const u = new URL(ep.baseUrl);
      if (!/^https?:$/.test(u.protocol)) throw new Error();
    } catch {
      throw new ConfigError(`Invalid baseUrl for endpoint "${ep.name}": ${ep.baseUrl}`);
    }
  }
  const modes: RunMode[] = ['auto', 'single', 'split', 'race', 'council'];
  if (!modes.includes(cfg.orchestrator.defaultMode)) throw new ConfigError(`Invalid defaultMode: ${cfg.orchestrator.defaultMode}`);
  for (const k of ['timeoutMs', 'firstTokenTimeoutMs', 'prefillMsPerToken', 'idleTimeoutMs', 'timeoutRetries', 'timeoutCooldownMs'] as const) {
    const v = cfg.llm[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new ConfigError(`llm.${k} must be zero or a positive number (value: ${JSON.stringify(v)})`);
  }
  if (cfg.llm.timeoutMs < 1000) throw new ConfigError('llm.timeoutMs must be at least 1000 ms');
  for (const [key, m] of Object.entries(cfg.models ?? {})) {
    for (const r of m.roles ?? []) if (!ALL_ROLES.includes(r)) throw new ConfigError(`Unknown role "${r}" for model ${key} (valid: ${ALL_ROLES.join(', ')})`);
    if (m.rolesOnly && !m.roles?.length) throw new ConfigError(`Model ${key} has rolesOnly but no roles`);
  }
  for (const ep of cfg.endpoints) {
    for (const r of ep.roles ?? []) if (!ALL_ROLES.includes(r)) throw new ConfigError(`Unknown role "${r}" for endpoint ${ep.name} (valid: ${ALL_ROLES.join(', ')})`);
    if (ep.rolesOnly && !ep.roles?.length) throw new ConfigError(`Endpoint ${ep.name} has rolesOnly but no roles`);
  }
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
      'No configuration found. Run "kurultay" for the setup, "kurultay init" in the project root, or create kurultay.config.json.',
    );
  }
  let raw = normalizeRawConfig(readJson(path));
  // a project config without endpoints (build/test commands, rules) extends the user's config
  const home = join(kurultayHome(), 'config.json');
  const eps = (raw as { endpoints?: unknown[] } | null)?.endpoints;
  if (resolve(path) !== resolve(home) && (!Array.isArray(eps) || !eps.length) && existsSync(home)) {
    const base = normalizeRawConfig(readJson(home)) as Record<string, unknown>;
    raw = deepMerge(base, raw as Record<string, unknown>);
    (raw as { endpoints?: unknown[] }).endpoints = base.endpoints as unknown[];
  }
  // An explicit or user-level config with the models still gets the project's own settings
  // (build/test commands, rules): without them nothing is verified and no race runs.
  const project = CONFIG_FILE_NAMES.map((n) => join(projectRoot, n)).find((p) => existsSync(p));
  if (project && resolve(project) !== resolve(path)) {
    const own = normalizeRawConfig(readJson(project)) as Record<string, unknown> | null;
    const ownEps = (own as { endpoints?: unknown[] } | null)?.endpoints;
    if (own && (!Array.isArray(ownEps) || !ownEps.length)) {
      const eps = (raw as { endpoints?: unknown[] }).endpoints;
      raw = deepMerge(raw as Record<string, unknown>, own);
      (raw as { endpoints?: unknown[] }).endpoints = eps;
    }
  }
  const config = parseConfig(raw);
  return { config, path };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError(`could not read ${path}: ${(e as Error).message}`);
  }
}

/**
 * Accepts the short form – one server, one key, a list of model names:
 *
 *   { "baseUrl": "http://10.0.0.5:8000/v1", "apiKey": "${KEY}",
 *     "models": ["qwen3-coder-30b", "gpt-oss-120b", { "id": "other", "apiKey": "${OTHER_KEY}" }] }
 *
 * and model entries inside `endpoints[].models` given as objects ({ id, apiKey, contextWindow… }).
 * Everything is normalised to `endpoints[]` with string model lists plus per-model
 * settings in the `models` map (keyed "model@endpoint"). Models without their own
 * apiKey use the endpoint's key.
 */
export function normalizeRawConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const r: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const overrides: Record<string, Record<string, unknown>> = r.models && typeof r.models === 'object' && !Array.isArray(r.models) ? { ...(r.models as Record<string, Record<string, unknown>>) } : {};
  const list = Array.isArray(r.models) ? (r.models as unknown[]) : undefined;
  let endpoints = Array.isArray(r.endpoints) ? (r.endpoints as Array<Record<string, unknown>>).map((e) => ({ ...e })) : [];
  if (typeof r.baseUrl === 'string' && r.baseUrl.trim()) {
    const main: Record<string, unknown> = { name: typeof r.endpointName === 'string' && r.endpointName ? r.endpointName : 'main', baseUrl: r.baseUrl, models: list ?? [] };
    for (const k of ['apiKey', 'maxConcurrency', 'timeoutMs', 'firstTokenTimeoutMs', 'idleTimeoutMs', 'headers'] as const) if (r[k] !== undefined) main[k] = r[k];
    endpoints = [main, ...endpoints];
    for (const k of ['baseUrl', 'apiKey', 'endpointName', 'maxConcurrency', 'timeoutMs', 'firstTokenTimeoutMs', 'idleTimeoutMs', 'headers']) delete r[k];
  } else if (list) {
    if (endpoints.length !== 1) throw new ConfigError('A "models" list needs a top-level "baseUrl" (or exactly one entry in "endpoints").');
    endpoints[0].models = list;
  }
  // helper: a small extra model (e.g. on this PC) for the light work only – summaries, compaction
  if (r.helper !== undefined) {
    const h = r.helper as Record<string, unknown>;
    if (!h || typeof h !== 'object' || typeof h.baseUrl !== 'string' || !h.baseUrl.trim()) throw new ConfigError('"helper" needs a "baseUrl" (and usually "models")');
    const name = typeof h.name === 'string' && h.name ? h.name : 'helper';
    const roles = Array.isArray(h.roles) && h.roles.length ? (h.roles as unknown[]).map(String) : ['fast', 'summarizer'];
    const ep: Record<string, unknown> = { name, baseUrl: h.baseUrl, apiKey: h.apiKey ?? 'none', models: Array.isArray(h.models) ? h.models : [] };
    for (const k of ['maxConcurrency', 'timeoutMs', 'firstTokenTimeoutMs', 'idleTimeoutMs', 'headers'] as const) if (h[k] !== undefined) ep[k] = h[k];
    ep.roles = roles;
    ep.rolesOnly = true;
    endpoints.push(ep);
    delete r.helper;
  }
  for (const ep of endpoints) {
    if (!Array.isArray(ep.models)) continue;
    ep.models = (ep.models as unknown[])
      .map((m) => {
        if (typeof m === 'string') return m.trim();
        if (m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string') {
          const { id, ...rest } = m as Record<string, unknown> & { id: string };
          const key = `${id.trim()}@${String(ep.name)}`;
          if (Object.keys(rest).length) overrides[key] = { ...(overrides[key] ?? {}), ...rest };
          return id.trim();
        }
        throw new ConfigError(`Invalid model entry in endpoint "${String(ep.name)}": ${JSON.stringify(m)} (use a name or {"id": "...", "apiKey": "..."})`);
      })
      .filter(Boolean);
  }
  r.endpoints = endpoints;
  r.models = overrides;
  return r;
}

export function parseConfig(raw: unknown): KurultayConfig {
  const merged = deepMerge({ ...DEFAULT_CONFIG, endpoints: [] } as KurultayConfig, normalizeRawConfig(interpolateEnv(raw)));
  merged.endpoints = (merged.endpoints || []).map((e) => ({ ...e, baseUrl: e.baseUrl.replace(/\/+$/, '') }));
  validateConfig(merged);
  return merged;
}

export function modelKey(model: string, endpoint: string): string {
  return `${model}@${endpoint}`;
}

export const SAMPLE_CONFIG = {
  $comment:
    'Kurultay configuration. One OpenAI-compatible endpoint (vLLM, llama.cpp server, Ollama, LM Studio, TGI, LiteLLM...) with one API key; list the model names below. A model that needs its own key: {"id": "name", "apiKey": "..."}. An empty list uses every model the endpoint reports. ${ENV_VAR} works in any value. More servers: add an "endpoints" array.',
  baseUrl: 'http://127.0.0.1:8000/v1',
  apiKey: '${KURULTAY_API_KEY:-none}',
  models: ['qwen3-coder-30b', 'gpt-oss-20b'],
  verify: { build: '', test: '', lint: '' },
  orchestrator: { defaultMode: 'auto', raceWidth: 3, councilSize: 3, maxIterations: 4, maxStepsPerWorker: 40, confirmMerge: false },
  index: { include: [], exclude: [], summaryLanguage: 'en', repoMapTokens: 2048 },
  language: 'en',
};
