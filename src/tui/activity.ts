import type { EventBus, KEvent } from '../util/events.js';

/**
 * "What is happening right now" for the live block under the spinner:
 *
 *   ⠹ Task · 2m 13s · 3 LLM requests running · 120K↑ 8K↓ tokens · Ctrl+C to cancel
 *     now: reviewing the candidates of T1
 *     T1-1  Qwen3-Coder-30B     editing CsvProductLoader.java · step 7
 *     T1-2  gemma-4-31B-it      thinking… · step 3
 *     gemma-4-31B-it            reviewing the candidates
 *
 * Built only from the event stream (worker.*, llm.*, run.*), so it works for every
 * operation that emits events: tasks, questions, analysis, the probe.
 */

interface WorkerState {
  model: string;
  step: number;
  doing: string;
  /** the last tool call, kept while the model thinks about its result */
  last?: string;
}

/** What a model is asked to do, by request purpose. */
const PURPOSE: Array<[RegExp, string]> = [
  [/^plan\.draft$/, 'drafting a plan'],
  [/^plan\.judge$/, 'comparing the plan drafts'],
  [/^localize\.files$/, 'finding the files to change'],
  [/^localize\.elements$/, 'finding the functions to change'],
  [/^council\.review$/, 'reviewing the candidates'],
  [/^requirements$/, 'checking the result against the task'],
  [/^ask$/, 'answering the question'],
  [/^ask\.chair$/, 'merging the answers'],
  [/^condense$/, 'compacting the conversation'],
  [/^summary\.file$/, 'summarising files'],
  [/^summary\.module$/, 'summarising modules'],
  [/^summary\.architecture/, 'writing the architecture document'],
  [/^analyze\.notes$/, 'writing project notes'],
  [/^analyze\.flows/, 'documenting the main flows'],
  [/^toolshim$/, 'repairing a tool call'],
];

export function describePurpose(purpose: string): string {
  return PURPOSE.find(([re]) => re.test(purpose))?.[1] ?? purpose;
}

const base = (p: unknown) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Human description of a tool call ("editing Foo.java", "running `ctest`"). */
export function describeTool(tool: string, args: Record<string, unknown> = {}): string {
  const path = base(args.path ?? args.file ?? args.target);
  switch (tool) {
    case 'read_file':
      return `reading ${path || 'a file'}`;
    case 'write_file':
      return `writing ${path || 'a file'}`;
    case 'edit_file':
    case 'apply_patch':
    case 'replace_in_file':
      return `editing ${path || 'a file'}`;
    case 'delete_file':
      return `deleting ${path || 'a file'}`;
    case 'list_dir':
    case 'list_files':
      return `browsing ${String(args.path ?? '.') || '.'}`;
    case 'search':
    case 'grep':
    case 'search_code':
    case 'find_symbol':
      return `searching "${clip(String(args.query ?? args.pattern ?? args.name ?? ''), 30)}"`;
    case 'run_command':
    case 'shell':
      return `running \`${clip(String(args.command ?? args.cmd ?? ''), 40)}\``;
    case 'repo_map':
      return 'looking at the repository map';
    case 'skill':
    case 'skill_file':
      return `loading skill ${clip(String(args.name ?? ''), 24)}`.trim();
    case 'run_tests':
      return 'running the tests';
    case 'build':
      return 'building';
    case 'finish':
    case 'done':
      return 'finishing up';
    default:
      return tool.replace(/_/g, ' ');
  }
}

export class ActivityTracker {
  private workers = new Map<string, WorkerState>();
  /** requests in flight per model that do not belong to a worker */
  private other = new Map<string, Map<string, number>>();
  private phase = '';
  private readonly handler = (e: KEvent) => this.onEvent(e);

  constructor(private readonly bus: EventBus) {
    bus.on('event', this.handler);
  }

  dispose(): void {
    this.bus.off('event', this.handler);
  }

  reset(): void {
    this.workers.clear();
    this.other.clear();
    this.phase = '';
  }

  /** Current phase in a few words ("planning", "T2 · 3 candidates are coding"). */
  get now(): string {
    return this.phase;
  }

  onEvent(e: KEvent): void {
    const d = e.data ?? {};
    const src = e.source ?? '';
    switch (e.type) {
      case 'run.start':
        this.reset();
        this.phase = 'planning: the models draft plans independently';
        break;
      case 'run.plan':
        this.phase = 'plan ready, starting the subtasks';
        break;
      case 'subtask.start':
        this.phase = `${src}: looking for the code to change`;
        break;
      case 'worker.start':
        this.workers.set(src, { model: String(d.model ?? '?'), step: 0, doing: 'starting' });
        this.phase = `${src.replace(/-\d+$/, '')}: ${this.workers.size > 1 ? `${this.workers.size} candidates are coding in separate sandboxes` : 'coding in a sandbox'}`;
        break;
      case 'worker.failover': {
        const w = this.workers.get(src);
        if (w) w.model = String(d.to ?? w.model);
        break;
      }
      case 'worker.tool': {
        const w = this.workers.get(src);
        if (w) {
          w.step++;
          w.doing = w.last = describeTool(String(d.tool ?? ''), (d.args ?? {}) as Record<string, unknown>);
        }
        break;
      }
      case 'worker.end':
        this.workers.delete(src);
        break;
      case 'subtask.winner':
        this.phase = `${src}: candidate chosen`;
        break;
      case 'run.verify':
        this.phase = 'verification done';
        break;
      case 'llm.request': {
        const purpose = String(d.purpose ?? '');
        const id = purpose.startsWith('worker:') ? purpose.slice(7) : '';
        const w = id ? this.workers.get(id) : undefined;
        if (w) {
          w.model = src || w.model;
          w.doing = w.last ? `thinking (after ${w.last})` : 'thinking…';
          break;
        }
        if (id) break;
        const m = this.other.get(src) ?? new Map<string, number>();
        m.set(purpose, (m.get(purpose) ?? 0) + 1);
        this.other.set(src, m);
        if (/^council\.review$/.test(purpose)) this.phase = 'review: other models judge the candidates (authors do not review themselves)';
        else if (purpose.startsWith('localize')) this.phase = 'localisation: finding the files and functions to change';
        else if (purpose === 'plan.judge') this.phase = 'planning: choosing the best plan';
        break;
      }
      case 'llm.response':
      case 'llm.error': {
        const purpose = String(d.purpose ?? '');
        const m = this.other.get(src);
        if (!m) break;
        // llm.error carries no purpose: release the oldest request of that model
        const key = purpose && m.has(purpose) ? purpose : [...m.keys()][0];
        if (key === undefined) break;
        const n = (m.get(key) ?? 1) - 1;
        if (n > 0) m.set(key, n);
        else m.delete(key);
        if (!m.size) this.other.delete(src);
        break;
      }
      case 'run.end':
        this.reset();
        break;
    }
  }

  /** Detail rows under the spinner: the phase, then one row per active model. */
  lines(width = 100): string[] {
    const rows: string[] = [];
    if (this.phase) rows.push(`  now: ${this.phase}`);
    const workers = [...this.workers];
    const modelCol = Math.min(28, Math.max(12, ...workers.map(([, w]) => short(w.model).length), ...[...this.other.keys()].map((m) => short(m).length)));
    const idCol = Math.max(4, ...workers.map(([id]) => id.length));
    for (const [id, w] of workers) {
      rows.push(`  ${id.padEnd(idCol)}  ${short(w.model).padEnd(modelCol)}  ${w.doing}${w.step ? ` · step ${w.step}` : ''}`);
    }
    for (const [model, m] of this.other) {
      const what = [...m.keys()].map(describePurpose).filter((v, i, a) => a.indexOf(v) === i).join(', ');
      rows.push(`  ${workers.length ? `${''.padEnd(idCol)}  ` : ''}${short(model).padEnd(modelCol)}  ${what}`);
    }
    return rows.map((r) => (r.length > width ? r.slice(0, width - 1) + '…' : r));
  }
}

/** Model key without the endpoint when it is the default one ("qwen@main" → "qwen"). */
function short(key: string): string {
  return key.replace(/@main$/, '');
}
