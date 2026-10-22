import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KurultayConfig, RunMode } from '../config.js';
import { diffStat } from '../agent/diff.js';
import { loadProjectRules, renderRules, selectRules, type ProjectRules } from '../agent/rules.js';
import { AgentWorker, type WorkerResult } from '../agent/worker.js';
import { CheckpointRecorder } from '../agent/checkpoint.js';
import { Overlay, type Materializer, type MergeReport } from '../agent/workspace.js';
import type { ProjectIndex } from '../index/project-index.js';
import type { Router } from '../llm/router.js';
import { JUDGE_SCHEMA } from '../llm/schemas.js';
import { SkillRegistry, selectSkillsFor, type SkillDiagnostic } from '../skills/skills.js';
import { errorMessage, settle } from '../util/async.js';
import type { EventBus } from '../util/events.js';
import { estimateTokens, truncateTokens, tryExtractJson } from '../util/text.js';
import { councilReview, type Candidate, type CouncilVerdict } from './council.js';
import { makePlan, type Plan, type SubTask } from './planner.js';
import { renderVerify, verifyFailureText, verifyOverlay, type VerifyResult } from './verify.js';

export interface RunOptions {
  mode?: RunMode;
  /** extra requirement text (e.g. contents of a requirements file) */
  requirements?: string;
  /** do not write results to the project – keep them in the session folder */
  dryRun?: boolean;
  /** asked before merging when config.orchestrator.confirmMerge is set */
  confirm?: (summary: string) => Promise<boolean>;
  signal?: AbortSignal;
  sessionId?: string;
  /** skills the user selected explicitly (--skill); `$name` in the task text works too */
  skills?: string[];
  /** use this registry instead of discovering skills (tests / embedding) */
  skillRegistry?: SkillRegistry;
  /**
   * Plan approval (Claude Code / Qwen Code "plan mode"): called with the plan
   * before any code is written. true = go, false = cancel, text = feedback that
   * makes the planners revise the plan.
   */
  approvePlan?: (plan: Plan, info: { mode: RunMode; round: number }) => Promise<boolean | string>;
  /** overrides config.orchestrator.maxTokens / maxMinutes for this run */
  budget?: { tokens?: number; minutes?: number };
}

/** Per-model consumption (REPORT.md table, /stats). */
export interface ModelUsage {
  requests: number;
  tokensIn: number;
  tokensOut: number;
  ms: number;
  errors: number;
  truncated: number;
}

export interface RunUsage {
  requests: number;
  tokensIn: number;
  tokensOut: number;
  /** wall-clock seconds spent in this run, across resumes */
  seconds: number;
  byModel: Record<string, ModelUsage>;
}

/** What is written to session.json after every subtask – enough to resume. */
export interface SessionState {
  version: 2;
  sessionId: string;
  task: string;
  fullTask: string;
  mode: RunMode;
  plan: Plan;
  overlay: ReturnType<Overlay['toJSON']>;
  reports: SubtaskReport[];
  iteration: number;
  /** the current iteration's queue has started (resume continues it instead of starting the next) */
  inProgress: boolean;
  queue: SubTask[];
  doneIds: string[];
  finalVerify?: VerifyResult;
  requirementCheck?: RunReport['requirementCheck'];
  phase: 'running' | 'stopped' | 'finished';
  stopReason?: string;
  usage: RunUsage;
  options: { dryRun?: boolean; skills?: string[] };
  savedAt?: string;
}

export interface SkillUsage {
  name: string;
  worker: string;
  how: 'preload' | 'tool';
  reason?: string;
}

export interface SubtaskReport {
  subtask: SubTask;
  iteration: number;
  candidates: Array<{ worker: string; models: string[]; status: string; files: number; verify?: string; summary: string }>;
  verdict?: Pick<CouncilVerdict, 'ranking' | 'winnerIssues'> & { reviewers: string[]; independent: boolean };
  winner?: { worker: string; models: string[] };
  fixes: number;
  /** re-reviews of fix rounds by a model that did not write the code */
  fixReviews?: Array<{ round: number; reviewers: string[]; blocking: number; independent: boolean }>;
  /** worker model switches (a model stopped answering) */
  failovers?: Array<{ worker: string; from: string; to: string; step: number; reason: string }>;
  status: 'done' | 'failed';
}

export interface RunReport {
  sessionId: string;
  sessionDir: string;
  task: string;
  mode: RunMode;
  plan: Plan;
  subtasks: SubtaskReport[];
  finalVerify?: VerifyResult;
  requirementCheck?: { complete: boolean; missing: string[]; judges: string[] };
  merge?: MergeReport;
  /** pre-apply snapshot for rewinding (absent when nothing was applied) */
  checkpointPath?: string;
  changedFiles: string[];
  diffPath: string;
  reportPath: string;
  iterations: number;
  status: 'completed' | 'incomplete' | 'failed' | 'dry-run' | 'cancelled';
  /** why the run stopped early (budget); continue with `kurultay run --resume <id>` */
  stopReason?: string;
  resumed?: boolean;
  usage?: RunUsage;
  modelsUsed: string[];
  skills: { available: number; used: SkillUsage[]; diagnostics: SkillDiagnostic[] };
}

interface Winner {
  overlay: Overlay;
  result: WorkerResult;
}

/** Extract likely identifiers / paths from free text to focus the repo map. */
export function focusTerms(text: string): { identifiers: string[]; files: string[] } {
  const files = [...text.matchAll(/[\w./-]+\.(?:c|h|cc|cpp|hpp|hh|java|kt|py|js|ts|tsx|go|rs|cs|cmake|txt|json|yaml|yml|xml|md)\b/g)].map((m) => m[0]);
  const ids = [...text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*(?:[A-Z_][A-Za-z0-9]*|_[a-z0-9]+)\b/g)].map((m) => m[0]).filter((w) => w.length > 3);
  return { identifiers: [...new Set(ids)].slice(0, 30), files: [...new Set(files)].slice(0, 20) };
}

export class Orchestrator {
  private rules!: ProjectRules;
  private skills: SkillRegistry = SkillRegistry.empty();
  private explicitSkills: string[] = [];
  private readonly skillUsage: SkillUsage[] = [];
  private readonly used = new Set<string>();
  private sessionDir = '';

  constructor(
    private readonly root: string,
    private readonly cfg: KurultayConfig,
    private readonly router: Router,
    private readonly materializer: Materializer,
    private readonly index: ProjectIndex | undefined,
    private readonly bus: EventBus,
  ) {}

  private get stateDir(): string {
    return join(this.root, this.cfg.stateDir);
  }

  /**
   * Context budget for the models that will actually read the prompt. Only
   * those models count – a small model elsewhere in the fleet must not shrink
   * the context of the 128K models (it simply is not given this prompt).
   */
  private contextBudget(share: number, models: string[]): number {
    const wins = models.map((k) => this.router.get(k)?.caps.contextWindow).filter((w): w is number => !!w);
    const all = wins.length ? wins : this.router.list().map((h) => h.caps.contextWindow);
    const min = all.length ? Math.min(...all) : 16_384;
    return Math.max(1200, Math.floor(min * share));
  }

  /** Files relevant to a text: BM25 + embeddings (RRF) when an embedding model is available. */
  private async retrieve(text: string, signal?: AbortSignal): Promise<string[]> {
    if (!this.index) return [];
    return [...new Set((await this.index.hybridSearch(text, 6, undefined, signal)).map((h) => h.path))];
  }

  private buildContext(text: string, files: string[] = [], budget = this.contextBudget(0.3, []), retrieved?: string[]): string {
    const parts: string[] = [];
    const archPath = join(this.stateDir, 'ARCHITECTURE.md');
    if (existsSync(archPath)) parts.push(`# PROJECT ARCHITECTURE (abridged)\n${truncateTokens(readFileSync(archPath, 'utf8'), Math.floor(budget * 0.35))}`);
    if (this.index) {
      const focus = focusTerms(text);
      const hits = retrieved ?? this.index.search(text, 6).map((h) => h.path);
      const map = this.index.repoMap(Math.floor(budget * 0.35), { files: [...files, ...focus.files, ...hits], identifiers: focus.identifiers });
      parts.push(`# REPO MAP (most relevant files and their definitions)\n${map}`);
      if (hits.length) parts.push(`# FILES MATCHING THE TASK (search)\n${[...new Set(hits)].map((h) => `- ${h}`).join('\n')}`);
    }
    const notes = join(this.stateDir, 'PROJECT_NOTES.md');
    if (existsSync(notes)) parts.push(`# PROJECT NOTES (stack, commands, conventions)\n${truncateTokens(readFileSync(notes, 'utf8'), Math.floor(budget * 0.2))}`);
    const rules = renderRules(selectRules(this.rules.rules, files), 'PROJECT RULES (must follow)');
    if (rules) parts.push(truncateTokens(rules, Math.floor(budget * 0.25)));
    return parts.join('\n\n');
  }

  private resolveMode(requested: RunMode, plan: Plan): RunMode {
    if (requested !== 'auto') return requested;
    if (this.router.size <= 1) return 'single';
    return plan.subtasks.length === 1 ? 'race' : 'split';
  }

  private widthFor(mode: RunMode, st: SubTask): number {
    const live = this.router.size;
    if (mode === 'race' || mode === 'council') return Math.max(1, Math.min(this.cfg.orchestrator.raceWidth, live));
    if (mode === 'split') return st.critical ? Math.min(2, live) : 1;
    return 1;
  }

  /** Shared start-up of run() and resume(). */
  private begin(sessionId: string, opts: RunOptions, task: string): void {
    this.sessionDir = join(this.stateDir, 'sessions', sessionId);
    mkdirSync(this.sessionDir, { recursive: true });
    this.bus.attachLog(join(this.sessionDir, 'events.jsonl'));
    const restored = this.materializer.recover();
    if (restored.length) this.bus.warn('orchestrator', `önceki yarım kalan çalışmadan ${restored.length} dosya geri yüklendi`);
    const nested = this.index?.files.map((f) => f.path).filter((p) => /(^|\/)(AGENTS|CLAUDE)\.md$/i.test(p) && p.includes('/')) ?? [];
    this.rules = loadProjectRules(this.root, this.stateDir, nested);
    this.skills =
      opts.skillRegistry ??
      SkillRegistry.discover(this.root, { extraPaths: this.cfg.skills.paths, disabled: this.cfg.skills.disabled, includeUser: this.cfg.skills.includeUser });
    this.explicitSkills = [...(opts.skills ?? []), ...this.skills.mentioned(task).map((s) => s.name)];
    for (const n of opts.skills ?? []) if (!this.skills.get(n)) this.bus.warn('skills', `istenen skill bulunamadı: ${n}`);
    if (this.skills.size) this.bus.info('skills', `${this.skills.size} skill bulundu${this.explicitSkills.length ? `; seçilen: ${this.explicitSkills.join(', ')}` : ''}`);
    this.stopReason = undefined;
  }

  async run(task: string, opts: RunOptions = {}): Promise<RunReport> {
    const sessionId = opts.sessionId ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.begin(sessionId, opts, task);
    const fullTask = opts.requirements ? `${task}\n\n# REQUIREMENTS DOCUMENT\n${opts.requirements}` : task;
    this.bus.emitEvent('run.start', { message: task, data: { sessionId, models: this.router.size } });
    const meter = this.startMeter(emptyUsage(), opts);
    try {
      const signal = anySignal(opts.signal, meter.signal);
      let planned: { plan: Plan; mode: RunMode } | undefined;
      try {
        planned = await this.planWithApproval(fullTask, opts, signal);
      } catch (e) {
        if (!this.stopReason) throw e;
      }
      const st: SessionState = {
        version: 2,
        sessionId,
        task,
        fullTask,
        mode: planned?.mode ?? 'single',
        plan: planned?.plan ?? { understanding: '', acceptance: [], subtasks: [], authors: [] },
        overlay: new Overlay('integration', this.root).toJSON(),
        reports: [],
        iteration: 0,
        inProgress: false,
        queue: planned?.plan.subtasks ?? [],
        doneIds: [],
        phase: 'running',
        usage: meter.usage,
        options: { dryRun: opts.dryRun, skills: opts.skills },
      };
      if (!planned) {
        // cancelled at plan approval, or the budget ran out while planning
        st.phase = 'finished'; // nothing was started – nothing to resume
        st.stopReason = this.stopReason;
        return this.finish(st, new Overlay('integration', this.root), this.stopReason ? 'incomplete' : 'cancelled', meter);
      }
      writeFileSync(join(this.sessionDir, 'plan.json'), JSON.stringify(planned.plan, null, 2));
      return await this.drive(st, opts, meter);
    } finally {
      meter.dispose();
    }
  }

  /**
   * Continue an interrupted run (Ctrl+C, crash, budget) from session.json:
   * finished subtasks are kept, the current iteration continues with the rest.
   */
  async resume(sessionId: string | undefined, opts: RunOptions = {}): Promise<RunReport> {
    const id = sessionId ?? Orchestrator.resumable(this.root, this.cfg.stateDir)[0]?.id;
    if (!id) throw new Error('Sürdürülecek yarım kalmış görev yok.');
    const file = join(this.stateDir, 'sessions', id, 'session.json');
    if (!existsSync(file)) throw new Error(`Oturum bulunamadı: ${id}`);
    const st = JSON.parse(readFileSync(file, 'utf8')) as SessionState;
    if (st.version !== 2) throw new Error(`${id} eski biçimde kaydedilmiş; sürdürülemez.`);
    if (st.phase === 'finished') throw new Error(`${id} zaten tamamlanmış.`);
    this.begin(id, { ...opts, skills: opts.skills ?? st.options.skills }, st.task);
    st.phase = 'running';
    st.stopReason = undefined;
    const left = st.inProgress ? st.queue.filter((t) => !st.doneIds.includes(t.id)).length : st.queue.length;
    this.bus.info('orchestrator', `${id} sürdürülüyor: iterasyon ${st.iteration}, ${left} alt görev kaldı`);
    this.bus.emitEvent('run.start', { message: st.task, data: { sessionId: id, models: this.router.size, resumed: true } });
    const meter = this.startMeter(st.usage ?? emptyUsage(), opts);
    try {
      return await this.drive(st, { ...opts, dryRun: opts.dryRun ?? st.options.dryRun }, meter, true);
    } finally {
      meter.dispose();
    }
  }

  /** Sessions that can be resumed, newest first. */
  static resumable(root: string, stateDir = '.kurultay'): Array<{ id: string; task: string; iteration: number; left: number; stopReason?: string; savedAt?: string }> {
    const dir = join(root, stateDir, 'sessions');
    if (!existsSync(dir)) return [];
    const out: ReturnType<typeof Orchestrator.resumable> = [];
    for (const id of readdirSync(dir).sort().reverse()) {
      try {
        const st = JSON.parse(readFileSync(join(dir, id, 'session.json'), 'utf8')) as SessionState;
        if (st.version !== 2 || st.phase === 'finished') continue;
        out.push({ id, task: st.task, iteration: st.iteration, left: st.inProgress ? st.queue.filter((t) => !st.doneIds.includes(t.id)).length : st.queue.length, stopReason: st.stopReason, savedAt: st.savedAt });
      } catch {
        /* not a resumable session */
      }
    }
    return out;
  }

  private stopReason: string | undefined;

  /** Count tokens/time per model and stop the run when the budget is exhausted. */
  private startMeter(usage: RunUsage, opts: RunOptions) {
    const tokens = opts.budget?.tokens ?? this.cfg.orchestrator.maxTokens ?? 0;
    const minutes = opts.budget?.minutes ?? this.cfg.orchestrator.maxMinutes ?? 0;
    const ctrl = new AbortController();
    const base = usage.seconds;
    const t0 = Date.now();
    const model = (k: string) => (usage.byModel[k] ??= { requests: 0, tokensIn: 0, tokensOut: 0, ms: 0, errors: 0, truncated: 0 });
    const check = () => {
      usage.seconds = Math.round((base + (Date.now() - t0) / 1000) * 10) / 10;
      if (this.stopReason) return;
      const used = usage.tokensIn + usage.tokensOut;
      if (tokens > 0 && used >= tokens) this.stopReason = `token bütçesi doldu (${used} / ${tokens})`;
      else if (minutes > 0 && usage.seconds >= minutes * 60) this.stopReason = `süre bütçesi doldu (${(usage.seconds / 60).toFixed(1)} / ${minutes} dk)`;
      if (this.stopReason) {
        this.bus.warn('orchestrator', `${this.stopReason}; çalışma durduruluyor (devam: kurultay run --resume)`);
        ctrl.abort(new Error(this.stopReason));
      }
    };
    const onEvent = (e: { type: string; source?: string; data?: Record<string, unknown> }) => {
      if (e.type === 'llm.response') {
        const m = model(e.source ?? '?');
        const i = Number(e.data?.in ?? 0);
        const o = Number(e.data?.out ?? 0);
        usage.requests++;
        usage.tokensIn += i;
        usage.tokensOut += o;
        m.requests++;
        m.tokensIn += i;
        m.tokensOut += o;
        m.ms += Number(e.data?.ms ?? 0);
        check();
      } else if (e.type === 'llm.error') model(e.source ?? '?').errors++;
      else if (e.type === 'llm.truncated') model(e.source ?? '?').truncated++;
    };
    this.bus.on('event', onEvent);
    const timer = minutes > 0 ? setInterval(check, 1000) : undefined;
    timer?.unref();
    return {
      usage,
      signal: ctrl.signal,
      dispose: () => {
        if (timer) clearInterval(timer);
        this.bus.off('event', onEvent);
        usage.seconds = Math.round((base + (Date.now() - t0) / 1000) * 10) / 10;
      },
    };
  }

  /** Plan with the council of planners; with approvePlan the user may revise it before any code is written. */
  private async planWithApproval(fullTask: string, opts: RunOptions, signal: AbortSignal | undefined): Promise<{ plan: Plan; mode: RunMode } | undefined> {
    let feedback = '';
    let prev: Plan | undefined;
    for (let round = 1; round <= 10; round++) {
      const text = prev
        ? `${fullTask}\n\n# USER FEEDBACK ON THE PREVIOUS PLAN (must be followed)\n${feedback}\n\n# PREVIOUS PLAN (revise it)\n${prev.subtasks.map((s) => `- ${s.id} ${s.title}: ${s.description.split('\n')[0]}`).join('\n')}`
        : fullTask;
      const drafts = Math.min(3, this.router.size);
      const planners = [...this.router.pick('planner', drafts), ...this.router.pick('judge', 1)].map((h) => h.caps.key);
      const context = this.buildContext(text, [], this.contextBudget(0.3, planners), await this.retrieve(text, signal));
      const plan = await makePlan(this.router, text, context, {
        drafts,
        contextTokens: this.contextBudget(0.45, planners),
        bus: this.bus,
        signal,
        skillCatalogue: this.skills.catalogue(),
      });
      plan.authors.forEach((a) => this.used.add(a.replace(/ \(.*$/, '')));
      const mode = this.resolveMode(opts.mode ?? this.cfg.orchestrator.defaultMode, plan);
      this.bus.emitEvent('run.plan', { data: { mode, subtasks: plan.subtasks.map((s) => s.title), acceptance: plan.acceptance, round } });
      if (!opts.approvePlan) return { plan, mode };
      const answer = await opts.approvePlan(plan, { mode, round });
      if (answer === false) {
        this.bus.info('orchestrator', 'plan reddedildi; görev iptal edildi');
        return undefined;
      }
      if (answer === true || !answer.trim()) return { plan, mode };
      feedback = feedback ? `${feedback}\n${answer.trim()}` : answer.trim();
      prev = plan;
      this.bus.emitEvent('run.replan', { message: answer.trim(), data: { round } });
    }
    return undefined;
  }

  /** execute → verify → requirement-check loop, then merge; persists after every subtask. */
  private async drive(st: SessionState, opts: RunOptions, meter: ReturnType<Orchestrator['startMeter']>, resumed = false): Promise<RunReport> {
    const signal = anySignal(opts.signal, meter.signal);
    const integration = Overlay.fromJSON(this.root, st.overlay);
    const save = () => this.persist(st, integration);
    try {
      for (;;) {
        if (!st.inProgress) {
          if (!st.queue.length || st.iteration >= this.cfg.orchestrator.maxIterations) break;
          st.iteration++;
          st.doneIds = [];
          st.inProgress = true;
          this.bus.emitEvent('run.iteration', { data: { iteration: st.iteration, subtasks: st.queue.length } });
          save();
        }
        const todo = st.queue.filter((t) => !st.doneIds.includes(t.id));
        await this.executeDag(todo, integration, st.mode, st.plan, st.fullTask, st.iteration, st.reports, signal, (id) => {
          st.doneIds.push(id);
          save();
        });
        if (signal?.aborted) throw signal.reason ?? new Error('iptal edildi');

        const finalVerify = await verifyOverlay(integration, this.materializer, this.cfg, signal);
        st.finalVerify = finalVerify;
        this.bus.emitEvent('run.verify', { data: { ok: finalVerify.ok, skipped: finalVerify.skipped } });
        const reqCheck = await this.requirementCheck(st.fullTask, st.plan, integration, finalVerify, st.reports, signal);
        if (signal?.aborted) throw signal.reason ?? new Error('iptal edildi');
        st.requirementCheck = reqCheck;
        this.bus.emitEvent('run.requirements', { data: reqCheck });
        st.inProgress = false;
        if (reqCheck.complete && (finalVerify.skipped || finalVerify.ok)) {
          st.queue = [];
          save();
          break;
        }
        // follow-up work for the next iteration
        const followups: SubTask[] = reqCheck.missing.map((m, i) => ({
          id: `F${st.iteration}.${i + 1}`,
          title: m.slice(0, 80),
          description: `Previous work is already applied. Complete this missing requirement:\n${m}`,
          files: [],
          dependsOn: [],
          critical: false,
        }));
        if (!finalVerify.skipped && !finalVerify.ok) {
          followups.unshift({
            id: `V${st.iteration}`,
            title: 'Derleme/test hatalarını düzelt',
            description: `The combined changes fail verification. Fix the failures without reverting the intended functionality:\n${verifyFailureText(finalVerify)}`,
            files: [],
            dependsOn: [],
            critical: true,
          });
        }
        // merge follow-ups touching the same concern into a single task when there are many
        st.queue = followups.length > 3 ? [{ ...followups[0], id: `F${st.iteration}`, title: 'Eksikleri tamamla', description: followups.map((f) => `- ${f.description}`).join('\n'), critical: true }] : followups;
        save();
      }
    } catch (e) {
      st.phase = 'stopped';
      st.stopReason = this.stopReason ?? errorMessage(e);
      meter.dispose();
      save();
      if (!this.stopReason) throw e; // user abort / error: the session stays resumable
      return this.finish(st, integration, 'incomplete', meter, resumed);
    }
    return this.finish(st, integration, undefined, meter, resumed, opts);
  }

  /** Merge (unless stopped/cancelled/dry-run), write REPORT.md and session.json. */
  private async finish(st: SessionState, integration: Overlay, forced: RunReport['status'] | undefined, meter: ReturnType<Orchestrator['startMeter']>, resumed = false, opts: RunOptions = {}): Promise<RunReport> {
    const changedFiles = integration.changedFiles();
    const diff = integration.diff();
    const diffPath = join(this.sessionDir, 'changes.diff');
    writeFileSync(diffPath, diff);
    const reqCheck = st.requirementCheck;
    const finalVerify = st.finalVerify;
    let merge: MergeReport | undefined;
    let checkpointPath: string | undefined;
    let status: RunReport['status'] = forced ?? (reqCheck?.complete && (!finalVerify || finalVerify.skipped || finalVerify.ok) ? 'completed' : changedFiles.length ? 'incomplete' : 'failed');
    if (forced) {
      /* stopped or cancelled: nothing is written to the project */
    } else if (opts.dryRun) status = 'dry-run';
    else if (changedFiles.length) {
      let go = true;
      if (this.cfg.orchestrator.confirmMerge && opts.confirm) {
        const ds = diffStat(diff);
        go = await opts.confirm(`${changedFiles.length} dosya, +${ds.added}/-${ds.removed} satır. Projeye uygulansın mı?`);
      }
      if (go) {
        // everything applied is recorded so it can be rewound later (/rewind, kurultay rewind)
        const recorder = new CheckpointRecorder(this.root);
        merge = await this.materializer.merge(integration, opts.signal, recorder);
        if (recorder.size) {
          checkpointPath = join(this.sessionDir, 'checkpoint.json');
          recorder.save(checkpointPath, `${st.sessionId}: ${st.task.split('\n')[0].slice(0, 120)}`);
        }
        this.bus.emitEvent('run.merge', { data: { ...merge } });
      } else status = 'dry-run';
    }
    if (!(forced === 'incomplete' && st.phase === 'stopped')) st.phase = 'finished';
    meter.dispose();
    const report: RunReport = {
      sessionId: st.sessionId,
      sessionDir: this.sessionDir,
      task: st.task,
      mode: st.mode,
      plan: st.plan,
      subtasks: st.reports,
      finalVerify,
      requirementCheck: reqCheck,
      merge,
      checkpointPath,
      changedFiles,
      diffPath,
      reportPath: join(this.sessionDir, 'REPORT.md'),
      iterations: st.iteration,
      status,
      stopReason: st.stopReason,
      resumed: resumed || undefined,
      usage: st.usage,
      modelsUsed: [...this.used],
      skills: { available: this.skills.size, used: [...this.skillUsage], diagnostics: this.skills.diagnostics },
    };
    this.persist(st, integration);
    this.router.learned?.save();
    writeFileSync(report.reportPath, renderReport(report, diff));
    this.bus.emitEvent('run.end', { data: { status, files: changedFiles.length, stopReason: report.stopReason } });
    return report;
  }

  /** Run subtasks respecting depends_on; independent ones run concurrently. */
  private async executeDag(tasks: SubTask[], integration: Overlay, mode: RunMode, plan: Plan, fullTask: string, iteration: number, reports: SubtaskReport[], signal?: AbortSignal, onDone?: (id: string) => void): Promise<void> {
    if (!tasks.length) return;
    const done = new Set<string>();
    const failed = new Set<string>();
    const pending = new Map(tasks.map((t) => [t.id, t]));
    const running = new Map<string, Promise<void>>();
    // how many subtasks may run at once: total capacity / average width
    const avgWidth = Math.max(1, Math.round(tasks.reduce((s, t) => s + this.widthFor(mode, t), 0) / tasks.length));
    const maxParallel = Math.max(1, Math.floor(this.router.totalCapacity() / avgWidth));

    while (pending.size || running.size) {
      if (signal?.aborted) throw new Error('iptal edildi');
      for (const [id, t] of pending) {
        if (running.size >= maxParallel) break;
        const deps = t.dependsOn;
        if (deps.some((d) => failed.has(d))) {
          pending.delete(id);
          failed.add(id);
          reports.push({ subtask: t, iteration, candidates: [], fixes: 0, status: 'failed' });
          this.bus.warn('orchestrator', `${id} atlandı: bağımlılığı başarısız`);
          onDone?.(id);
          continue;
        }
        if (!deps.every((d) => done.has(d) || !tasks.some((x) => x.id === d))) continue; // deps outside this batch finished before a resume
        pending.delete(id);
        const p = this.runSubtask(t, integration, mode, plan, fullTask, iteration, signal)
          .then((r) => {
            if (signal?.aborted) return; // interrupted: rerun on resume
            reports.push(r);
            (r.status === 'done' ? done : failed).add(id);
            onDone?.(id);
          })
          .catch((e) => {
            failed.add(id);
            if (signal?.aborted) return;
            reports.push({ subtask: t, iteration, candidates: [], fixes: 0, status: 'failed' });
            this.bus.error('orchestrator', `${id} hata: ${errorMessage(e)}`);
            onDone?.(id);
          })
          .finally(() => running.delete(id));
        running.set(id, p);
      }
      if (running.size) await Promise.race(running.values());
      else if (pending.size) {
        // unsatisfiable dependencies (should not happen after topo check) – run the rest without deps
        for (const t of pending.values()) t.dependsOn = [];
      }
    }
  }

  /** Skill selection for one subtask: explicit > always > keyword > planner choice; lexical → recommended. */
  private skillsFor(st: SubTask, fullTask: string) {
    const sel = selectSkillsFor(this.skills, {
      text: `${fullTask}\n${st.title}\n${st.description}`,
      files: st.files,
      explicit: this.explicitSkills,
      planned: st.skills,
      maxPreload: this.cfg.skills.maxPreload,
    });
    return { registry: this.skills, preload: sel.preload, recommended: sel.recommended, explicit: new Set(this.explicitSkills), files: st.files.length ? st.files : undefined, reasons: sel.reasons };
  }

  private recordSkills(worker: string, r: WorkerResult, reasons: Record<string, string>): void {
    for (const s of r.skills) this.skillUsage.push({ name: s.name, worker, how: s.how, reason: s.how === 'preload' ? reasons[s.name] : 'model istedi' });
  }

  private workerTask(st: SubTask, plan: Plan, fullTask: string): string {
    return `Overall goal: ${fullTask}
${plan.understanding ? `\nPlan summary: ${plan.understanding}\n` : ''}
Your subtask (${st.id} – ${st.title}):
${st.description}
${st.files.length ? `\nFiles likely involved: ${st.files.join(', ')}` : ''}
Only implement YOUR subtask; other engineers handle the rest in parallel.${this.cfg.orchestrator.testFirst === false ? '' : `\n\n${testingGuidance(`${fullTask}\n${st.title}\n${st.description}`, this.cfg.verify.test ?? '')}`}`;
  }

  private async runSubtask(st: SubTask, integration: Overlay, mode: RunMode, plan: Plan, fullTask: string, iteration: number, signal?: AbortSignal): Promise<SubtaskReport> {
    const width = this.widthFor(mode, st);
    const models = this.router.pick('coder', width);
    // every worker gets a context sized for ITS model's window
    const contexts = new Map<number, string>();
    const retrieved = await this.retrieve(`${st.title}\n${st.description}`, signal);
    const contextFor = (mk: string) => {
      const budget = this.contextBudget(0.3, [mk]);
      if (!contexts.has(budget)) contexts.set(budget, this.buildContext(`${st.title}\n${st.description}`, st.files, budget, retrieved));
      return contexts.get(budget)!;
    };
    const workerSkills = this.skillsFor(st, fullTask);
    const report: SubtaskReport = { subtask: st, iteration, candidates: [], fixes: 0, status: 'failed' };
    this.bus.emitEvent('subtask.start', { source: st.id, data: { title: st.title, models: models.map((m) => m.caps.key) } });

    const launch = (modelKeys: string[], suffix: string) =>
      settle(
        modelKeys.map(async (mk, i) => {
          const overlay = integration.fork(`${st.id}${suffix}-${i + 1}`);
          const w = new AgentWorker(
            { id: overlay.id, task: this.workerTask(st, plan, fullTask), acceptance: plan.acceptance, context: contextFor(mk), model: mk, overlay, skills: workerSkills },
            this.router,
            this.cfg,
            { index: this.index, materializer: this.materializer, root: this.root, bus: this.bus, signal },
          );
          const result = await w.run();
          result.models.forEach((m) => this.used.add(m));
          for (const f of result.failovers) (report.failovers ??= []).push({ worker: overlay.id, ...f });
          this.recordSkills(overlay.id, result, workerSkills.reasons);
          return { overlay, result } as Winner;
        }),
      );

    let runs = (await launch(models.map((m) => m.caps.key), '')).filter((r): r is { ok: true; value: Winner } => r.ok).map((r) => r.value);
    let usable = runs.filter((r) => r.result.status !== 'failed' && r.overlay.ownChanges().length > 0);
    if (!usable.length) {
      // retry on models that were not tried yet
      const tried = new Set(runs.flatMap((r) => r.result.models).concat(models.map((m) => m.caps.key)));
      const others = this.router.pick('coder', Math.max(1, Math.min(2, width)), [...tried]);
      if (others.length) {
        this.bus.warn(st.id, `hiçbir aday değişiklik üretmedi; ${others.map((o) => o.caps.key).join(', ')} ile yeniden deneniyor`);
        const again = (await launch(others.map((o) => o.caps.key), 'r')).filter((r): r is { ok: true; value: Winner } => r.ok).map((r) => r.value);
        runs = runs.concat(again);
        usable = again.filter((r) => r.result.status !== 'failed' && r.overlay.ownChanges().length > 0);
      }
    }
    for (const r of runs) {
      report.candidates.push({ worker: r.overlay.id, models: r.result.models, status: r.result.status, files: r.overlay.ownChanges().length, summary: r.result.summary.slice(0, 500) });
    }
    if (!usable.length) {
      // a subtask may legitimately need no change (e.g. "verify X") – accept a clean 'done'
      const clean = runs.find((r) => r.result.status === 'done');
      report.status = clean ? 'done' : 'failed';
      if (clean) report.winner = { worker: clean.overlay.id, models: clean.result.models };
      return report;
    }

    // ---- verify every candidate (objective evidence)
    const verifies = new Map<string, VerifyResult>();
    for (const r of usable) {
      const v = await verifyOverlay(r.overlay, this.materializer, this.cfg, signal);
      verifies.set(r.overlay.id, v);
      const c = report.candidates.find((x) => x.worker === r.overlay.id);
      if (c) c.verify = v.skipped ? 'yok' : v.ok ? 'geçti' : `kaldı (${v.score.toFixed(2)})`;
    }

    // ---- council review (anonymous ranking); single candidates still get a reviewer when possible
    const reviewRules = this.rules.review.map((r) => r.body).join('\n\n');
    const candidates: Candidate[] = usable.map((r) => {
      const v = verifies.get(r.overlay.id)!;
      return { id: r.overlay.id, author: r.result.models[0] ?? '', authors: [...r.result.models, ...r.result.failovers.map((f) => f.from)], diff: r.overlay.diffAgainstParent(), summary: r.result.summary, verifyScore: v.skipped ? undefined : v.score, verifyOk: v.skipped ? undefined : v.ok };
    });
    let winner: Winner = usable[0];
    let verdict: CouncilVerdict | undefined;
    const reviewers = usable.length > 1 || mode === 'council' ? this.cfg.orchestrator.councilSize : this.router.size > 1 || reviewRules ? 1 : 0;
    if (reviewers > 0) {
      try {
        verdict = await councilReview(this.router, {
          task: `${st.title}\n${st.description}`,
          acceptance: plan.acceptance,
          candidates,
          reviewRules,
          reviewers,
          contextTokens: this.contextBudget(0.5, this.router.pick('reviewer', this.cfg.orchestrator.councilSize).map((h) => h.caps.key)),
          bus: this.bus,
          signal,
        });
        verdict.reviews.forEach((r) => this.used.add(r.reviewer));
        if (verdict.winner) winner = usable.find((u) => u.overlay.id === verdict!.winner!.id) ?? winner;
        report.verdict = { ranking: verdict.ranking, winnerIssues: verdict.winnerIssues, reviewers: verdict.reviews.map((r) => r.reviewer), independent: !!verdict.independent };
      } catch (e) {
        this.bus.warn(st.id, `konsey incelemesi başarısız: ${errorMessage(e)}`);
      }
    } else if (usable.length > 1) {
      winner = [...usable].sort((a, b) => (verifies.get(b.overlay.id)?.score ?? 0) - (verifies.get(a.overlay.id)?.score ?? 0))[0];
    }
    this.bus.emitEvent('subtask.winner', { source: st.id, data: { worker: winner.overlay.id, models: winner.result.models } });
    // learn from the outcome: verified code (or, without tests, the council's pick) counts as a coder success
    for (const r of runs) {
      const v = verifies.get(r.overlay.id);
      const ok = !!v && r.result.status !== 'failed' && (v.skipped ? r === winner : v.ok);
      for (const m of new Set([...r.result.models, ...r.result.failovers.map((f) => f.from)])) this.router.recordOutcome(m, 'coder', r.result.failovers.some((f) => f.from === m) ? false : ok);
    }

    // ---- fix rounds: failing verification or blocking review issues
    let wv = verifies.get(winner.overlay.id)!;
    let blocking = (verdict?.winnerIssues ?? []).filter((i) => i.blocking);
    for (let round = 1; round <= 2 && ((!wv.skipped && !wv.ok) || blocking.length); round++) {
      const fixOverlay = winner.overlay.fork(`${winner.overlay.id}-fix${round}`);
      const problems = [
        !wv.skipped && !wv.ok ? `Verification failures:\n${verifyFailureText(wv)}` : '',
        blocking.length ? `Blocking review findings:\n${blocking.map((b) => `- ${b.text}`).join('\n')}` : '',
      ].filter(Boolean).join('\n\n');
      const fixer = new AgentWorker(
        {
          id: fixOverlay.id,
          task: `${this.workerTask(st, plan, fullTask)}\n\nYour implementation is already applied, but it has problems that must be fixed now:\n${problems}`,
          acceptance: plan.acceptance,
          context: contextFor(winner.result.finalModel || winner.result.models[0] || models[0]?.caps.key || ''),
          // continue on the model that was still answering at the end, not the one that failed over
          model: winner.result.finalModel || winner.result.models[0] || models[0]?.caps.key || '',
          overlay: fixOverlay,
          maxSteps: Math.ceil(this.cfg.orchestrator.maxStepsPerWorker * 0.6),
          skills: workerSkills,
        },
        this.router,
        this.cfg,
        { index: this.index, materializer: this.materializer, root: this.root, bus: this.bus, signal },
      );
      const fr = await fixer.run();
      fr.models.forEach((m) => this.used.add(m));
      for (const f of fr.failovers) (report.failovers ??= []).push({ worker: fixOverlay.id, ...f });
      this.recordSkills(fixOverlay.id, fr, workerSkills.reasons);
      report.fixes++;
      if (fixOverlay.ownChanges().length === 0) break;
      const fv = await verifyOverlay(fixOverlay, this.materializer, this.cfg, signal);
      if (!fv.skipped) for (const m of fr.models) this.router.recordOutcome(m, 'coder', fv.ok);
      if (fv.skipped || fv.score >= wv.score) {
        const hadBlocking = blocking.length > 0;
        winner.overlay.absorb(fixOverlay);
        wv = fv;
        blocking = [];
        // the fix must be checked by a model that did not write it, not taken on the author's word
        if (hadBlocking && reviewers > 0) {
          try {
            const authors = [...new Set([...candidates.find((c) => c.id === winner.overlay.id)!.authors!, ...fr.models, ...fr.failovers.map((f) => f.from)])];
            const re = await councilReview(this.router, {
              task: `${st.title}\n${st.description}\n\nThis is the corrected version after review findings:\n${problems}`,
              acceptance: plan.acceptance,
              candidates: [{ id: winner.overlay.id, author: authors[0] ?? '', authors, diff: winner.overlay.diffAgainstParent(), summary: fr.summary, verifyScore: fv.skipped ? undefined : fv.score, verifyOk: fv.skipped ? undefined : fv.ok }],
              reviewRules,
              reviewers: 1,
              contextTokens: this.contextBudget(0.5, this.router.pick('reviewer', this.cfg.orchestrator.councilSize).map((h) => h.caps.key)),
              bus: this.bus,
              signal,
            });
            re.reviews.forEach((r) => this.used.add(r.reviewer));
            blocking = re.winnerIssues.filter((i) => i.blocking);
            (report.fixReviews ??= []).push({ round, reviewers: re.reviews.map((r) => r.reviewer), blocking: blocking.length, independent: !!re.independent });
            if (blocking.length) this.bus.warn(st.id, `düzeltme yeniden incelendi: ${blocking.length} engelleyici bulgu kaldı`);
          } catch (e) {
            this.bus.warn(st.id, `düzeltmenin yeniden incelemesi başarısız: ${errorMessage(e)}`);
          }
        }
      } else break;
    }

    const absorbed = integration.absorb(winner.overlay);
    if (absorbed.conflicts.length) this.bus.warn(st.id, `birleştirme çakışması: ${absorbed.conflicts.join(', ')} (çakışma işaretleri eklendi)`);
    report.winner = { worker: winner.overlay.id, models: winner.result.models };
    report.status = 'done';
    return report;
  }

  private async requirementCheck(task: string, plan: Plan, integration: Overlay, verify: VerifyResult, reports: SubtaskReport[], signal?: AbortSignal): Promise<{ complete: boolean; missing: string[]; judges: string[] }> {
    const diff = integration.diff();
    if (!diff.trim()) return { complete: false, missing: ['Hiçbir değişiklik üretilmedi'], judges: [] };
    // judges that did not write the winning code come first
    const writers = [...new Set(reports.flatMap((r) => r.winner?.models ?? []))];
    const want = Math.min(2, this.router.size);
    let judges = this.router.pick('judge', want, writers);
    if (judges.length < want) judges = [...judges, ...this.router.pick('judge', want - judges.length, judges.map((j) => j.caps.key))];
    const budget = this.contextBudget(0.55, judges.map((j) => j.caps.key));
    const prompt = `You are the final acceptance judge. Decide whether the combined change fully satisfies the task and its acceptance criteria. Be strict but do not invent requirements.

# TASK
${task}
${plan.acceptance.length ? `\n# ACCEPTANCE CRITERIA\n${plan.acceptance.map((a) => `- ${a}`).join('\n')}` : ''}

# VERIFICATION
${renderVerify(verify)}
${!verify.skipped && !verify.ok ? truncateTokens(verifyFailureText(verify), 1200) : ''}

# WORK LOG
${reports.map((r) => `- ${r.subtask.id} ${r.subtask.title}: ${r.status}`).join('\n')}

# COMBINED DIFF
\`\`\`diff
${truncateTokens(diff, Math.max(800, budget - estimateTokens(task) - 800))}
\`\`\`

Return ONLY JSON: {"complete": true|false, "missing": ["each unmet requirement as an actionable instruction"]}`;
    const res = await settle(judges.map((j) => this.router.chat({ messages: [{ role: 'user', content: prompt }], temperature: 0, jsonMode: true, jsonSchema: JUDGE_SCHEMA, maxTokens: 1500, purpose: 'requirements', signal }, { prefer: [j.caps.key], role: 'judge' })));
    const verdicts = res.filter((r): r is { ok: true; value: Awaited<ReturnType<Router['chat']>> } => r.ok).map((r) => ({ model: r.value.model, j: tryExtractJson<{ complete?: boolean; missing?: string[] }>(r.value.content) }));
    verdicts.forEach((v) => {
      this.used.add(v.model);
      this.router.recordOutcome(v.model, 'judge', !!v.j && typeof v.j.complete === 'boolean');
    });
    const valid = verdicts.filter((v) => v.j);
    if (!valid.length) return { complete: true, missing: [], judges: [] }; // cannot judge → rely on verification
    const complete = valid.every((v) => v.j!.complete === true);
    const missing = [...new Set(valid.flatMap((v) => (v.j!.missing ?? []).filter((m) => typeof m === 'string' && m.trim())))].slice(0, 8);
    return { complete: complete || missing.length === 0, missing: complete ? [] : missing, judges: valid.map((v) => v.model) };
  }

  private persist(st: SessionState, integration: Overlay): void {
    st.overlay = integration.toJSON();
    st.savedAt = new Date().toISOString();
    writeFileSync(join(this.sessionDir, 'session.json'), JSON.stringify(st, null, 1));
  }
}

function emptyUsage(): RunUsage {
  return { requests: 0, tokensIn: 0, tokensOut: 0, seconds: 0, byModel: {} };
}

function anySignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const list = signals.filter((x): x is AbortSignal => !!x);
  return list.length > 1 ? AbortSignal.any(list) : list[0];
}

const BUG_WORDS = /\b(fix|bug|crash|wrong|incorrect|broken|regression|leak|overflow|race|deadlock|hata|düzelt|yanlış|çök|sızıntı|taşma|bozuk)/i;

/**
 * Test-first guidance for workers (SWE-agent / Aider practice): reproduce bugs
 * before fixing them and leave tests behind, so verification has evidence
 * instead of depending only on LLM judges.
 */
export function testingGuidance(text: string, testCommand: string): string {
  const lines = ['TESTING (required):'];
  if (BUG_WORDS.test(text)) {
    lines.push('- This looks like a bug fix: FIRST reproduce it with a failing test (or a minimal script), run it and see it fail, THEN fix the code and run it again to see it pass.');
  }
  if (testCommand.trim()) {
    lines.push(`- Add or extend tests for the behaviour you change, next to the existing tests and in their style. Run the suite with \`${testCommand.trim()}\` and make it pass.`);
  } else {
    lines.push('- The project has no configured test command: write a small self-check (a test file in the project\'s usual test location/style, or a script) that exercises your change, run it with run_command, and mention it in your finish summary.');
  }
  lines.push('- Do not delete or weaken existing tests to make them pass.');
  return lines.join('\n');
}

export function renderReport(r: RunReport, diff: string): string {
  const st = diffStat(diff);
  const lines: string[] = [
    `# Kurultay Çalışma Raporu`,
    '',
    `- **Oturum:** ${r.sessionId}`,
    `- **Durum:** ${r.status}`,
    `- **Mod:** ${r.mode} · **İterasyon:** ${r.iterations}`,
    `- **Değişen dosyalar:** ${r.changedFiles.length} (+${st.added} / -${st.removed})`,
    `- **Kullanılan modeller:** ${r.modelsUsed.join(', ') || '-'}`,
    ...(r.usage ? [`- **Tüketim:** ${r.usage.requests} istek · ${fmtTokens(r.usage.tokensIn)} giriş / ${fmtTokens(r.usage.tokensOut)} çıkış token · ${fmtDuration(r.usage.seconds)}${r.resumed ? ' (sürdürülen oturum dahil)' : ''}`] : []),
    ...(r.stopReason ? [`- **Durduruldu:** ${r.stopReason} — kaldığı yerden devam: \`kurultay run --resume ${r.sessionId}\``] : []),
    ...(r.status === 'cancelled' ? ['- **İptal:** plan onaylanmadı, kod yazılmadı'] : []),
    '',
    '## Görev',
    '',
    r.task,
    '',
    '## Plan',
    '',
    r.plan.understanding || '-',
    '',
    `Plan yazarları: ${r.plan.authors.join(', ') || '-'}`,
    '',
    ...(r.plan.acceptance.length ? ['### Kabul kriterleri', '', ...r.plan.acceptance.map((a) => `- ${a}`), ''] : []),
    '## Alt görevler',
    '',
  ];
  for (const s of r.subtasks) {
    lines.push(`### ${s.subtask.id} – ${s.subtask.title} (${s.status}, iterasyon ${s.iteration})`, '');
    for (const c of s.candidates) {
      const win = s.winner?.worker === c.worker ? ' 🏆' : '';
      lines.push(`- \`${c.worker}\` [${c.models.join(', ')}] → ${c.status}, ${c.files} dosya, doğrulama: ${c.verify ?? '-'}${win}`);
    }
    if (s.verdict) {
      const how = s.verdict.independent
        ? 'bağımsız (kodu yazan model incelemedi)'
        : s.candidates.length > 1 && s.verdict.reviewers.length
          ? 'kısmen bağımsız (inceleyenler aynı zamanda aday yazarı; kendi adaylarına verdikleri oy sayılmadı)'
          : '⚠ bağımsız inceleme yapılamadı (kodu yazan modeller dışında kullanılabilir model yok)';
      lines.push('', `İnceleyen modeller: ${s.verdict.reviewers.join(', ') || '-'} — ${how}`);
    }
    if (s.verdict?.ranking.length) lines.push('', `Konsey sıralaması: ${s.verdict.ranking.map((x) => `${x.id} (${x.points})`).join(' > ')}`);
    if (s.verdict?.winnerIssues.length) lines.push('', 'İnceleme bulguları:', ...s.verdict.winnerIssues.map((i) => `- ${i.blocking ? '**[engelleyici]** ' : ''}${i.text} — _${i.reviewer}_`));
    if (s.fixes) lines.push('', `Düzeltme turu: ${s.fixes}`);
    for (const fr of s.fixReviews ?? []) lines.push(`- ${fr.round}. düzeltme yeniden incelendi (${fr.reviewers.join(', ') || '-'}): ${fr.blocking ? `${fr.blocking} engelleyici bulgu kaldı` : 'engelleyici bulgu yok'}`);
    if (s.failovers?.length) lines.push('', 'Model değişimleri (yanıt vermeyen model bırakıldı):', ...s.failovers.map((f) => `- \`${f.worker}\` adım ${f.step}: ${f.from} → ${f.to} (${f.reason})`));
    lines.push('');
  }
  if (r.finalVerify) lines.push('## Son doğrulama', '', renderVerify(r.finalVerify), '');
  if (r.requirementCheck) {
    lines.push('## Gereksinim kontrolü', '', `Tamamlandı: ${r.requirementCheck.complete ? 'evet' : 'hayır'} (hakemler: ${r.requirementCheck.judges.join(', ') || '-'})`);
    if (r.requirementCheck.missing.length) lines.push('', ...r.requirementCheck.missing.map((m) => `- ${m}`));
    lines.push('');
  }
  if (r.merge) {
    lines.push('## Projeye uygulama', '', `Yazılan: ${r.merge.written.length}, silinen: ${r.merge.deleted.length}, 3-yollu birleştirme: ${r.merge.merged3way.length}, çakışma: ${r.merge.conflicts.length}`);
    if (r.merge.conflicts.length) lines.push('', 'Çakışan dosyalar (işaretleri elle çözün):', ...r.merge.conflicts.map((c) => `- ${c}`));
    lines.push('');
  }
  if (r.skills && (r.skills.used.length || r.skills.available)) {
    lines.push("## Skill'ler", '', `Bulunan: ${r.skills.available}`);
    if (r.skills.used.length) {
      lines.push('', '| Skill | Çalışan | Nasıl | Neden |', '|---|---|---|---|', ...r.skills.used.map((u) => `| ${u.name} | ${u.worker} | ${u.how === 'preload' ? 'baştan yüklendi' : 'model yükledi'} | ${u.reason ?? '-'} |`));
    } else lines.push('', 'Bu çalışmada skill kullanılmadı.');
    if (r.skills.diagnostics.length) lines.push('', 'Uyarılar:', ...r.skills.diagnostics.map((d) => `- ${d.path}: ${d.message}`));
    lines.push('');
  }
  if (r.usage && Object.keys(r.usage.byModel).length) lines.push('## Model kullanımı', '', ...renderUsageTable(r.usage), '');
  lines.push('## Değişiklikler', '', `Tam diff: \`${r.diffPath}\``, '');
  return lines.join('\n');
}

/** Usage of the last `n` runs from session.json files, newest first. */
export function loadRunUsage(stateDir: string, n = 10): Array<{ id: string; task: string; status: string; usage: RunUsage }> {
  const dir = join(stateDir, 'sessions');
  if (!existsSync(dir)) return [];
  const out: ReturnType<typeof loadRunUsage> = [];
  for (const id of readdirSync(dir).sort().reverse()) {
    if (out.length >= n) break;
    try {
      const st = JSON.parse(readFileSync(join(dir, id, 'session.json'), 'utf8')) as Partial<SessionState>;
      if (!st.usage) continue;
      const rep = existsSync(join(dir, id, 'REPORT.md')) ? readFileSync(join(dir, id, 'REPORT.md'), 'utf8') : '';
      out.push({ id, task: st.task ?? '', status: rep.match(/\*\*Durum:\*\* (\S+)/)?.[1] ?? st.phase ?? '?', usage: st.usage });
    } catch {
      /* not a run session */
    }
  }
  return out;
}

export function mergeUsage(into: RunUsage, u: RunUsage): RunUsage {
  into.requests += u.requests;
  into.tokensIn += u.tokensIn;
  into.tokensOut += u.tokensOut;
  into.seconds += u.seconds;
  for (const [k, m] of Object.entries(u.byModel)) {
    const t = (into.byModel[k] ??= { requests: 0, tokensIn: 0, tokensOut: 0, ms: 0, errors: 0, truncated: 0 });
    for (const f of ['requests', 'tokensIn', 'tokensOut', 'ms', 'errors', 'truncated'] as const) t[f] += m[f];
  }
  return into;
}

/** Markdown table of per-model consumption (REPORT.md, /stats). */
export function renderUsageTable(u: RunUsage): string[] {
  const rows = Object.entries(u.byModel).sort((a, b) => b[1].tokensIn + b[1].tokensOut - (a[1].tokensIn + a[1].tokensOut));
  return [
    '| Model | İstek | Giriş token | Çıkış token | Ort. yanıt | Hata | Kesilme |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...rows.map(([k, m]) => `| ${k} | ${m.requests} | ${fmtTokens(m.tokensIn)} | ${fmtTokens(m.tokensOut)} | ${m.requests ? (m.ms / m.requests / 1000).toFixed(1) + ' sn' : '-'} | ${m.errors} | ${m.truncated} |`),
  ];
}

export function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}K` : String(n);
}

export function fmtDuration(sec: number): string {
  return sec >= 3600 ? `${Math.floor(sec / 3600)} sa ${Math.round((sec % 3600) / 60)} dk` : sec >= 60 ? `${Math.floor(sec / 60)} dk ${Math.round(sec % 60)} sn` : `${sec.toFixed(1)} sn`;
}

/** Plan as shown for approval (console /plan, run --approve-plan). */
export function renderPlan(plan: Plan, mode: RunMode): string {
  const lines = [`Plan (${mode} modu, ${plan.subtasks.length} alt görev; yazarlar: ${plan.authors.join(', ') || '-'})`];
  if (plan.understanding) lines.push('', plan.understanding);
  for (const s of plan.subtasks) {
    lines.push('', `${s.id}. ${s.title}${s.critical ? ' [kritik]' : ''}${s.dependsOn.length ? ` (önce: ${s.dependsOn.join(', ')})` : ''}`, ...s.description.split('\n').map((l) => `   ${l}`));
    if (s.files.length) lines.push(`   dosyalar: ${s.files.join(', ')}`);
  }
  if (plan.acceptance.length) lines.push('', 'Kabul kriterleri:', ...plan.acceptance.map((a) => `  - ${a}`));
  return lines.join('\n');
}
