import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseConfig, type KurultayConfig } from '../src/config.js';
import { defaultCapabilities, type ModelCapabilities } from '../src/llm/models.js';
import { Router } from '../src/llm/router.js';
import { EventBus } from '../src/util/events.js';

/** Create a throw-away project directory with the given files. */
export function tmpProject(files: Record<string, string>, opts: { git?: boolean; prefix?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), opts.prefix ?? 'k-test-'));
  for (const [p, content] of Object.entries(files)) {
    const abs = join(root, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  if (opts.git) {
    try {
      execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    } catch {
      /* git is optional */
    }
  }
  return root;
}

export function config(raw: Record<string, unknown>): KurultayConfig {
  return parseConfig(raw);
}

/** Capabilities with sensible test defaults; override anything. */
export function caps(model: string, endpoint: string, over: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return { ...defaultCapabilities(model, endpoint), notes: [], probedAt: 'test', ...over };
}

/** Router over mock endpoints with explicit capabilities (no probe). */
export function routerFor(cfg: KurultayConfig, list: ModelCapabilities[], bus?: EventBus): Router {
  const r = new Router(cfg, bus);
  r.register(list);
  return r;
}

/** Event bus that records events of interest. */
export function recordingBus(): EventBus & { types: () => string[]; ofType: (t: string) => Array<{ message?: string; data?: Record<string, unknown>; source?: string }> } {
  const bus = new EventBus() as EventBus & { types: () => string[]; ofType: (t: string) => Array<{ message?: string; data?: Record<string, unknown>; source?: string }> };
  bus.types = () => bus.history.map((e) => e.type);
  bus.ofType = (t: string) => bus.history.filter((e) => e.type === t);
  return bus;
}

export const CLAMP_PROJECT = {
  'src/mathutil.js': '// math utilities\nexport function clamp(value, min, max) {\n  throw new Error("TODO");\n}\n',
  'test.js': "import { clamp } from './src/mathutil.js';\nimport assert from 'node:assert';\nassert.strictEqual(clamp(5,0,10),5);\nassert.strictEqual(clamp(-3,0,10),0);\nassert.strictEqual(clamp(42,0,10),10);\n",
  'package.json': '{"type":"module"}',
};

export function lastUser(messages: Array<{ role: string; content: string | null }>): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].content ?? '';
  return '';
}

export function isAgent(messages: Array<{ role: string; content: string | null }>): boolean {
  return /senior software engineer working autonomously/.test(messages[0]?.content ?? '');
}

/** Count tool results so a scripted agent knows which step it is on. */
export function toolResults(messages: Array<{ role: string; content: string | null }>): number {
  return messages.filter((m) => m.role === 'tool' || (m.role === 'user' && (m.content ?? '').startsWith('<tool_result'))).length;
}
