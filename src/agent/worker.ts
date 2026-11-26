import type { KurultayConfig } from '../config.js';
import type { ProjectIndex } from '../index/project-index.js';
import type { ModelHandle, Router } from '../llm/router.js';
import { LlmError, type ChatMessage, type ChatRequest, type ChatResult, type ToolSpec } from '../llm/types.js';
import { SkillRegistry, type Skill } from '../skills/skills.js';
import { errorMessage } from '../util/async.js';
import type { EventBus } from '../util/events.js';
import { estimateTokens, truncateMiddle, tryExtractJson } from '../util/text.js';
import { LoopGuard } from './loop-guard.js';
import { normalizeModelId } from '../llm/known-windows.js';
import { TOOLSHIM_SCHEMA } from '../llm/schemas.js';
import { parseTextToolCalls, textToolInstructions, type ParsedCall } from './text-tools.js';
import type { ExternalTools } from '../mcp/manager.js';
import { executeTool, renderTodos, toolTokens, toolCatalogue, toolSpecs, type ToolContext } from './tools.js';
import type { Materializer, Overlay } from './workspace.js';
import type { Inbox, WorkSnapshot } from './inbox.js';

export interface WorkerSkills {
  registry: SkillRegistry;
  /** loaded into the context up front */
  preload: Skill[];
  /** named as recommended in the catalogue */
  recommended?: string[];
  /** hidden skills the user selected explicitly */
  explicit?: Set<string>;
  /** files the task is about (conditional skills) */
  files?: string[];
}

export interface WorkerSpec {
  id: string;
  task: string;
  /** acceptance criteria the result must satisfy */
  acceptance?: string[];
  /** project/background context: architecture excerpt, repo map, rules */
  context: string;
  /** context that is still being prepared (localisation running alongside): added to the conversation once it is there */
  lateHint?: Promise<string | undefined>;
  /** preferred model key (others are used only on failure) */
  model: string;
  overlay: Overlay;
  readOnly?: boolean;
  maxSteps?: number;
  /** extra system instructions (role specific) */
  roleInstructions?: string;
  skills?: WorkerSkills;
  /** sampling temperature for models without a publisher preset (default 0.2) */
  temperature?: number;
}

export interface WorkerResult {
  id: string;
  status: 'done' | 'blocked' | 'max_steps' | 'failed';
  summary: string;
  models: string[];
  steps: number;
  changedFiles: string[];
  error?: string;
  /** last assistant text (useful for read-only analysts) */
  finalText: string;
  tokens: { in: number; out: number };
  /** skills used by this worker and how they were loaded */
  skills: Array<{ name: string; how: 'preload' | 'tool' }>;
  /** guard interventions (loop warnings, toolshim, condense, failover) */
  interventions: string[];
  /** model switches during the run: the failed model is never used again by this worker */
  failovers: Array<{ from: string; to: string; step: number; reason: string }>;
  /** model the worker ended on (after failovers) */
  finalModel: string;
  /** the conversation as the model saw it last (for fine-tuning data) */
  transcript?: ChatMessage[];
  /** tool specs offered to the model (for fine-tuning data) */
  toolSpecs?: ToolSpec[];
}

const BASE_SYSTEM = `You are a senior software engineer working autonomously inside an existing codebase, as one member of a team of AI models (a "kurultay").
Principles:
- Investigate before editing: use search/read tools; never guess file contents or APIs. Read a file before you edit it.
- Make the smallest correct change that fully solves the task; follow existing style and project rules.
- Keep the build green: after editing, run the project's build/test commands when available and fix what you broke.
- Never touch files unrelated to the task. Never run destructive or networked commands.
- When the task defines a value only in words (a count, a size, an index, an offset, what a getter returns), choose its most natural reading and pin that reading in a test with concrete numbers (e.g. size() after 3 pushes and 1 pop is 2); say in a comment which reading you chose.
- A todo list holds the task's requirements (todo_write): mark an item completed only when it is implemented and covered by a test or a check you ran; you cannot finish while items are open. Update it in the same step as your other tool calls.
- Work in few steps: every step is a full round-trip to the model. Call independent tools together in ONE step (read all the files you need at once, search several terms at once); only chain calls that depend on each other.
- Communicate only through tool calls; when finished call finish with a short summary (what changed, how verified).`;

/** families whose reasoning is sent back with their tool calls */
const REASONING_ROUND_TRIP = /^(?:kimi-|k3[.-]|deepseek|glm-|minimax-)/;

const READ_ONLY_TOOLS = ['read_file', 'list_dir', 'search_code', 'grep', 'find_symbol', 'repo_map', 'skill', 'skill_file', 'finish'];

/** Structured hand-off summary (Pi compaction + Codex checkpoint), updated incrementally. */
const CONDENSE_PROMPT = `You are compacting the work log of an autonomous coding agent so it can continue with a smaller context.
Write a structured hand-off summary in Markdown with EXACTLY these sections:
## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Files (read / modified)
## Next Steps
## Critical Context
Rules: keep exact file paths, function names, error messages and commands that still matter; drop raw tool output; be concise.`;

export class AgentWorker {
  private messages: ChatMessage[] = [];
  private usedModels = new Set<string>();
  private nativeTools: boolean;
  /** model this worker currently talks to (changes on failover) */
  private currentModel: string;
  /** models that failed for this worker – never preferred again (sticky failover) */
  private readonly failedModels = new Set<string>();
  private readonly failovers: WorkerResult['failovers'] = [];
  private step = 0;
  /** send reasoning_content back (off once a server rejects it) */
  private keepReasoning = true;
  /** times the window was lowered after a context-length error */
  private shrinks = 0;
  /** localisation that arrived while the worker was already running */
  private lateHint: string | undefined;
  private lateHintGiven = false;
  /** how long this worker's model took per step (for the hedge delay) */
  private readonly stepMs: number[] = [];
  /** hedged steps in a row the backup answered first */
  private hedgeWins = 0;
  private readonly toolCtx: ToolContext;
  private tokens = { in: 0, out: 0 };
  private readonly guard: LoopGuard;
  private readonly skillLog: Array<{ name: string; how: 'preload' | 'tool' }> = [];
  private readonly interventions: string[] = [];
  /** conditional skills already advertised */
  private advertised = new Set<string>();
  private previousSummary = '';
  private readonly touched = { read: new Set<string>(), modified: new Set<string>() };
  private readonly staleFiles = new Set<string>();
  /** messages for the run that came while it was going (Jira: the issue changed) */
  private readonly inbox?: Inbox;
  private inboxCursor = 0;
  private readonly onCheckpoint?: (s: WorkSnapshot) => void;

  constructor(
    private readonly spec: WorkerSpec,
    private readonly router: Router,
    private readonly cfg: KurultayConfig,
    deps: { index?: ProjectIndex; materializer: Materializer; root: string; bus?: EventBus; signal?: AbortSignal; external?: ExternalTools; inbox?: Inbox; onCheckpoint?: (s: WorkSnapshot) => void },
    private readonly bus = deps.bus,
    private readonly signal = deps.signal,
  ) {
    this.inbox = deps.inbox;
    this.onCheckpoint = deps.onCheckpoint;
    void spec.lateHint?.then((h) => {
      if (h) this.lateHint = h;
    });
    const handle = router.get(spec.model);
    this.currentModel = spec.model;
    this.nativeTools = handle?.caps.nativeTools ?? true;
    const allowed = spec.readOnly ? new Set(READ_ONLY_TOOLS) : undefined;
    const loaded = new Set<string>();
    this.toolCtx = {
      workerId: spec.id,
      root: deps.root,
      overlay: spec.overlay,
      index: deps.index,
      materializer: deps.materializer,
      config: cfg,
      bus: deps.bus,
      signal: deps.signal,
      allowed,
      skills: spec.skills?.registry,
      explicitSkills: spec.skills?.explicit,
      loadedSkills: loaded,
      contextWindow: router.get(spec.model)?.caps.contextWindow,
      readFiles: this.touched.read,
      writtenFiles: this.touched.modified,
      staleFiles: this.staleFiles,
      external: deps.external,
      readCache: new Map(),
      // the acceptance criteria are the checklist (Qwen Code todo_write); one-rule tasks need none
      todos: (spec.acceptance?.length ?? 0) >= 3 && !spec.readOnly ? spec.acceptance!.map((c, i) => ({ id: String(i + 1), content: c, status: 'pending' as const })) : undefined,
    };
    this.applyEditFormat();
    this.guard = new LoopGuard({ maxConsecutiveErrors: cfg.orchestrator.maxConsecutiveErrors ?? 6 });
  }

  /** Edit format measured by the probe for the current model (aider: the format can matter more than the model). */
  private editFormat(): 'tool' | 'search_replace' | 'whole' {
    return this.cfg.tools.editFormat ?? this.handle()?.caps.editFormat ?? 'tool';
  }

  private toolOpts(): { skills: boolean; external?: ExternalTools; hidden?: Set<string>; mcpBudget?: number } {
    return { skills: this.hasSkills, external: this.toolCtx.external, hidden: this.toolCtx.hidden, mcpBudget: this.cfg.tools.mcpToolBudgetTokens };
  }

  /** Hide edit_file for models that edit whole files; re-evaluated after a failover. */
  private applyEditFormat(): void {
    this.toolCtx.hidden = this.editFormat() === 'whole' && !this.spec.readOnly ? new Set(['edit_file']) : undefined;
  }

  private get hasSkills(): boolean {
    const s = this.spec.skills;
    return !!s && (s.registry.visible().length > 0 || (s.explicit?.size ?? 0) > 0);
  }

  private handle(): ModelHandle | undefined {
    return this.router.get(this.currentModel);
  }

  private contextWindow(): number {
    return this.handle()?.caps.contextWindow ?? 32_768;
  }

  private systemPrompt(): string {
    const verify = [this.cfg.verify.build, this.cfg.verify.test, this.cfg.verify.lint].filter(Boolean);
    const parts = [BASE_SYSTEM];
    if (this.spec.roleInstructions) parts.push(this.spec.roleInstructions);
    if (verify.length) parts.push(`Project verification commands (run them with run_command before finishing):\n${verify.map((v) => `- ${v}`).join('\n')}`);
    const sk = this.spec.skills;
    if (sk && this.hasSkills) {
      const files = sk.files?.length ? sk.files : undefined;
      const cat = sk.registry.catalogue({ files, exclude: sk.preload.map((s) => s.name), recommended: sk.recommended });
      if (cat) parts.push(cat);
      for (const s of sk.registry.visible()) if (!files || SkillRegistry.matchesFiles(s, files)) this.advertised.add(s.name);
    }
    const fmt = this.editFormat();
    if (fmt === 'whole' && !this.spec.readOnly) parts.push('Editing: rewrite files completely with write_file – read the file, then write every line of the new version. Do not send partial snippets.');
    if (!this.nativeTools) parts.push(textToolInstructions(toolCatalogue(this.toolCtx.allowed, this.toolOpts()), { searchReplace: fmt !== 'whole' }));
    return parts.join('\n\n');
  }

  private firstUserMessage(): string {
    const acc = this.toolCtx.todos?.length
      ? `\n\nAcceptance criteria – your todo list (todo_write to update it):\n${renderTodos(this.toolCtx.todos)}`
      : this.spec.acceptance?.length
        ? `\n\nAcceptance criteria:\n${this.spec.acceptance.map((a) => `- ${a}`).join('\n')}`
        : '';
    let skills = '';
    const sk = this.spec.skills;
    if (sk?.preload.length) {
      const budget = Math.max(800, Math.floor(this.contextWindow() * 0.15 / sk.preload.length));
      skills = `\n\n# ACTIVE SKILLS (follow these procedures)\n${sk.preload
        .map((s) => {
          this.toolCtx.loadedSkills?.add(s.name);
          this.skillLog.push({ name: s.name, how: 'preload' });
          this.bus?.emitEvent('skill.load', { source: this.spec.id, data: { name: s.name, how: 'preload' } });
          return sk.registry.render(s, undefined, budget);
        })
        .join('\n\n')}`;
    }
    return `${this.spec.context}${skills}\n\n# TASK\n${this.spec.task}${acc}`;
  }

  /** Conditional skills (paths:) become visible once the worker touches a matching file (Qwen Code). */
  private newlyRelevantSkills(path: string | undefined): string {
    const sk = this.spec.skills;
    if (!sk || !path) return '';
    const fresh = sk.registry.visible().filter((s) => s.paths.length && !this.advertised.has(s.name) && !this.toolCtx.loadedSkills?.has(s.name) && SkillRegistry.matchesFiles(s, [path]));
    if (!fresh.length) return '';
    fresh.forEach((s) => this.advertised.add(s.name));
    return `\n[Kurultay] Skills for ${path} are available: ${fresh.map((s) => `${s.name} – ${s.description}`).join('; ')}. Load one with the skill tool if needed.`;
  }

  /**
   * Context ladder (Qwen Code / Claude Code auto-compaction, Pi/Codex hand-off summary):
   *  1. above `microcompactAt` of the usable window: clear old tool outputs, oldest first,
   *     keeping the last turns – cheap, no model call;
   *  2. above `compactAt`: replace the middle of the conversation with a structured summary;
   *  3. still over the window: summarise again keeping fewer recent turns.
   * Cleared outputs are forgotten by the read cache, so a re-read returns the content again.
   */
  private async condense(): Promise<void> {
    const window = this.contextWindow();
    const reserve = Math.max(1024, Math.min(16_384, Math.floor(window * 0.3)));
    const usable = window - reserve;
    const llm = this.cfg.llm ?? {};
    const microAt = usable * (llm.microcompactAt ?? 0.6);
    const autoAt = usable * (llm.compactAt ?? 0.85);
    const size = () => estimateTokens(this.messages.map((m) => (m.content ?? '') + JSON.stringify(m.tool_calls ?? '') + (m.reasoning_content ?? '')).join('\n'));
    if (size() <= microAt) return;
    // 1) microcompaction: shrink to well below the mark so it does not run on every step
    const keepTail = 8;
    let cleared = 0;
    for (let i = 2; i < this.messages.length - keepTail && size() > microAt * 0.8; i++) {
      const m = this.messages[i];
      if (m.reasoning_content) delete m.reasoning_content;
      if ((m.role === 'tool' || (m.role === 'user' && m.content?.startsWith('<tool_result'))) && (m.content?.length ?? 0) > 400 && !m.content!.includes('[old tool output cleared')) {
        const first = m.content!.replace(/^<tool_result[^>]*>\n?/, '').split('\n')[0].slice(0, 160);
        m.content = `${m.content!.startsWith('<tool_result') ? m.content!.match(/^<tool_result[^>]*>/)![0] + '\n' : ''}${first}\n[old tool output cleared to save context – run the tool again if you still need it]`;
        cleared++;
      }
    }
    if (cleared) {
      this.toolCtx.readCache?.clear();
      this.interventions.push('microcompact');
      this.bus?.debug(this.spec.id, `cleared ${cleared} old tool outputs (context above ${Math.round((llm.microcompactAt ?? 0.6) * 100)}%)`);
    }
    if (size() <= autoAt) return;
    await this.summarize(keepTail);
    if (size() > usable) await this.summarize(3);
  }

  /** Replace the middle of the conversation with a hand-off summary, keeping the last `keepTail` messages. */
  private async summarize(keepTail: number): Promise<void> {
    if (this.messages.length <= keepTail + 3) return;
    let cut = this.messages.length - keepTail;
    while (cut < this.messages.length && this.messages[cut].role === 'tool') cut++;
    const middle = this.messages.slice(2, cut).filter((m) => !(m.role === 'user' && m.content?.startsWith('<progress_notes>')));
    const transcript = middle.map((m) => `${m.role}: ${(m.content ?? '').slice(0, 1500)}${m.tool_calls ? ' ' + JSON.stringify(m.tool_calls).slice(0, 600) : ''}`).join('\n');
    const files = `Files read: ${[...this.touched.read].join(', ') || '-'}\nFiles modified: ${[...this.touched.modified].join(', ') || '-'}`;
    let notes = '';
    try {
      const r = await this.router.chat(
        {
          messages: [
            { role: 'system', content: CONDENSE_PROMPT },
            {
              role: 'user',
              content: `${this.previousSummary ? `<previous-summary>\n${this.previousSummary}\n</previous-summary>\nUpdate it with the new log below (move finished items to Done).\n\n` : ''}# TASK\n${this.spec.task.slice(0, 2000)}\n\n${files}\n\n# WORK LOG\n${truncateMiddle(transcript, 40_000)}`,
            },
          ],
          maxTokens: 1500,
          temperature: 0,
          purpose: 'condense',
          signal: this.signal,
        },
        { role: 'fast' },
      );
      notes = r.content;
    } catch {
      notes = `${files}\n\n${transcript.slice(-4000)}`;
    }
    this.previousSummary = notes;
    const todos = this.toolCtx.todos?.length ? `\n\n${renderTodos(this.toolCtx.todos)}` : '';
    this.messages = [this.messages[0], this.messages[1], { role: 'user', content: `<progress_notes>\n${notes}\n</progress_notes>${todos}\nContinue the task from these notes.` }, ...this.messages.slice(cut)];
    while (this.messages[3]?.role === 'tool') this.messages.splice(3, 1);
    this.toolCtx.readCache?.clear();
    this.interventions.push('condense');
    this.bus?.info(this.spec.id, 'context compacted');
  }

  private async callModel(): Promise<ChatResult> {
    const req = () => {
      const tools = this.nativeTools ? toolSpecs(this.toolCtx.allowed, this.toolOpts()) : undefined;
      return {
      messages: this.messages,
      tools,
      // what the prompt is made of, for the report (Qwen Code: measure before trimming)
      promptParts: {
        system: estimateTokens(this.messages[0]?.content ?? ''),
        tools: tools ? toolTokens(tools) : 0,
        task: estimateTokens(this.messages[1]?.content ?? ''),
        history: estimateTokens(this.messages.slice(2).map((m) => (m.content ?? '') + (m.tool_calls ? JSON.stringify(m.tool_calls) : '')).join('\n')),
      },
      temperature: this.spec.temperature ?? 0.2,
      agentic: true,
      purpose: `worker:${this.spec.id}`,
      signal: this.signal,
      onToken: (t: string) => this.bus?.emitEvent('worker.token', { source: this.spec.id, data: { t } }),
      };
    };
    const toolsRejected = (e: unknown) => this.nativeTools && e instanceof LlmError && e.kind === 'bad_request' && /tool|function/i.test(e.message);

    if (this.cfg.llm?.stickyFailover === false) {
      // legacy behaviour: the router may answer from another model; the next step starts from the preferred one again
      try {
        return await this.router.chat(req(), { prefer: [this.currentModel], role: 'coder', fallback: true });
      } catch (e) {
        if (!toolsRejected(e)) throw e;
        this.bus?.warn(this.spec.id, 'native tool calling rejected; switching to prompt-based tool calls');
        this.switchToTextTools();
        return this.router.chat(req(), { prefer: [this.currentModel], role: 'coder', fallback: true });
      }
    }

    // Sticky failover: talk to ONE model. If it fails (timeout, crash, quarantine), pick a replacement,
    // adapt the transcript to it, and continue the task there – never bouncing back to the failed model.
    for (;;) {
      try {
        return await this.hedged(req);
      } catch (e) {
        if (e instanceof LlmError && e.kind === 'aborted') throw e;
        if (await this.adaptTo(e)) continue;
        if (toolsRejected(e)) {
          this.bus?.warn(this.spec.id, 'native tool calling rejected; switching to prompt-based tool calls');
          this.switchToTextTools();
          continue;
        }
        const failed = this.currentModel;
        this.failedModels.add(failed);
        const next = this.replacementModel();
        if (next) {
          this.switchModel(next, errorMessage(e));
          continue;
        }
        // nothing healthy left: let the router try everyone (earlier failures first) and wait for recovery
        this.bus?.warn(this.spec.id, `no backup model left; retrying the models that failed earlier (${[...this.failedModels].join(', ')})`);
        const r = await this.router.chat(req(), { prefer: [...this.failedModels], role: 'coder', fallback: true });
        if (r.model !== this.currentModel) this.switchModel(r.model, errorMessage(e));
        this.failedModels.delete(r.model);
        return r;
      }
    }
  }

  /**
   * Hedged request (The Tail at Scale): when the current model takes much longer than its own
   * usual step – a free tier queues it, a server stalls – the same request also goes to the
   * best other coder and the first answer wins; the slower one is cancelled. The worker stays
   * on its model for the next step. Costs a few percent more requests, cuts the long tail.
   */
  private async hedged(req: () => ChatRequest): Promise<ChatResult> {
    const only = (model: string, signal: AbortSignal | undefined) => this.router.chat({ ...req(), signal }, { only: [model], fallback: false, role: 'coder', recoveryWaitMs: 0 });
    const after = this.hedgeAfterMs();
    const backup = after > 0 ? this.hedgeModel() : undefined;
    const t0 = Date.now();
    if (!backup) {
      const r = await only(this.currentModel, this.signal);
      this.stepMs.push(Date.now() - t0);
      return r;
    }
    const main = new AbortController();
    const spare = new AbortController();
    const link = (c: AbortController) => {
      const on = () => c.abort(this.signal?.reason);
      this.signal?.addEventListener('abort', on, { once: true });
      return () => this.signal?.removeEventListener('abort', on);
    };
    const unlinkA = link(main);
    const unlinkB = link(spare);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<ChatResult>((resolve, reject) => {
        let settled = false;
        let mainFailed: unknown;
        let spareFailed: unknown;
        let spareStarted = false;
        const finish = (r: ChatResult, which: 'main' | 'spare') => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          (which === 'main' ? spare : main).abort(new Error('the other request answered first'));
          if (which === 'main') {
            this.stepMs.push(Date.now() - t0);
            this.hedgeWins = 0;
          } else {
            this.interventions.push(`hedge:${backup}`);
            this.bus?.info(this.spec.id, `${this.currentModel} took over ${Math.round(after / 1000)} s; ${backup} answered first`);
            // twice in a row: the model has stopped answering in time – continue on the backup
            if (++this.hedgeWins >= 2) {
              const stalled = this.currentModel;
              this.failedModels.add(stalled);
              this.router.markStalled(stalled);
              this.switchModel(backup, `no answer within ${Math.round(after / 1000)} s twice in a row`);
              this.hedgeWins = 0;
            }
          }
          resolve(r);
        };
        const giveUp = (e: unknown) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          spare.abort(new Error('stopped'));
          reject(e);
        };
        only(this.currentModel, main.signal).then(
          (r) => finish(r, 'main'),
          (e) => {
            mainFailed = e ?? new Error('failed');
            // before the hedge started, or with the hedge failed too: the usual failover takes over
            if (!spareStarted || spareFailed) giveUp(e);
          },
        );
        timer = setTimeout(() => {
          timer = undefined;
          if (settled) return;
          spareStarted = true;
          this.bus?.emitEvent('worker.hedge', { source: this.spec.id, data: { model: this.currentModel, backup, afterMs: after } });
          only(backup, spare.signal).then(
            (r) => finish(r, 'spare'),
            (e) => {
              spareFailed = e ?? new Error('failed');
              if (mainFailed) giveUp(mainFailed);
            },
          );
        }, after);
      });
    } finally {
      if (timer) clearTimeout(timer);
      unlinkA();
      unlinkB();
    }
  }

  /** Hedge delay: 2.5× the median of this model's last steps, at least llm.hedgeMinMs (30 s); 0 = off. */
  private hedgeAfterMs(): number {
    const llm = this.cfg.llm ?? {};
    if (llm.hedge === false) return 0;
    const last = this.stepMs.slice(-5).sort((a, b) => a - b);
    const median = last.length ? last[Math.floor(last.length / 2)] : 0;
    return Math.max(llm.hedgeMinMs ?? 30_000, median ? 2.5 * median : 120_000);
  }

  /** Best other coder that can take the same transcript (same tool format, large enough window). */
  private hedgeModel(): string | undefined {
    const need = estimateTokens(this.messages.map((m) => (m.content ?? '') + (m.tool_calls ? JSON.stringify(m.tool_calls) : '')).join('\n')) + 1024;
    const native = this.nativeTools;
    return this.router
      .rank('coder', { exclude: [this.currentModel, ...this.failedModels], minContext: need })
      // a backup much slower than the model it stands in for never wins the race – only costs requests
      .find((h) => this.router.allows(h, 'coder') && h.caps.nativeTools === native && this.router.inSpeedBand(h, 'coder'))?.caps.key;
  }

  /** A late hint that arrived since the last step goes into the conversation (once). */
  private addLateHint(): void {
    if (!this.lateHint || this.lateHintGiven) return;
    this.lateHintGiven = true;
    const text = `[Kurultay] A parallel localisation finished – the code most likely involved (use it, skip what you already read):\n${this.lateHint}`;
    const last = this.messages[this.messages.length - 1];
    if (last?.role === 'user') last.content = `${last.content ?? ''}\n\n${text}`;
    else this.messages.push({ role: 'user', content: text });
    this.interventions.push('late-hint');
    this.bus?.emitEvent('worker.hint', { source: this.spec.id, data: { chars: this.lateHint.length } });
  }

  /** Messages that came for the run since the last step: the request changed, follow it from now on. */
  private readInbox(): void {
    if (!this.inbox || this.spec.readOnly) return;
    const { texts, cursor } = this.inbox.take(this.inboxCursor);
    this.inboxCursor = cursor;
    if (!texts.length) return;
    const text = `[Kurultay] The user changed the request while you were working. Follow it from now on – it overrides the earlier text where they differ; keep what you did that still fits, change what does not${this.toolCtx.todos ? ', and update the todo list (todo_write)' : ''}:\n\n${texts.join('\n\n---\n\n')}`;
    const last = this.messages[this.messages.length - 1];
    if (last?.role === 'user') last.content = `${last.content ?? ''}\n\n${text}`;
    else this.messages.push({ role: 'user', content: text });
    this.interventions.push('inbox');
    this.bus?.emitEvent('worker.inbox', { source: this.spec.id, message: texts[0].split('\n')[0].slice(0, 120), data: { messages: texts.length } });
  }

  /** Save what was done so far (files, todo list, last words) – an interrupted job goes on from here. */
  private checkpoint(step: number, note: string, done = false): void {
    if (!this.onCheckpoint || this.spec.readOnly) return;
    try {
      const o = this.spec.overlay;
      const files: Record<string, string | null> = {};
      for (const p of o.changedFiles()) files[p] = o.peek(p) ?? null;
      this.onCheckpoint({ worker: this.spec.id, step, model: this.currentModel, files, todos: this.toolCtx.todos?.map((t) => ({ content: t.content, status: t.status })), note: note.slice(-2000), done: done || undefined });
    } catch {
      /* a checkpoint never stops the work */
    }
  }

  /**
   * Errors the same model gets past once the request changes: a window smaller than assumed
   * (lower it, compact, ask again) and a server that rejects reasoning_content in the history.
   */
  private async adaptTo(e: unknown): Promise<boolean> {
    if (!(e instanceof LlmError)) return false;
    const h = this.handle();
    if (e.kind === 'context_length' && h && this.shrinks < 2) {
      this.shrinks++;
      const used = estimateTokens(this.messages.map((m) => (m.content ?? '') + (m.tool_calls ? JSON.stringify(m.tool_calls) : '') + (m.reasoning_content ?? '')).join('\n'));
      h.caps.contextWindow = Math.max(8192, Math.min(h.caps.contextWindow, Math.floor(used * 0.75)));
      h.caps.maxOutputTokens = Math.min(h.caps.maxOutputTokens, Math.floor(h.caps.contextWindow / 4));
      this.bus?.warn(this.spec.id, `${h.caps.key}: the prompt did not fit; window lowered to ${h.caps.contextWindow} tokens`);
      await this.condense();
      return true;
    }
    if (e.kind === 'bad_request' && /reasoning/i.test(e.message) && this.messages.some((m) => m.reasoning_content)) {
      for (const m of this.messages) delete m.reasoning_content;
      this.keepReasoning = false;
      this.bus?.info(this.spec.id, 'the server does not accept reasoning_content; not sending it back');
      return true;
    }
    return false;
  }

  /** Best available coder that has not failed for this worker and can hold the transcript. */
  private replacementModel(): string | undefined {
    const need = estimateTokens(this.messages.map((m) => (m.content ?? '') + (m.tool_calls ? JSON.stringify(m.tool_calls) : '')).join('\n')) + 1024;
    const exclude = [...this.failedModels];
    const fits = this.router.rank('coder', { exclude, minContext: need });
    return (fits[0] ?? this.router.rank('coder', { exclude })[0])?.caps.key;
  }

  /** Continue the task on another model (Codex/OMO style session failover). */
  private switchModel(to: string, reason: string): void {
    const from = this.currentModel;
    this.currentModel = to;
    this.applyEditFormat();
    this.failovers.push({ from, to, step: this.step, reason: reason.slice(0, 200) });
    this.interventions.push(`failover:${from}->${to}`);
    this.bus?.emitEvent('worker.failover', { source: this.spec.id, message: `${from} → ${to}`, data: { from, to, reason } });
    this.bus?.warn(this.spec.id, `${from} stopped answering (${reason.slice(0, 120)}); continuing on ${to}, ${from} is not used again for this subtask`);
    // the new model may not support native tool calling: move the transcript to the text protocol first
    if (this.nativeTools && this.router.get(to)?.caps.nativeTools === false) this.switchToTextTools();
  }

  /** Rewrite native tool-call history as <tool_call>/<tool_result> text so any model can continue it. */
  private switchToTextTools(): void {
    this.nativeTools = false;
    this.messages = toTextProtocol(this.messages);
    this.messages[0] = { role: 'system', content: this.systemPrompt() };
  }

  /**
   * Goose-style toolshim: when a model answers in prose (no parseable tool call),
   * ask another model to extract the intended tool calls from that text.
   */
  private async toolshim(text: string): Promise<ParsedCall[]> {
    if (!text.trim() || text.length > 20_000) return [];
    const names = toolSpecs(this.toolCtx.allowed, this.toolOpts()).map((t) => t.function.name);
    // only worth a model call when the prose looks like an attempted tool call
    if (!names.some((n) => text.includes(n)) && !/[{`]/.test(text)) return [];
    try {
      const r = await this.router.chat(
        {
          messages: [
            {
              role: 'user',
              content: `An AI coding agent replied with plain text instead of a tool call. Extract the tool call(s) it intends to make, using ONLY these tools:\n${toolCatalogue(this.toolCtx.allowed, this.toolOpts())}\n\nReturn ONLY JSON: {"calls":[{"name":"...","arguments":{...}}]} – return {"calls":[]} if the text does not clearly intend a tool action (e.g. it only asks a question or says it is done without calling finish).\n\nAgent text:\n${text}`,
            },
          ],
          temperature: 0,
          jsonMode: true,
          jsonSchema: TOOLSHIM_SCHEMA,
          maxTokens: 1500,
          purpose: 'toolshim',
          signal: this.signal,
        },
        { role: 'fast' },
      );
      const j = tryExtractJson<{ calls?: Array<{ name?: string; arguments?: Record<string, unknown> }> }>(r.content);
      const allowed = new Set(names);
      return (j?.calls ?? []).filter((c) => c.name && allowed.has(c.name)).map((c) => ({ name: c.name!, arguments: c.arguments ?? {} }));
    } catch {
      return [];
    }
  }

  async run(): Promise<WorkerResult> {
    const maxSteps = this.spec.maxSteps ?? this.cfg.orchestrator.maxStepsPerWorker;
    this.messages = [
      { role: 'system', content: this.systemPrompt() },
      { role: 'user', content: this.firstUserMessage() },
    ];
    let idle = 0;
    let finalText = '';
    this.bus?.emitEvent('worker.start', { source: this.spec.id, data: { model: this.spec.model, task: this.spec.task.slice(0, 200), skills: this.spec.skills?.preload.map((s) => s.name) ?? [] } });

    for (let step = 1; step <= maxSteps; step++) {
      this.step = step;
      this.toolCtx.step = step;
      if (this.signal?.aborted) return this.result('failed', 'cancelled', step, finalText, 'aborted');
      this.addLateHint();
      this.readInbox();
      await this.condense();
      let r: ChatResult;
      try {
        r = await this.callModel();
      } catch (e) {
        return this.result('failed', `model error: ${errorMessage(e)}`, step, finalText, errorMessage(e));
      }
      this.usedModels.add(r.model);
      this.tokens.in += r.usage.promptTokens;
      this.tokens.out += r.usage.completionTokens;
      if (r.content) finalText = r.content;
      const answeringNative = this.router.get(r.model)?.caps.nativeTools ?? this.nativeTools;
      const useNative = this.nativeTools && answeringNative && r.toolCalls.length > 0;

      let calls = useNative
        ? r.toolCalls.map((tc) => ({ id: tc.id, name: tc.function.name, args: (tryExtractJson<Record<string, unknown>>(tc.function.arguments) ?? {}) as Record<string, unknown> }))
        : parseTextToolCalls(r.content).map((c, i) => ({ id: `t${step}_${i}`, name: c.name, args: c.arguments }));

      if (!calls.length && r.content.trim()) {
        this.issue(r.model, 'no_tool_call');
        const shim = await this.toolshim(r.content);
        if (shim.length) {
          calls = shim.map((c, i) => ({ id: `s${step}_${i}`, name: c.name, args: c.arguments }));
          this.interventions.push('toolshim');
          this.bus?.emitEvent('worker.toolshim', { source: this.spec.id, data: { tools: shim.map((c) => c.name) } });
        }
      }

      if (!calls.length) {
        idle++;
        this.messages.push({ role: 'assistant', content: r.content || '(empty reply)' });
        if (idle >= 3) return this.result('failed', 'the model stopped without calling a tool', step, finalText);
        this.messages.push({
          role: 'user',
          content: this.nativeTools
            ? 'You did not call any tool. Continue working using the tools, or call finish if the task is complete.'
            : 'No <tool_call> found. Continue using <tool_call> blocks, or call finish when done.',
        });
        continue;
      }
      idle = 0;

      if (useNative) {
        // Kimi / DeepSeek-style reasoning models expect their reasoning back with the tool calls
        // (Qwen Code sends reasoning_content too); without it they reason from scratch every step
        const reasoning = this.keepReasoning && r.thinking && REASONING_ROUND_TRIP.test(normalizeModelId(r.model.split('@')[0])) ? r.thinking.slice(-6000) : undefined;
        this.messages.push({ role: 'assistant', content: r.content || (reasoning ? '' : null), tool_calls: r.toolCalls, ...(reasoning ? { reasoning_content: reasoning } : {}) });
      }
      else this.messages.push({ role: 'assistant', content: r.content || `(tool calls: ${calls.map((c) => c.name).join(', ')})` });

      const results: string[] = [];
      for (const c of calls) {
        this.bus?.emitEvent('worker.tool', { source: this.spec.id, data: { tool: c.name, args: summarizeArgs(c.args) } });
        const out = await executeTool(c.name, c.args, this.toolCtx);
        if (c.name === 'skill' && !out.isError && typeof c.args.name === 'string' && !this.skillLog.some((x) => x.name === c.args.name)) {
          const s = this.spec.skills?.registry.get(c.args.name);
          if (s) this.skillLog.push({ name: s.name, how: 'tool' });
        }
        if (out.finished) {
          // the request changed while the model was finishing: not done yet, the next step reads the change
          if (out.finished.status === 'done' && this.inbox && !this.spec.readOnly && this.inbox.size > this.inboxCursor) {
            const wait = 'Not finished yet: the user changed the request meanwhile – read the update below and continue.';
            if (useNative) this.messages.push({ role: 'tool', tool_call_id: c.id, content: wait });
            else results.push(`<tool_result name="finish" error="true">\n${wait}\n</tool_result>`);
            // every call of a native step needs its answer
            if (useNative) for (const rest of calls.slice(calls.indexOf(c) + 1)) this.messages.push({ role: 'tool', tool_call_id: rest.id, content: 'not run: the request changed' });
            break;
          }
          if (useNative) this.messages.push({ role: 'tool', tool_call_id: c.id, content: 'ok' });
          return this.result(out.finished.status, out.finished.summary || finalText, step, finalText);
        }
        let text = truncateMiddle(out.output, 16_000);
        text += this.newlyRelevantSkills(typeof c.args.path === 'string' ? c.args.path : undefined);
        if (out.isError) {
          if (c.name === 'edit_file' || c.name === 'write_file') this.issue(r.model, 'edit_failed');
          else if (/^(Unknown tool|Tool error|Tool not allowed)|parameter "/.test(out.output)) this.issue(r.model, 'bad_tool_call');
        }
        const verdict = this.guard.record(c.name, c.args, out.output, !!out.isError);
        if (verdict.action === 'stop') {
          this.interventions.push(`stop:${verdict.kind}`);
          this.bus?.warn(this.spec.id, `worker stopped: ${verdict.message}`);
          this.issue(r.model, 'loop_stop');
          return this.result('failed', `stopped: ${verdict.message}`, step, finalText, verdict.kind);
        }
        if (verdict.action === 'warn') {
          this.interventions.push(`warn:${verdict.kind}`);
          this.bus?.emitEvent('worker.guard', { source: this.spec.id, message: verdict.message, data: { kind: verdict.kind } });
          text += `\n[Kurultay] ${verdict.message}`;
        }
        if (useNative) this.messages.push({ role: 'tool', tool_call_id: c.id, content: text });
        else results.push(`<tool_result name="${c.name}"${out.isError ? ' error="true"' : ''}>\n${text}\n</tool_result>`);
      }
      if (results.length) this.messages.push({ role: 'user', content: results.join('\n') });
      this.checkpoint(step, finalText);
    }
    return this.result('max_steps', `step limit reached (${maxSteps})`, maxSteps, finalText);
  }

  /** Per-model failure counters (/stats, REPORT.md): which models fight the tool interface. */
  private issue(model: string, kind: 'no_tool_call' | 'edit_failed' | 'bad_tool_call' | 'loop_stop'): void {
    this.bus?.emitEvent('worker.issue', { source: model, data: { kind, worker: this.spec.id } });
  }

  private result(status: WorkerResult['status'], summary: string, steps: number, finalText: string, error?: string): WorkerResult {
    this.checkpoint(steps, summary || finalText, status === 'done');
    const res: WorkerResult = {
      id: this.spec.id,
      status,
      summary,
      models: [...this.usedModels],
      steps,
      changedFiles: this.spec.overlay.changedFiles(),
      error,
      finalText,
      tokens: this.tokens,
      skills: [...this.skillLog],
      failovers: [...this.failovers],
      finalModel: this.currentModel,
      interventions: [...this.interventions],
      transcript: this.messages,
      toolSpecs: this.nativeTools ? toolSpecs(this.toolCtx.allowed, this.toolOpts()) : undefined,
    };
    this.bus?.emitEvent('worker.end', { source: this.spec.id, data: { status, steps, files: res.changedFiles.length, models: res.models, skills: res.skills.map((s) => s.name) } });
    return res;
  }
}

function summarizeArgs(a: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) out[k] = typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '…' : v;
  return out;
}

/** Convert an OpenAI native tool-calling transcript into the text tool protocol (Pi transformMessages). */
export function toTextProtocol(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const names = new Map<string, string>();
  let pending: string[] = [];
  const flush = () => {
    if (pending.length) out.push({ role: 'user', content: pending.join('\n') });
    pending = [];
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      const name = names.get(m.tool_call_id ?? '') ?? 'tool';
      pending.push(`<tool_result name="${name}">\n${m.content ?? ''}\n</tool_result>`);
      continue;
    }
    flush();
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const calls = m.tool_calls.map((tc) => {
        names.set(tc.id, tc.function.name);
        let args: unknown = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          args = { raw: tc.function.arguments };
        }
        return `<tool_call>\n${JSON.stringify({ name: tc.function.name, arguments: args })}\n</tool_call>`;
      });
      out.push({ role: 'assistant', content: [m.content, ...calls].filter(Boolean).join('\n') });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  flush();
  return out;
}
