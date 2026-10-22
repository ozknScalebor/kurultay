import type { KurultayConfig } from '../config.js';
import type { ProjectIndex } from '../index/project-index.js';
import type { ModelHandle, Router } from '../llm/router.js';
import { LlmError, type ChatMessage, type ChatResult } from '../llm/types.js';
import { SkillRegistry, type Skill } from '../skills/skills.js';
import { errorMessage } from '../util/async.js';
import type { EventBus } from '../util/events.js';
import { estimateTokens, truncateMiddle, tryExtractJson } from '../util/text.js';
import { LoopGuard } from './loop-guard.js';
import { parseTextToolCalls, textToolInstructions, type ParsedCall } from './text-tools.js';
import { executeTool, toolCatalogue, toolSpecs, type ToolContext } from './tools.js';
import type { Materializer, Overlay } from './workspace.js';

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
  /** preferred model key (others are used only on failure) */
  model: string;
  overlay: Overlay;
  readOnly?: boolean;
  maxSteps?: number;
  /** extra system instructions (role specific) */
  roleInstructions?: string;
  skills?: WorkerSkills;
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
}

const BASE_SYSTEM = `You are a senior software engineer working autonomously inside an existing codebase, as one member of a team of AI models (a "kurultay").
Principles:
- Investigate before editing: use search/read tools; never guess file contents or APIs. Read a file before you edit it.
- Make the smallest correct change that fully solves the task; follow existing style and project rules.
- Keep the build green: after editing, run the project's build/test commands when available and fix what you broke.
- Never touch files unrelated to the task. Never run destructive or networked commands.
- Communicate only through tool calls; when finished call finish with a short summary (what changed, how verified).`;

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

  constructor(
    private readonly spec: WorkerSpec,
    private readonly router: Router,
    private readonly cfg: KurultayConfig,
    deps: { index?: ProjectIndex; materializer: Materializer; root: string; bus?: EventBus; signal?: AbortSignal },
    private readonly bus = deps.bus,
    private readonly signal = deps.signal,
  ) {
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
      readFiles: this.touched.read,
      writtenFiles: this.touched.modified,
      staleFiles: this.staleFiles,
    };
    this.guard = new LoopGuard({ maxConsecutiveErrors: cfg.orchestrator.maxConsecutiveErrors ?? 6 });
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
    if (!this.nativeTools) parts.push(textToolInstructions(toolCatalogue(this.toolCtx.allowed, { skills: this.hasSkills })));
    return parts.join('\n\n');
  }

  private firstUserMessage(): string {
    const acc = this.spec.acceptance?.length ? `\n\nAcceptance criteria:\n${this.spec.acceptance.map((a) => `- ${a}`).join('\n')}` : '';
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
    return `\n[Kurultay] ${path} ile ilgili skill'ler kullanılabilir: ${fresh.map((s) => `${s.name} — ${s.description}`).join('; ')}. Gerekirse skill aracıyla yükleyin.`;
  }

  /** Pi/Codex style condenser: shrink old tool outputs first, then replace the middle with a structured hand-off summary. */
  private async condense(): Promise<void> {
    const window = this.contextWindow();
    const reserve = Math.max(1024, Math.min(16_384, Math.floor(window * 0.3)));
    const budget = window - reserve;
    const size = () => estimateTokens(this.messages.map((m) => (m.content ?? '') + JSON.stringify(m.tool_calls ?? '')).join('\n'));
    if (size() <= budget) return;
    const keepTail = 8;
    for (let i = 2; i < this.messages.length - keepTail && size() > budget; i++) {
      const m = this.messages[i];
      if ((m.role === 'tool' || (m.role === 'user' && m.content?.startsWith('<tool_result'))) && (m.content?.length ?? 0) > 400) {
        m.content = `${m.content!.slice(0, 300)}\n…[eski araç çıktısı kısaltıldı]`;
      }
    }
    if (size() <= budget || this.messages.length <= keepTail + 3) return;
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
    this.messages = [this.messages[0], this.messages[1], { role: 'user', content: `<progress_notes>\n${notes}\n</progress_notes>\nContinue the task from these notes.` }, ...this.messages.slice(cut)];
    while (this.messages[3]?.role === 'tool') this.messages.splice(3, 1);
    this.interventions.push('condense');
    this.bus?.info(this.spec.id, 'bağlam yoğunlaştırıldı');
  }

  private async callModel(): Promise<ChatResult> {
    const req = () => ({
      messages: this.messages,
      tools: this.nativeTools ? toolSpecs(this.toolCtx.allowed, { skills: this.hasSkills }) : undefined,
      temperature: 0.2,
      purpose: `worker:${this.spec.id}`,
      signal: this.signal,
      onToken: (t: string) => this.bus?.emitEvent('worker.token', { source: this.spec.id, data: { t } }),
    });
    const toolsRejected = (e: unknown) => this.nativeTools && e instanceof LlmError && e.kind === 'bad_request' && /tool|function/i.test(e.message);

    if (this.cfg.llm?.stickyFailover === false) {
      // legacy behaviour: the router may answer from another model; the next step starts from the preferred one again
      try {
        return await this.router.chat(req(), { prefer: [this.currentModel], role: 'coder', fallback: true });
      } catch (e) {
        if (!toolsRejected(e)) throw e;
        this.bus?.warn(this.spec.id, 'native tool calling reddedildi; prompt tabanlı araç çağrısına geçiliyor');
        this.switchToTextTools();
        return this.router.chat(req(), { prefer: [this.currentModel], role: 'coder', fallback: true });
      }
    }

    // Sticky failover: talk to ONE model. If it fails (timeout, crash, quarantine), pick a replacement,
    // adapt the transcript to it, and continue the task there – never bouncing back to the failed model.
    for (;;) {
      try {
        return await this.router.chat(req(), { only: [this.currentModel], fallback: false, role: 'coder', recoveryWaitMs: 0 });
      } catch (e) {
        if (e instanceof LlmError && e.kind === 'aborted') throw e;
        if (toolsRejected(e)) {
          this.bus?.warn(this.spec.id, 'native tool calling reddedildi; prompt tabanlı araç çağrısına geçiliyor');
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
        this.bus?.warn(this.spec.id, `yedek model kalmadı; daha önce düşen modeller yeniden deneniyor (${[...this.failedModels].join(', ')})`);
        const r = await this.router.chat(req(), { prefer: [...this.failedModels], role: 'coder', fallback: true });
        if (r.model !== this.currentModel) this.switchModel(r.model, errorMessage(e));
        this.failedModels.delete(r.model);
        return r;
      }
    }
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
    this.failovers.push({ from, to, step: this.step, reason: reason.slice(0, 200) });
    this.interventions.push(`failover:${from}->${to}`);
    this.bus?.emitEvent('worker.failover', { source: this.spec.id, message: `${from} → ${to}`, data: { from, to, reason } });
    this.bus?.warn(this.spec.id, `${from} yanıt vermedi (${reason.slice(0, 120)}); görev ${to} ile devam ediyor, ${from} bu görevde tekrar kullanılmayacak`);
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
    const names = toolSpecs(this.toolCtx.allowed, { skills: this.hasSkills }).map((t) => t.function.name);
    // only worth a model call when the prose looks like an attempted tool call
    if (!names.some((n) => text.includes(n)) && !/[{`]/.test(text)) return [];
    try {
      const r = await this.router.chat(
        {
          messages: [
            {
              role: 'user',
              content: `An AI coding agent replied with plain text instead of a tool call. Extract the tool call(s) it intends to make, using ONLY these tools:\n${toolCatalogue(this.toolCtx.allowed, { skills: this.hasSkills })}\n\nReturn ONLY JSON: {"calls":[{"name":"...","arguments":{...}}]} – return {"calls":[]} if the text does not clearly intend a tool action (e.g. it only asks a question or says it is done without calling finish).\n\nAgent text:\n${text}`,
            },
          ],
          temperature: 0,
          jsonMode: true,
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
      if (this.signal?.aborted) return this.result('failed', 'iptal edildi', step, finalText, 'aborted');
      await this.condense();
      let r: ChatResult;
      try {
        r = await this.callModel();
      } catch (e) {
        return this.result('failed', `model hatası: ${errorMessage(e)}`, step, finalText, errorMessage(e));
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
        const shim = await this.toolshim(r.content);
        if (shim.length) {
          calls = shim.map((c, i) => ({ id: `s${step}_${i}`, name: c.name, args: c.arguments }));
          this.interventions.push('toolshim');
          this.bus?.emitEvent('worker.toolshim', { source: this.spec.id, data: { tools: shim.map((c) => c.name) } });
        }
      }

      if (!calls.length) {
        idle++;
        this.messages.push({ role: 'assistant', content: r.content || '(boş yanıt)' });
        if (idle >= 3) return this.result('failed', 'model araç çağrısı yapmadan durdu', step, finalText);
        this.messages.push({
          role: 'user',
          content: this.nativeTools
            ? 'You did not call any tool. Continue working using the tools, or call finish if the task is complete.'
            : 'No <tool_call> found. Continue using <tool_call> blocks, or call finish when done.',
        });
        continue;
      }
      idle = 0;

      if (useNative) this.messages.push({ role: 'assistant', content: r.content || null, tool_calls: r.toolCalls });
      else this.messages.push({ role: 'assistant', content: r.content || `(araç çağrıları: ${calls.map((c) => c.name).join(', ')})` });

      const results: string[] = [];
      for (const c of calls) {
        this.bus?.emitEvent('worker.tool', { source: this.spec.id, data: { tool: c.name, args: summarizeArgs(c.args) } });
        const out = await executeTool(c.name, c.args, this.toolCtx);
        if (c.name === 'skill' && !out.isError && typeof c.args.name === 'string' && !this.skillLog.some((x) => x.name === c.args.name)) {
          const s = this.spec.skills?.registry.get(c.args.name);
          if (s) this.skillLog.push({ name: s.name, how: 'tool' });
        }
        if (out.finished) {
          if (useNative) this.messages.push({ role: 'tool', tool_call_id: c.id, content: 'ok' });
          return this.result(out.finished.status, out.finished.summary || finalText, step, finalText);
        }
        let text = truncateMiddle(out.output, 16_000);
        text += this.newlyRelevantSkills(typeof c.args.path === 'string' ? c.args.path : undefined);
        const verdict = this.guard.record(c.name, c.args, out.output, !!out.isError);
        if (verdict.action === 'stop') {
          this.interventions.push(`stop:${verdict.kind}`);
          this.bus?.warn(this.spec.id, `çalışan durduruldu: ${verdict.message}`);
          return this.result('failed', `durduruldu: ${verdict.message}`, step, finalText, verdict.kind);
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
    }
    return this.result('max_steps', `adım sınırına ulaşıldı (${maxSteps})`, maxSteps, finalText);
  }

  private result(status: WorkerResult['status'], summary: string, steps: number, finalText: string, error?: string): WorkerResult {
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
