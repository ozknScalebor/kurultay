import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp, loadOrBuildIndex } from '../app.js';
import type { RunMode } from '../config.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import { TEST_PATH } from '../orchestrator/cross-test.js';
import { errorMessage } from '../util/async.js';
import { EventBus, type KEvent } from '../util/events.js';

/**
 * SWE-bench adapter. Generating patches and grading them are separate steps, so the
 * agents can run on the offline machine and the grading (Docker, ~120 GB of images)
 * anywhere else:
 *
 *   prepare  dataset JSONL → one git checkout per instance at its base commit + the prompt
 *   run      Kurultay solves every prepared instance → predictions JSONL (resumable)
 *   collect  folders another agent (Qwen Code, Aider…) worked on → predictions JSONL
 *
 * Grade with the official harness: `swebench eval verified -p <predictions> --run-id <id>`.
 * Every agent gets the same prompt file, the same checkout and the same patch rules.
 */

export interface SweInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
}

export interface Prediction {
  instance_id: string;
  model_name_or_path: string;
  model_patch: string;
}

const STATE_DIRS = ['.kurultay', '.qwen', '.claude', '.codex'];
/** Files that are never part of a prediction: agent state folders. */
const STATE = /^(\.kurultay|\.qwen|\.aider[^/]*|\.claude|\.codex)(\/|$)/;

export function loadInstances(file: string): SweInstance[] {
  const text = readFileSync(file, 'utf8');
  const rows: unknown[] = file.endsWith('.json') ? (JSON.parse(text) as unknown[]) : text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as unknown);
  const out = rows.map((r) => r as Partial<SweInstance>).filter((r): r is SweInstance => !!r.instance_id && !!r.repo && !!r.base_commit && typeof r.problem_statement === 'string');
  if (!out.length) throw new Error(`no SWE-bench instances (instance_id, repo, base_commit, problem_statement) in ${file}`);
  return out;
}

/** Deterministic sample: the same seed always gives the same instances (mulberry32). */
export function sampleInstances<T extends { instance_id: string }>(all: T[], n: number, seed: number): T[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const sorted = [...all].sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  for (let i = sorted.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
  }
  return sorted.slice(0, n).sort((a, b) => a.instance_id.localeCompare(b.instance_id));
}

/** The prompt every agent gets (also written to prompts/<id>.txt for other tools). */
export function sweprompt(i: SweInstance): string {
  return `Resolve the following issue in this repository (${i.repo}). Make the smallest correct change to the source code so that the issue is fixed.
Do not modify or delete existing tests; the change will be checked with the project's own test suite.

<issue>
${i.problem_statement.trim()}
</issue>`;
}

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });

export interface PrepareOptions {
  dataset: string;
  dir: string;
  instances?: string[];
  sample?: number;
  seed?: number;
  /** where the repositories are cloned once (default <dir>/.repos); may already hold mirrors */
  repos?: string;
  /** base URL of the repositories (default https://github.com) – a local mirror server works too */
  gitBase?: string;
  onProgress?: (l: string) => void;
}

/** One checkout per instance at its base commit, plus tasks.jsonl and prompts/<id>.txt. */
export function prepare(o: PrepareOptions): SweInstance[] {
  let list = loadInstances(o.dataset);
  if (o.instances?.length) {
    const want = new Set(o.instances);
    list = list.filter((i) => want.has(i.instance_id));
    const missing = o.instances.filter((id) => !list.some((i) => i.instance_id === id));
    if (missing.length) throw new Error(`not in the dataset: ${missing.join(', ')}`);
  } else if (o.sample) list = sampleInstances(list, o.sample, o.seed ?? 42);
  const dir = resolve(o.dir);
  const repos = resolve(o.repos ?? join(dir, '.repos'));
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  mkdirSync(repos, { recursive: true });
  for (const i of list) {
    const mirror = join(repos, `${i.repo.replace('/', '__')}.git`);
    if (!existsSync(mirror)) {
      o.onProgress?.(`cloning ${i.repo} (once)`);
      git(repos, ['clone', '--quiet', '--mirror', `${(o.gitBase ?? 'https://github.com').replace(/\/$/, '')}/${i.repo}.git`, mirror]);
    }
    const work = join(dir, i.instance_id);
    if (!existsSync(join(work, '.git'))) {
      git(dir, ['clone', '--quiet', '--no-checkout', mirror, i.instance_id]);
      git(work, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', i.base_commit]);
    }
    writeFileSync(join(dir, 'prompts', `${i.instance_id}.txt`), sweprompt(i));
    o.onProgress?.(`✓ ${i.instance_id}`);
  }
  writeFileSync(join(dir, 'tasks.jsonl'), list.map((i) => JSON.stringify(i)).join('\n') + '\n');
  return list;
}

/**
 * The change an agent made in one checkout, as a patch against the base commit: tracked
 * edits and new files, without agent state folders and (by default) without test files –
 * the harness applies its own test patch afterwards, and an edited test file would make
 * that patch fail to apply.
 */
export function patchOf(work: string, base: string, opts: { keepTests?: boolean } = {}): { patch: string; files: string[]; droppedTests: string[] } {
  git(work, ['add', '-A', '--', '.', ...STATE_DIRS.map((d) => `:(exclude)${d}`)]);
  const changed = git(work, ['diff', '--cached', '--name-only', base]).split('\n').filter(Boolean);
  const files = changed.filter((f) => !STATE.test(f));
  const droppedTests = opts.keepTests ? [] : files.filter((f) => TEST_PATH.test(f));
  const keep = files.filter((f) => !droppedTests.includes(f));
  const patch = keep.length ? git(work, ['diff', '--cached', '--binary', base, '--', ...keep]) : '';
  git(work, ['reset', '--quiet']);
  return { patch, files: keep, droppedTests };
}

export function readPredictions(file: string): Prediction[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Prediction);
}

function tasksOf(dir: string, only?: string[]): SweInstance[] {
  const f = join(dir, 'tasks.jsonl');
  if (!existsSync(f)) throw new Error(`${f} not found – run "kurultay swebench prepare" first`);
  const all = loadInstances(f);
  return only?.length ? all.filter((i) => only.includes(i.instance_id)) : all;
}

/** Predictions from folders another agent worked on. */
export function collect(o: { dir: string; name: string; out?: string; instances?: string[]; keepTests?: boolean; onProgress?: (l: string) => void }): { out: string; predictions: Prediction[] } {
  const dir = resolve(o.dir);
  const out = resolve(o.out ?? join(dir, `predictions-${o.name}.jsonl`));
  const preds: Prediction[] = [];
  for (const i of tasksOf(dir, o.instances)) {
    const work = join(dir, i.instance_id);
    if (!existsSync(work)) continue;
    const p = patchOf(work, i.base_commit, { keepTests: o.keepTests });
    preds.push({ instance_id: i.instance_id, model_name_or_path: o.name, model_patch: p.patch });
    o.onProgress?.(`${p.patch ? '✓' : '·'} ${i.instance_id}: ${p.files.length} files${p.droppedTests.length ? ` (test files left out: ${p.droppedTests.join(', ')})` : ''}`);
  }
  writeFileSync(out, preds.map((p) => JSON.stringify(p)).join('\n') + (preds.length ? '\n' : ''));
  return { out, predictions: preds };
}

export interface RunOptions {
  dir: string;
  mode?: RunMode;
  config?: string;
  instances?: string[];
  /** label in model_name_or_path (default kurultay-<version>) */
  name: string;
  timeoutMin?: number;
  keepTests?: boolean;
  onProgress?: (l: string) => void;
  signal?: AbortSignal;
}

/**
 * Kurultay on every prepared instance. Resumable: instances already in the predictions file
 * are skipped. Time, requests and tokens per instance go to runs-<name>.jsonl.
 */
export async function runAll(o: RunOptions): Promise<{ out: string; done: number; skipped: number }> {
  const dir = resolve(o.dir);
  const out = join(dir, `predictions-${o.name}.jsonl`);
  const stats = join(dir, `runs-${o.name}.jsonl`);
  const have = new Set(readPredictions(out).map((p) => p.instance_id));
  let done = 0;
  let skipped = 0;
  for (const i of tasksOf(dir, o.instances)) {
    if (o.signal?.aborted) break;
    if (have.has(i.instance_id)) {
      skipped++;
      continue;
    }
    const work = join(dir, i.instance_id);
    const bus = new EventBus();
    const s = { requests: 0, tokensIn: 0, tokensOut: 0, errors: 0 };
    bus.on('event', (e: KEvent) => {
      if (e.type === 'llm.response') {
        s.requests++;
        s.tokensIn += Number(e.data?.in ?? 0);
        s.tokensOut += Number(e.data?.out ?? 0);
      } else if (e.type === 'llm.error') s.errors++;
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timed out')), (o.timeoutMin ?? 30) * 60_000);
    const onAbort = () => ctrl.abort(o.signal?.reason);
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const t0 = Date.now();
    let status = 'error';
    let error: string | undefined;
    try {
      const app = await createApp({ root: work, config: o.config, bus, requireModels: true, discoverTimeoutMs: 10_000 });
      app.config.orchestrator.confirmMerge = false;
      const { index } = loadOrBuildIndex(app);
      const report = await new Orchestrator(work, app.config, app.router, app.materializer, index, bus).run(sweprompt(i), { mode: o.mode, signal: ctrl.signal });
      status = report.status;
    } catch (e) {
      error = errorMessage(e).slice(0, 300);
      status = ctrl.signal.aborted ? 'timeout' : 'error';
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
    }
    if (o.signal?.aborted) break; // interrupted by the user: run it again next time
    const p = patchOf(work, i.base_commit, { keepTests: o.keepTests });
    appendFileSync(out, JSON.stringify({ instance_id: i.instance_id, model_name_or_path: o.name, model_patch: p.patch } satisfies Prediction) + '\n');
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    appendFileSync(stats, JSON.stringify({ instance_id: i.instance_id, status, seconds, ...s, files: p.files.length, droppedTests: p.droppedTests, error }) + '\n');
    done++;
    o.onProgress?.(`${p.patch ? '✓' : '·'} ${i.instance_id} · ${status} · ${seconds} s · ${s.requests} requests · ${p.files.length} files${error ? ` · ${error}` : ''}`);
  }
  return { out, done, skipped };
}
