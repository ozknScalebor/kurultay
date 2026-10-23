import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { runShell } from '../agent/tools.js';
import { createApp, loadOrBuildIndex } from '../app.js';
import type { RunMode } from '../config.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import { errorMessage } from '../util/async.js';
import { EventBus, type KEvent } from '../util/events.js';

/**
 * Evaluation harness: run Kurultay on a fixed set of tasks against a base
 * project and score the result with HIDDEN tests the agents never see
 * (SWE-bench style). Answers "does it work, and is race/council worth the
 * extra cost?" with numbers instead of opinions.
 *
 * Suite layout (directory):
 *   suite.json            { name, project, setup?, check?, tasks: [...] }
 *   <project>/            the starting code (copied fresh for every attempt)
 *   hidden/<task-id>/     files copied in only AFTER the agent finished (tests)
 *   solutions/<task-id>/  optional reference solution (used by --validate)
 */
export interface EvalTask {
  id: string;
  title?: string;
  /** what the agent is asked to do */
  prompt: string;
  /** command that decides pass/fail after hidden files are added (overrides suite.check) */
  check?: string;
  /** directory with hidden files (default hidden/<id>) */
  hidden?: string;
  timeoutSec?: number;
  tags?: string[];
}

export interface EvalSuite {
  name: string;
  /** base project directory, relative to the suite */
  project: string;
  /** run once in every fresh copy before the agent starts (e.g. configure a build dir) */
  setup?: string;
  /** default check command */
  check?: string;
  tasks: EvalTask[];
}

export interface EvalAttempt {
  task: string;
  mode: RunMode;
  repeat: number;
  /** hidden tests passed after the agent's change */
  passed: boolean;
  /** hidden tests failed on the untouched project (a valid task) */
  baselineFailed: boolean;
  status: string;
  seconds: number;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  llmErrors: number;
  models: string[];
  changedFiles: number;
  iterations: number;
  checkOutput: string;
  error?: string;
  workDir: string;
}

export interface EvalSummary {
  suite: string;
  startedAt: string;
  finishedAt: string;
  attempts: EvalAttempt[];
  byMode: Record<string, { attempts: number; passed: number; passRate: number; avgSeconds: number; avgTokens: number; avgRequests: number }>;
}

export function loadSuite(dir: string): EvalSuite {
  const file = join(dir, 'suite.json');
  if (!existsSync(file)) throw new Error(`suite.json not found: ${file}`);
  const s = JSON.parse(readFileSync(file, 'utf8')) as EvalSuite;
  if (!s.name || !s.project || !Array.isArray(s.tasks) || !s.tasks.length) throw new Error('suite.json: needs name, project and at least one task');
  if (!existsSync(join(dir, s.project))) throw new Error(`project folder missing: ${join(dir, s.project)}`);
  const ids = new Set<string>();
  for (const t of s.tasks) {
    if (!t.id || !t.prompt) throw new Error('every task needs an id and a prompt');
    if (ids.has(t.id)) throw new Error(`duplicate task id: ${t.id}`);
    ids.add(t.id);
    if (!(t.check ?? s.check)) throw new Error(`${t.id}: no check command (task.check or suite.check)`);
  }
  return s;
}

function copyProject(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  // build outputs are not copied: a CMakeCache.txt with absolute paths breaks the copy, stale classes hide errors.
  // Top-level entries are copied one by one (path-form independent: Windows 8.3 / long names).
  const skipTop = /^(\.build|build|out|target|cmake-build-.*)$/;
  for (const name of readdirSync(src)) {
    if (skipTop.test(name) || name === '.kurultay' || name === 'node_modules') continue;
    cpSync(join(src, name), join(dst, name), { recursive: true, filter: (p) => !['.kurultay', 'node_modules'].includes(basename(p)) });
  }
}

function addHidden(suiteDir: string, task: EvalTask, work: string): void {
  const dir = join(suiteDir, task.hidden ?? join('hidden', task.id));
  if (existsSync(dir)) cpSync(dir, work, { recursive: true });
}

async function check(cmd: string, cwd: string, timeoutSec: number): Promise<{ ok: boolean; output: string }> {
  const r = await runShell(cmd, cwd, timeoutSec * 1000);
  return { ok: r.code === 0 && !r.timedOut, output: r.output.slice(-4000) };
}

export interface EvalOptions {
  suiteDir: string;
  modes?: RunMode[];
  tasks?: string[];
  repeat?: number;
  /** where work copies and reports go (default: a temp folder) */
  outDir?: string;
  /** Kurultay config file for the runs (default: normal lookup → ~/.kurultay/config.json) */
  config?: string;
  /** only check that every task fails on the base project and passes with its reference solution */
  validate?: boolean;
  keepWork?: boolean;
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
}

/** Check the suite itself: hidden tests must fail on the base project and pass with solutions/<id>. */
export async function validateSuite(opts: EvalOptions): Promise<Array<{ task: string; baselineFails: boolean; solutionPasses: boolean | undefined; output: string }>> {
  const suite = loadSuite(opts.suiteDir);
  const out: Array<{ task: string; baselineFails: boolean; solutionPasses: boolean | undefined; output: string }> = [];
  const root = opts.outDir ?? join(tmpdir(), `kurultay-eval-validate-${Date.now()}`);
  for (const t of suite.tasks.filter((x) => !opts.tasks?.length || opts.tasks.includes(x.id))) {
    const cmd = t.check ?? suite.check!;
    const base = join(root, t.id, 'base');
    copyProject(join(opts.suiteDir, suite.project), base);
    if (suite.setup) await runShell(suite.setup, base, 600_000);
    addHidden(opts.suiteDir, t, base);
    const b = await check(cmd, base, t.timeoutSec ?? 600);
    let solutionPasses: boolean | undefined;
    let output = b.output;
    const sol = join(opts.suiteDir, 'solutions', t.id);
    if (existsSync(sol)) {
      const fixed = join(root, t.id, 'solution');
      copyProject(join(opts.suiteDir, suite.project), fixed);
      if (suite.setup) await runShell(suite.setup, fixed, 600_000);
      cpSync(sol, fixed, { recursive: true });
      addHidden(opts.suiteDir, t, fixed);
      const s = await check(cmd, fixed, t.timeoutSec ?? 600);
      solutionPasses = s.ok;
      if (!s.ok) output = s.output;
    }
    out.push({ task: t.id, baselineFails: !b.ok, solutionPasses, output });
    opts.onProgress?.(`${t.id}: baseline ${b.ok ? 'PASSES (invalid task!)' : 'fails ✓'}${solutionPasses === undefined ? '' : solutionPasses ? ' · solution passes ✓' : ' · solution FAILS'}`);
  }
  if (!opts.keepWork) rmSync(root, { recursive: true, force: true });
  return out;
}

export async function runEval(opts: EvalOptions): Promise<{ summary: EvalSummary; reportPath: string; jsonPath: string }> {
  const suite = loadSuite(opts.suiteDir);
  const modes = opts.modes?.length ? opts.modes : (['single'] as RunMode[]);
  const tasks = suite.tasks.filter((t) => !opts.tasks?.length || opts.tasks.includes(t.id));
  if (!tasks.length) throw new Error('no task selected');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = resolve(opts.outDir ?? join(tmpdir(), `kurultay-eval-${suite.name}-${stamp}`));
  mkdirSync(outDir, { recursive: true });
  const attempts: EvalAttempt[] = [];
  const startedAt = new Date().toISOString();
  for (let rep = 1; rep <= (opts.repeat ?? 1); rep++) {
    for (const task of tasks) {
      for (const mode of modes) {
        if (opts.signal?.aborted) break;
        const work = join(outDir, 'work', `${task.id}-${mode}-${rep}`);
        attempts.push(await runAttempt(opts, suite, task, mode, rep, work));
        const a = attempts[attempts.length - 1];
        opts.onProgress?.(`${a.passed ? '✓' : '✗'} ${task.id} [${mode}${(opts.repeat ?? 1) > 1 ? ` #${rep}` : ''}] ${a.status} · ${a.seconds.toFixed(1)} s · ${a.requests} req · ${a.tokensIn + a.tokensOut} tokens${a.error ? ` · ${a.error}` : ''}`);
        if (!opts.keepWork) rmSync(work, { recursive: true, force: true });
      }
    }
  }
  const byMode: EvalSummary['byMode'] = {};
  for (const m of modes) {
    const xs = attempts.filter((a) => a.mode === m);
    const avg = (f: (a: EvalAttempt) => number) => (xs.length ? xs.reduce((s, a) => s + f(a), 0) / xs.length : 0);
    byMode[m] = {
      attempts: xs.length,
      passed: xs.filter((a) => a.passed).length,
      passRate: xs.length ? xs.filter((a) => a.passed).length / xs.length : 0,
      avgSeconds: avg((a) => a.seconds),
      avgTokens: avg((a) => a.tokensIn + a.tokensOut),
      avgRequests: avg((a) => a.requests),
    };
  }
  const summary: EvalSummary = { suite: suite.name, startedAt, finishedAt: new Date().toISOString(), attempts, byMode };
  const jsonPath = join(outDir, 'results.json');
  writeFileSync(jsonPath, JSON.stringify(summary, null, 1));
  const reportPath = join(outDir, 'EVAL.md');
  writeFileSync(reportPath, renderEval(summary));
  return { summary, reportPath, jsonPath };
}

async function runAttempt(opts: EvalOptions, suite: EvalSuite, task: EvalTask, mode: RunMode, rep: number, work: string): Promise<EvalAttempt> {
  rmSync(work, { recursive: true, force: true });
  copyProject(join(opts.suiteDir, suite.project), work);
  const cmd = task.check ?? suite.check!;
  const timeoutSec = task.timeoutSec ?? 1800;
  const a: EvalAttempt = { task: task.id, mode, repeat: rep, passed: false, baselineFailed: false, status: 'error', seconds: 0, requests: 0, tokensIn: 0, tokensOut: 0, llmErrors: 0, models: [], changedFiles: 0, iterations: 0, checkOutput: '', workDir: work };
  if (suite.setup) await runShell(suite.setup, work, 600_000);
  // baseline: hidden tests must fail on the untouched project, in a throwaway copy
  const baseCopy = `${work}-baseline`;
  copyProject(work, baseCopy);
  addHidden(opts.suiteDir, task, baseCopy);
  a.baselineFailed = !(await check(cmd, baseCopy, timeoutSec)).ok;
  rmSync(baseCopy, { recursive: true, force: true });

  const bus = new EventBus();
  bus.on('event', (e: KEvent) => {
    if (e.type === 'llm.response') {
      a.requests++;
      a.tokensIn += Number(e.data?.in ?? 0);
      a.tokensOut += Number(e.data?.out ?? 0);
    } else if (e.type === 'llm.error') a.llmErrors++;
  });
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timed out')), timeoutSec * 1000);
  const onAbort = () => ctrl.abort(opts.signal?.reason);
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const app = await createApp({ root: work, config: opts.config, bus, requireModels: true, discoverTimeoutMs: 10_000 });
    if (!app.router.size) throw new Error('no usable model');
    app.config.orchestrator.confirmMerge = false;
    const { index } = loadOrBuildIndex(app);
    const report = await new Orchestrator(work, app.config, app.router, app.materializer, index, bus).run(task.prompt, { mode, signal: ctrl.signal });
    a.status = report.status;
    a.models = report.modelsUsed;
    a.changedFiles = report.changedFiles.length;
    a.iterations = report.iterations;
  } catch (e) {
    a.error = errorMessage(e).slice(0, 300);
    a.status = ctrl.signal.aborted ? 'timeout' : 'error';
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
  a.seconds = (Date.now() - t0) / 1000;
  addHidden(opts.suiteDir, task, work);
  const c = await check(cmd, work, timeoutSec);
  a.passed = c.ok;
  a.checkOutput = c.output;
  return a;
}

export function renderEval(s: EvalSummary): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lines = [
    `# Kurultay evaluation: ${s.suite}`,
    '',
    `${s.startedAt} → ${s.finishedAt}`,
    '',
    '## By mode',
    '',
    '| Mode | Attempts | Passed | Pass rate | Avg. time (s) | Avg. tokens | Avg. requests |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...Object.entries(s.byMode).map(([m, b]) => `| ${m} | ${b.attempts} | ${b.passed} | ${pct(b.passRate)} | ${b.avgSeconds.toFixed(1)} | ${Math.round(b.avgTokens)} | ${b.avgRequests.toFixed(1)} |`),
    '',
    '## Tasks',
    '',
    '| Task | Mode | Result | Status | Time (s) | Tokens | Requests | Files | Models |',
    '|---|---|---|---|---:|---:|---:|---:|---|',
    ...s.attempts.map(
      (a) =>
        `| ${a.task}${a.repeat > 1 ? ` #${a.repeat}` : ''} | ${a.mode} | ${a.passed ? '✅' : '❌'}${a.baselineFailed ? '' : ' ⚠ (task already passes on the baseline)'} | ${a.status}${a.error ? ` (${a.error.replace(/\|/g, '/')})` : ''} | ${a.seconds.toFixed(1)} | ${a.tokensIn + a.tokensOut} | ${a.requests} | ${a.changedFiles} | ${a.models.join(', ')} |`,
    ),
    '',
  ];
  const failed = s.attempts.filter((a) => !a.passed);
  if (failed.length) {
    lines.push('## Check output of failed attempts (last lines)', '');
    for (const a of failed) lines.push(`### ${a.task} [${a.mode}]`, '', '```', a.checkOutput.split('\n').slice(-15).join('\n'), '```', '');
  }
  return lines.join('\n');
}
