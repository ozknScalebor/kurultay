import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KurultayConfig, RunMode } from '../config.js';
import { diffStat } from '../agent/diff.js';
import { loadProjectRules, renderRules, selectRules, type ProjectRules } from '../agent/rules.js';
import { AgentWorker, type WorkerResult } from '../agent/worker.js';
import { Overlay, type Materializer, type MergeReport } from '../agent/workspace.js';
import type { ProjectIndex } from '../index/project-index.js';
import type { Router } from '../llm/router.js';
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
  verdict?: Pick<CouncilVerdict, 'ranking' | 'winnerIssues'>;
  winner?: { worker: string; models: string[] };
  fixes: number;
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
  changedFiles: string[];
  diffPath: string;
  reportPath: string;
  iterations: number;
  status: 'completed' | 'incomplete' | 'failed' | 'dry-run';
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

  /** Context budget that fits the smallest coder window. */
  private contextBudget(share = 0.3): number {
    const wins = this.router.list().map((h) => h.caps.contextWindow);
    const min = wins.length ? Math.min(...wins) : 16_384;
    return Math.max(1200, Math.floor(min * share));
  }

  private buildContext(text: string, files: string[] = []): string {
    const budget = this.contextBudget();
    const parts: string[] = [];
    const archPath = join(this.stateDir, 'ARCHITECTURE.md');
    if (existsSync(archPath)) parts.push(`# PROJECT ARCHITECTURE (abridged)\n${truncateTokens(readFileSync(archPath, 'utf8'), Math.floor(budget * 0.35))}`);
    if (this.index) {
      const focus = focusTerms(text);
      const hits = this.index.search(text, 6).map((h) => h.path);
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

  async run(task: string, opts: RunOptions = {}): Promise<RunReport> {
    const sessionId = opts.sessionId ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
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

    const fullTask = opts.requirements ? `${task}\n\n# REQUIREMENTS DOCUMENT\n${opts.requirements}` : task;
    this.bus.emitEvent('run.start', { message: task, data: { sessionId, models: this.router.size } });

    // ---- 1. plan (council of planners)
    const context = this.buildContext(fullTask);
    const plan = await makePlan(this.router, fullTask, context, {
      drafts: Math.min(3, this.router.size),
      contextTokens: this.contextBudget(0.45),
      bus: this.bus,
      signal: opts.signal,
      skillCatalogue: this.skills.catalogue(),
    });
    plan.authors.forEach((a) => this.used.add(a.replace(/ \(.*$/, '')));
    const mode = this.resolveMode(opts.mode ?? this.cfg.orchestrator.defaultMode, plan);
    this.bus.emitEvent('run.plan', { data: { mode, subtasks: plan.subtasks.map((s) => s.title), acceptance: plan.acceptance } });
    writeFileSync(join(this.sessionDir, 'plan.json'), JSON.stringify(plan, null, 2));

    const integration = new Overlay('integration', this.root);
    const reports: SubtaskReport[] = [];
    let queue: SubTask[] = plan.subtasks;
    let finalVerify: VerifyResult | undefined;
    let reqCheck: RunReport['requirementCheck'];
    let iteration = 0;

    // ---- 2. execute → verify → requirement check loop
    while (queue.length && iteration < this.cfg.orchestrator.maxIterations) {
      iteration++;
      this.bus.emitEvent('run.iteration', { data: { iteration, subtasks: queue.length } });
      await this.executeDag(queue, integration, mode, plan, fullTask, iteration, reports, opts.signal);
      this.persist(sessionId, task, plan, integration, reports);

      finalVerify = await verifyOverlay(integration, this.materializer, this.cfg, opts.signal);
      this.bus.emitEvent('run.verify', { data: { ok: finalVerify.ok, skipped: finalVerify.skipped } });

      reqCheck = await this.requirementCheck(fullTask, plan, integration, finalVerify, reports, opts.signal);
      this.bus.emitEvent('run.requirements', { data: reqCheck });
      if (reqCheck.complete && (finalVerify.skipped || finalVerify.ok)) break;

      // follow-up work for the next iteration
      const followups: SubTask[] = reqCheck.missing.map((m, i) => ({
        id: `F${iteration}.${i + 1}`,
        title: m.slice(0, 80),
        description: `Previous work is already applied. Complete this missing requirement:\n${m}`,
        files: [],
        dependsOn: [],
        critical: false,
      }));
      if (!finalVerify.skipped && !finalVerify.ok) {
        followups.unshift({
          id: `V${iteration}`,
          title: 'Derleme/test hatalarını düzelt',
          description: `The combined changes fail verification. Fix the failures without reverting the intended functionality:\n${verifyFailureText(finalVerify)}`,
          files: [],
          dependsOn: [],
          critical: true,
        });
      }
      // merge follow-ups touching the same concern into a single task when there are many
      queue = followups.length > 3 ? [{ ...followups[0], id: `F${iteration}`, title: 'Eksikleri tamamla', description: followups.map((f) => `- ${f.description}`).join('\n'), critical: true }] : followups;
    }

    // ---- 3. merge into the project
    const changedFiles = integration.changedFiles();
    const diff = integration.diff();
    const diffPath = join(this.sessionDir, 'changes.diff');
    writeFileSync(diffPath, diff);
    let merge: MergeReport | undefined;
    let status: RunReport['status'] = reqCheck?.complete && (!finalVerify || finalVerify.skipped || finalVerify.ok) ? 'completed' : changedFiles.length ? 'incomplete' : 'failed';
    if (opts.dryRun) status = 'dry-run';
    else if (changedFiles.length) {
      let go = true;
      if (this.cfg.orchestrator.confirmMerge && opts.confirm) {
        const st = diffStat(diff);
        go = await opts.confirm(`${changedFiles.length} dosya, +${st.added}/-${st.removed} satır. Projeye uygulansın mı?`);
      }
      if (go) {
        merge = await this.materializer.merge(integration, opts.signal);
        this.bus.emitEvent('run.merge', { data: { ...merge } });
      } else status = 'dry-run';
    }

    const report: RunReport = {
      sessionId,
      sessionDir: this.sessionDir,
      task,
      mode,
      plan,
      subtasks: reports,
      finalVerify,
      requirementCheck: reqCheck,
      merge,
      changedFiles,
      diffPath,
      reportPath: join(this.sessionDir, 'REPORT.md'),
      iterations: iteration,
      status,
      modelsUsed: [...this.used],
      skills: { available: this.skills.size, used: [...this.skillUsage], diagnostics: this.skills.diagnostics },
    };
    this.persist(sessionId, task, plan, integration, reports);
    writeFileSync(report.reportPath, renderReport(report, diff));
    this.bus.emitEvent('run.end', { data: { status, files: changedFiles.length } });
    return report;
  }

  /** Run subtasks respecting depends_on; independent ones run concurrently. */
  private async executeDag(tasks: SubTask[], integration: Overlay, mode: RunMode, plan: Plan, fullTask: string, iteration: number, reports: SubtaskReport[], signal?: AbortSignal): Promise<void> {
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
          continue;
        }
        if (!deps.every((d) => done.has(d))) continue;
        pending.delete(id);
        const p = this.runSubtask(t, integration, mode, plan, fullTask, iteration, signal)
          .then((r) => {
            reports.push(r);
            (r.status === 'done' ? done : failed).add(id);
          })
          .catch((e) => {
            failed.add(id);
            reports.push({ subtask: t, iteration, candidates: [], fixes: 0, status: 'failed' });
            this.bus.error('orchestrator', `${id} hata: ${errorMessage(e)}`);
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
Only implement YOUR subtask; other engineers handle the rest in parallel.`;
  }

  private async runSubtask(st: SubTask, integration: Overlay, mode: RunMode, plan: Plan, fullTask: string, iteration: number, signal?: AbortSignal): Promise<SubtaskReport> {
    const width = this.widthFor(mode, st);
    const models = this.router.pick('coder', width);
    const context = this.buildContext(`${st.title}\n${st.description}`, st.files);
    const workerSkills = this.skillsFor(st, fullTask);
    const report: SubtaskReport = { subtask: st, iteration, candidates: [], fixes: 0, status: 'failed' };
    this.bus.emitEvent('subtask.start', { source: st.id, data: { title: st.title, models: models.map((m) => m.caps.key) } });

    const launch = (modelKeys: string[], suffix: string) =>
      settle(
        modelKeys.map(async (mk, i) => {
          const overlay = integration.fork(`${st.id}${suffix}-${i + 1}`);
          const w = new AgentWorker(
            { id: overlay.id, task: this.workerTask(st, plan, fullTask), acceptance: plan.acceptance, context, model: mk, overlay, skills: workerSkills },
            this.router,
            this.cfg,
            { index: this.index, materializer: this.materializer, root: this.root, bus: this.bus, signal },
          );
          const result = await w.run();
          result.models.forEach((m) => this.used.add(m));
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
      return { id: r.overlay.id, author: r.result.models[0] ?? '', diff: r.overlay.diffAgainstParent(), summary: r.result.summary, verifyScore: v.skipped ? undefined : v.score, verifyOk: v.skipped ? undefined : v.ok };
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
          contextTokens: this.contextBudget(0.5),
          bus: this.bus,
          signal,
        });
        verdict.reviews.forEach((r) => this.used.add(r.reviewer));
        if (verdict.winner) winner = usable.find((u) => u.overlay.id === verdict!.winner!.id) ?? winner;
        report.verdict = { ranking: verdict.ranking, winnerIssues: verdict.winnerIssues };
      } catch (e) {
        this.bus.warn(st.id, `konsey incelemesi başarısız: ${errorMessage(e)}`);
      }
    } else if (usable.length > 1) {
      winner = [...usable].sort((a, b) => (verifies.get(b.overlay.id)?.score ?? 0) - (verifies.get(a.overlay.id)?.score ?? 0))[0];
    }
    this.bus.emitEvent('subtask.winner', { source: st.id, data: { worker: winner.overlay.id, models: winner.result.models } });

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
          context,
          model: winner.result.models[0] ?? models[0]?.caps.key ?? '',
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
      this.recordSkills(fixOverlay.id, fr, workerSkills.reasons);
      report.fixes++;
      if (fixOverlay.ownChanges().length === 0) break;
      const fv = await verifyOverlay(fixOverlay, this.materializer, this.cfg, signal);
      if (fv.skipped || fv.score >= wv.score) {
        winner.overlay.absorb(fixOverlay);
        wv = fv;
        blocking = []; // addressed (re-review would cost another council round)
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
    const budget = this.contextBudget(0.55);
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
    const judges = this.router.pick('judge', Math.min(2, this.router.size));
    const res = await settle(judges.map((j) => this.router.chat({ messages: [{ role: 'user', content: prompt }], temperature: 0, jsonMode: true, maxTokens: 1500, purpose: 'requirements', signal }, { prefer: [j.caps.key], role: 'judge' })));
    const verdicts = res.filter((r): r is { ok: true; value: Awaited<ReturnType<Router['chat']>> } => r.ok).map((r) => ({ model: r.value.model, j: tryExtractJson<{ complete?: boolean; missing?: string[] }>(r.value.content) }));
    verdicts.forEach((v) => this.used.add(v.model));
    const valid = verdicts.filter((v) => v.j);
    if (!valid.length) return { complete: true, missing: [], judges: [] }; // cannot judge → rely on verification
    const complete = valid.every((v) => v.j!.complete === true);
    const missing = [...new Set(valid.flatMap((v) => (v.j!.missing ?? []).filter((m) => typeof m === 'string' && m.trim())))].slice(0, 8);
    return { complete: complete || missing.length === 0, missing: complete ? [] : missing, judges: valid.map((v) => v.model) };
  }

  private persist(sessionId: string, task: string, plan: Plan, integration: Overlay, reports: SubtaskReport[]): void {
    writeFileSync(
      join(this.sessionDir, 'session.json'),
      JSON.stringify({ sessionId, task, plan, overlay: integration.toJSON(), reports, savedAt: new Date().toISOString() }, null, 1),
    );
  }
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
    if (s.verdict?.ranking.length) lines.push('', `Konsey sıralaması: ${s.verdict.ranking.map((x) => `${x.id} (${x.points})`).join(' > ')}`);
    if (s.verdict?.winnerIssues.length) lines.push('', 'İnceleme bulguları:', ...s.verdict.winnerIssues.map((i) => `- ${i.blocking ? '**[engelleyici]** ' : ''}${i.text} — _${i.reviewer}_`));
    if (s.fixes) lines.push('', `Düzeltme turu: ${s.fixes}`);
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
  lines.push('## Değişiklikler', '', `Tam diff: \`${r.diffPath}\``, '');
  return lines.join('\n');
}
