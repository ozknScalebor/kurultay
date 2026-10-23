import { existsSync, readFileSync } from 'node:fs';
import type { Role } from '../config.js';

/** What we know about a single model on a single endpoint (filled by the probe). */
export interface ModelCapabilities {
  key: string; // model@endpoint
  model: string;
  endpoint: string;
  reachable: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  nativeTools: boolean;
  jsonMode: boolean;
  /** response_format json_schema (constrained decoding) works; undefined = not known yet */
  jsonSchema?: boolean;
  streaming: boolean;
  /** emits <think> / reasoning_content */
  thinking: boolean;
  ttftMs: number;
  tokensPerSec: number;
  /** best sustained parallel requests for the endpoint */
  maxConcurrency: number;
  /** aggregate tok/s at maxConcurrency */
  aggregateTokensPerSec: number;
  /** 0..1 – fraction of mini benchmark tasks passed */
  codingScore: number;
  /** 0..1 – SEARCH/REPLACE edit accuracy */
  editScore: number;
  /** 0..1 – instruction / JSON following */
  instructionScore: number;
  /** 0..1 per role, derived from the above */
  roleScores: Record<Role, number>;
  probedAt: string;
  /** how long the probe of this model took */
  probeSeconds?: number;
  notes: string[];
}

export interface CapabilitiesFile {
  version: 1;
  generatedAt: string;
  models: ModelCapabilities[];
}

export function defaultCapabilities(model: string, endpoint: string): ModelCapabilities {
  return {
    key: `${model}@${endpoint}`,
    model,
    endpoint,
    reachable: true,
    contextWindow: 32_768,
    maxOutputTokens: 4096,
    nativeTools: true,
    jsonMode: false,
    streaming: true,
    thinking: false,
    ttftMs: 0,
    tokensPerSec: 0,
    maxConcurrency: 2,
    aggregateTokensPerSec: 0,
    codingScore: 0.5,
    editScore: 0.5,
    instructionScore: 0.5,
    roleScores: { planner: 0.5, coder: 0.5, summarizer: 0.5, reviewer: 0.5, judge: 0.5, fast: 0.5 },
    probedAt: '',
    notes: ['not probed – default values'],
  };
}

/** Turn raw measurements into per-role suitability scores (0..1). */
export function computeRoleScores(c: Pick<ModelCapabilities, 'contextWindow' | 'nativeTools' | 'tokensPerSec' | 'codingScore' | 'editScore' | 'instructionScore' | 'thinking'>, fleetMaxTps: number): Record<Role, number> {
  const ctx = Math.min(1, Math.log2(Math.max(4096, c.contextWindow) / 4096) / Math.log2(262_144 / 4096)); // 4k→0, 256k→1
  const speed = fleetMaxTps > 0 ? Math.min(1, c.tokensPerSec / fleetMaxTps) : 0.5;
  const tools = c.nativeTools ? 1 : 0.6; // prompt-based fallback still works
  const think = c.thinking ? 1 : 0.7;
  const clamp = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 1000) / 1000;
  return {
    planner: clamp(0.45 * c.codingScore + 0.25 * c.instructionScore + 0.15 * ctx + 0.15 * think),
    coder: clamp(0.45 * c.codingScore + 0.3 * c.editScore + 0.15 * tools + 0.1 * speed),
    summarizer: clamp(0.35 * c.instructionScore + 0.35 * speed + 0.3 * ctx),
    reviewer: clamp(0.5 * c.codingScore + 0.3 * c.instructionScore + 0.2 * ctx),
    judge: clamp(0.45 * c.codingScore + 0.4 * c.instructionScore + 0.15 * think),
    fast: clamp(0.7 * speed + 0.3 * c.instructionScore),
  };
}

export function readCapabilitiesFile(path: string): CapabilitiesFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const f = JSON.parse(readFileSync(path, 'utf8')) as CapabilitiesFile;
    if (f.version === 1 && Array.isArray(f.models)) return f;
  } catch {
    /* ignore corrupt file – probe will rewrite it */
  }
  return undefined;
}
