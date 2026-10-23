import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kurultayHome, type KurultayConfig } from '../config.js';
import { readCapabilitiesFile, type CapabilitiesFile } from '../llm/models.js';
import type { EventBus } from '../util/events.js';
import { mergeCapabilities, probeAll, unprofiledModels, type ProbeOptions } from './probe.js';

/**
 * The capability profile is measured once and kept per user
 * (~/.kurultay/capabilities.json): it describes the models, not a project.
 * It is only measured again on request (`kurultay probe`, `/probe`); models that
 * appear in the configuration later are probed on their own.
 */
export function profilePath(): string {
  return join(kurultayHome(), 'capabilities.json');
}

export function loadProfile(): CapabilitiesFile | undefined {
  return readCapabilitiesFile(profilePath());
}

/** Merge measured models into the saved profile and write it. */
export function saveProfile(file: CapabilitiesFile): CapabilitiesFile {
  const merged = mergeCapabilities(loadProfile(), file);
  mkdirSync(kurultayHome(), { recursive: true });
  writeFileSync(profilePath(), JSON.stringify(merged, null, 2));
  return merged;
}

export interface ProbeRun {
  /** models that were measured now */
  measured: CapabilitiesFile;
  /** the whole saved profile after merging */
  profile: CapabilitiesFile;
}

/**
 * Measure models and save the result.
 *  - scope "missing": only configured models without a profile (first start, new models)
 *  - scope "all": every configured model again
 *  - models: just these (names or "model@endpoint")
 */
export async function runProbe(cfg: KurultayConfig, bus: EventBus | undefined, opts: ProbeOptions & { scope?: 'missing' | 'all'; models?: string[] } = {}): Promise<ProbeRun | undefined> {
  let only: ProbeOptions['only'];
  if (opts.models?.length) {
    const want = new Set(opts.models);
    only = (key) => want.has(key) || want.has(key.slice(0, key.lastIndexOf('@')));
  } else if ((opts.scope ?? 'missing') === 'missing') {
    const missing = new Set(await unprofiledModels(cfg, loadProfile(), opts.signal));
    if (!missing.size) return undefined;
    only = (key) => missing.has(key);
  }
  const measured = await probeAll(cfg, bus, { ...opts, only });
  return { measured, profile: saveProfile(measured) };
}
