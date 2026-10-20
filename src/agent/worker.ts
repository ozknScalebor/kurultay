import type { KurultayConfig } from '../config.js';
import type { ProjectIndex } from '../index/project-index.js';
import type { ModelHandle, Router } from '../llm/router.js';
import { LlmError, type ChatMessage, type ChatResult } from '../llm/types.js';
import { errorMessage } from '../util/async.js';
import type { EventBus } from '../util/events.js';
import { estimateTokens, truncateMiddle, tryExtractJson } from '../util/text.js';
import { parseTextToolCalls, textToolInstructions } from './text-tools.js';
import { executeTool, toolCatalogue, toolSpecs, type ToolContext } from './tools.js';
import type { Materializer, Overlay } from './workspace.js';

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
}

const BASE_SYSTEM = `You are a senior software engineer working autonomously inside an existing codebase, as one member of a team of AI models (a "kurultay").
Principles:
- Investigate before editing: use search/read tools; never guess file contents or APIs.
- Make the smallest correct change that fully solves the task; follow existing style and project rules.
- Keep the build green: after editing, run the project's build/test commands when available and fix what you broke.
- Never touch files unrelated to the task. Never run destructive or networked commands.
- Communicate only through tool calls; when finished call finish with a short summary (what changed, how verified).`;

export class AgentWorker {
  private messages: ChatMessage[] = [];
  private usedModels = new Set<string>();
  private nativeTools: boolean;
  private readonly toolCtx: ToolContext;
  private tokens = { in: 0, out: 0 };

  constructor(
    private readonly spec: WorkerSpec,
    private readonly router: Router,
    private readonly cfg: KurultayConfig,
    deps: { index?: ProjectIndex; materializer: Materializer; root: string; bus?: EventBus; signal?: AbortSignal },
    private readonly bus = deps.bus,
    private readonly signal = deps.signal,
  ) {
    const handle = router.get(spec.model);
    this.nativeTools = handle?.caps.nativeTools ?? true;
    const allowed = spec.readOnly ? new Set(['read_file', 'list_dir', 'search_code', 'grep', 'find_symbol', 'repo_map', 'finish']) : undefined;
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
    };
  }

  private handle(): ModelHandle | undefined {
    return this.router.get(this.spec.model);
  }

  private contextWindow(): number {
    return this.handle()?.caps.contextWindow ?? 32_768;
  }

  private systemPrompt(): string {
    const verify = [this.cfg.verify.build, this.cfg.verify.test, this.cfg.verify.lint].filter(Boolean);
    const parts = [BASE_SYSTEM];
    if (this.spec.roleInstructions) parts.push(this.spec.roleInstructions);
    if (verify.length) parts.push(`Project verification commands (run them with run_command before finishing):\n${verify.map((v) => `- ${v}`).join('\n')}`);
    if (!this.nativeTools) parts.push(textToolInstructions(toolCatalogue(this.toolCtx.allowed)));
    return parts.join('\n\n');
  }

  private firstUserMessage(): string {
    const acc = this.spec.acceptance?.length ? `\n\nAcceptance criteria:\n${this.spec.acceptance.map((a) => `- ${a}`).join('\n')}` : '';
    return `${this.spec.context}\n\n# TASK\n${this.spec.task}${acc}`;
  }

  /** OpenHands-style condenser: shrink old tool outputs, then summarise the middle of the history. */
  private async condense(): Promise<void> {
    const budget = Math.floor(this.contextWindow() * 0.6);
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
    // summarise everything between the first user message and the tail
    let cut = this.messages.length - keepTail;
    // never split an assistant tool_call from its tool responses
    while (cut < this.messages.length && this.messages[cut].role === 'tool') cut++;
    const middle = this.messages.slice(2, cut);
    const transcript = middle.map((m) => `${m.role}: ${(m.content ?? '').slice(0, 1500)}${m.tool_calls ? ' ' + JSON.stringify(m.tool_calls).slice(0, 600) : ''}`).join('\n');
    let notes = '';
    try {
      const r = await this.router.chat(
        {
          messages: [{ role: 'user', content: `Condense this agent work log into compact notes: files inspected and key facts learned, changes already made, failing commands/errors, and what remains to do.\n\n${truncateMiddle(transcript, 40_000)}` }],
          maxTokens: 1200,
          temperature: 0,
          purpose: 'condense',
          signal: this.signal,
        },
        { role: 'fast' },
      );
      notes = r.content;
    } catch {
      notes = transcript.slice(-4000);
    }
    this.messages = [this.messages[0], this.messages[1], { role: 'user', content: `<progress_notes>\n${notes}\n</progress_notes>\nContinue the task from these notes.` }, ...this.messages.slice(cut)];
    // native protocol: a leading assistant must not reference missing tool calls
    while (this.messages[3]?.role === 'tool') this.messages.splice(3, 1);
    this.bus?.info(this.spec.id, 'bağlam yoğunlaştırıldı');
  }

  private async callModel(): Promise<ChatResult> {
    const req = {
      messages: this.messages,
      tools: this.nativeTools ? toolSpecs(this.toolCtx.allowed) : undefined,
      temperature: 0.2,
      purpose: `worker:${this.spec.id}`,
      signal: this.signal,
      onToken: (t: string) => this.bus?.emitEvent('worker.token', { source: this.spec.id, data: { t } }),
    };
    try {
      return await this.router.chat(req, { prefer: [this.spec.model], role: 'coder', fallback: true });
    } catch (e) {
      // some servers reject the tools field → switch to prompt-based tools once
      if (this.nativeTools && e instanceof LlmError && e.kind === 'bad_request' && /tool|function/i.test(e.message)) {
        this.bus?.warn(this.spec.id, 'native tool calling reddedildi; prompt tabanlı araç çağrısına geçiliyor');
        this.nativeTools = false;
        this.messages[0] = { role: 'system', content: this.systemPrompt() };
        return this.router.chat({ ...req, tools: undefined, messages: this.messages }, { prefer: [this.spec.model], role: 'coder', fallback: true });
      }
      throw e;
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
    this.bus?.emitEvent('worker.start', { source: this.spec.id, data: { model: this.spec.model, task: this.spec.task.slice(0, 200) } });

    for (let step = 1; step <= maxSteps; step++) {
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

      const calls = this.nativeTools && answeringNative && r.toolCalls.length
        ? r.toolCalls.map((tc) => ({ id: tc.id, name: tc.function.name, args: (tryExtractJson<Record<string, unknown>>(tc.function.arguments) ?? {}) as Record<string, unknown> }))
        : parseTextToolCalls(r.content).map((c, i) => ({ id: `t${step}_${i}`, name: c.name, args: c.arguments }));

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

      if (this.nativeTools && answeringNative && r.toolCalls.length) {
        this.messages.push({ role: 'assistant', content: r.content || null, tool_calls: r.toolCalls });
      } else {
        this.messages.push({ role: 'assistant', content: r.content });
      }

      const results: string[] = [];
      for (const c of calls) {
        this.bus?.emitEvent('worker.tool', { source: this.spec.id, data: { tool: c.name, args: summarizeArgs(c.args) } });
        const out = await executeTool(c.name, c.args, this.toolCtx);
        if (out.finished) {
          if (this.nativeTools && answeringNative && r.toolCalls.length) this.messages.push({ role: 'tool', tool_call_id: c.id, content: 'ok' });
          return this.result(out.finished.status, out.finished.summary || finalText, step, finalText);
        }
        const text = truncateMiddle(out.output, 16_000);
        if (this.nativeTools && answeringNative && r.toolCalls.length) {
          this.messages.push({ role: 'tool', tool_call_id: c.id, content: text });
        } else {
          results.push(`<tool_result name="${c.name}"${out.isError ? ' error="true"' : ''}>\n${text}\n</tool_result>`);
        }
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
    };
    this.bus?.emitEvent('worker.end', { source: this.spec.id, data: { status, steps, files: res.changedFiles.length, models: res.models } });
    return res;
  }
}

function summarizeArgs(a: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) out[k] = typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '…' : v;
  return out;
}
