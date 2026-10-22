import { join, resolve } from 'node:path';
import { kurultayHome, loadConfig, type KurultayConfig } from './config.js';
import { Materializer } from './agent/workspace.js';
import { ProjectIndex } from './index/project-index.js';
import { readCapabilitiesFile } from './llm/models.js';
import { Router } from './llm/router.js';
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

export async function createApp(opts: { root?: string; config?: string; bus?: EventBus; requireModels?: boolean; discoverTimeoutMs?: number } = {}): Promise<App> {
  const root = resolve(opts.root ?? process.cwd());
  const { config, path } = loadConfig(root, opts.config);
  const stateDir = join(root, config.stateDir);
  const bus = opts.bus ?? new EventBus();
  const router = new Router(config, bus);
  const caps = readCapabilitiesFile(join(stateDir, 'capabilities.json'));
  let probed = false;
  if (caps?.models.length) {
    router.register(caps.models.filter((m) => m.reachable));
    probed = true;
  } else {
    // capability profiles are about the models, not the project: reuse the per-user cache
    const shared = readCapabilitiesFile(join(kurultayHome(), 'capabilities.json'));
    const endpoints = new Set(config.endpoints.filter((e) => !e.disabled).map((e) => e.name));
    const usable = (shared?.models ?? []).filter((m) => m.reachable && endpoints.has(m.endpoint));
    if (usable.length) {
      router.register(usable);
      probed = true;
    }
  }
  if (router.size === 0 && opts.requireModels !== false) {
    router.register(await router.discover(opts.discoverTimeoutMs ? AbortSignal.timeout(opts.discoverTimeoutMs) : undefined));
  }
  return { root, stateDir, config, configPath: path, bus, router, materializer: new Materializer(root, stateDir), probed };
}

export function loadOrBuildIndex(app: App, rebuild = false): { index: ProjectIndex; stats: ReturnType<ProjectIndex['build']> | undefined } {
  const index = (!rebuild && ProjectIndex.load(app.root, app.stateDir)) || new ProjectIndex(app.root, app.stateDir);
  // build() is incremental: unchanged files keep their symbols and summaries
  const stats = index.build({ include: app.config.index.include, exclude: app.config.index.exclude, maxFileBytes: app.config.index.maxFileBytes });
  index.save();
  return { index, stats };
}
