import { join, resolve } from 'node:path';
import { kurultayHome, loadConfig, type KurultayConfig } from './config.js';
import { Materializer } from './agent/workspace.js';
import { ProjectIndex } from './index/project-index.js';
import { resolveEmbedder } from './index/embeddings.js';
import { McpManager } from './mcp/manager.js';
import { errorMessage } from './util/async.js';
import { defaultCapabilities, readCapabilitiesFile } from './llm/models.js';
import { loadProfile } from './probe/profile.js';
import { Router } from './llm/router.js';
import { ModelStats } from './llm/stats.js';
import { EventBus } from './util/events.js';

export interface App {
  root: string;
  stateDir: string;
  config: KurultayConfig;
  configPath: string;
  bus: EventBus;
  router: Router;
  materializer: Materializer;
  /** whether router models come from a probe (true) or plain discovery (false) */
  probed: boolean;
}

export async function createApp(opts: { root?: string; config?: string; bus?: EventBus; requireModels?: boolean; discoverTimeoutMs?: number; learn?: boolean } = {}): Promise<App> {
  const root = resolve(opts.root ?? process.cwd());
  const { config, path } = loadConfig(root, opts.config);
  const stateDir = join(root, config.stateDir);
  const bus = opts.bus ?? new EventBus();
  const router = new Router(config, bus);
  // learned per-role quality, shared by every project of this user
  if (opts.learn !== false) router.learned = new ModelStats(join(kurultayHome(), 'model-stats.json'));
  // the capability profile is per user (measured once, see probe/profile.ts); a project-local
  // file from older versions is only used when there is no user profile yet
  const caps = loadProfile() ?? readCapabilitiesFile(join(stateDir, 'capabilities.json'));
  let probed = false;
  const endpoints = config.endpoints.filter((e) => !e.disabled);
  const usable = (caps?.models ?? []).filter((m) => m.reachable && endpoints.some((e) => e.name === m.endpoint));
  if (usable.length) {
    router.register(usable);
    probed = true;
    // models added to the config after the probe still work, with default capabilities until probed
    const known = new Set((caps?.models ?? []).map((m) => m.key));
    const fresh = endpoints.flatMap((e) => (e.models ?? []).filter((id) => !known.has(`${id}@${e.name}`)).map((id) => defaultCapabilities(id, e.name)));
    if (fresh.length) router.register(fresh);
  }
  if (router.size === 0 && opts.requireModels !== false) {
    router.register(await router.discover(opts.discoverTimeoutMs ? AbortSignal.timeout(opts.discoverTimeoutMs) : undefined));
  }
  return { root, stateDir, config, configPath: path, bus, router, materializer: new Materializer(root, stateDir, { isolation: config.tools.isolation, sandbox: config.tools.sandbox }), probed };
}

/**
 * Semantic retrieval: find the embedding model and embed new/changed chunks
 * (incremental). Without an embedding model search stays BM25-only.
 */
export async function prepareRetrieval(app: App, index: ProjectIndex, opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<{ model?: string; embedded: number; vectors: number; error?: string }> {
  index.embedder ??= await resolveEmbedder(app.config, app.bus, opts.signal);
  if (!index.embedder) return { embedded: 0, vectors: 0 };
  try {
    const r = await index.buildVectors({ signal: opts.signal, onProgress: opts.onProgress });
    return { model: index.embedder.key, embedded: r.embedded, vectors: index.vectorCount };
  } catch (e) {
    const error = errorMessage(e);
    app.bus.warn('embeddings', `could not build vectors (${error}); search continues with BM25`);
    return { model: index.embedder.key, embedded: 0, vectors: index.vectorCount, error };
  }
}

/** Start the configured MCP servers (none configured → undefined). Call close() when done. */
export async function startMcp(app: App): Promise<McpManager | undefined> {
  if (!Object.keys(app.config.mcp?.servers ?? {}).length) return undefined;
  const m = new McpManager(app.config.mcp, app.bus);
  await m.start();
  return m;
}

export function loadOrBuildIndex(app: App, rebuild = false): { index: ProjectIndex; stats: ReturnType<ProjectIndex['build']> | undefined } {
  const index = (!rebuild && ProjectIndex.load(app.root, app.stateDir)) || new ProjectIndex(app.root, app.stateDir);
  // build() is incremental: unchanged files keep their symbols and summaries
  const stats = index.build({ include: app.config.index.include, exclude: app.config.index.exclude, maxFileBytes: app.config.index.maxFileBytes });
  index.save();
  return { index, stats };
}
