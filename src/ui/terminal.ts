import type { EventBus, KEvent } from '../util/events.js';
import { forTerminal } from './symbols.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = { dim: c(2), bold: c(1), red: c(31), green: c(32), yellow: c(33), blue: c(34), magenta: c(35), cyan: c(36), gray: c(90) };

function time(ts: number): string {
  return color.gray(new Date(ts).toTimeString().slice(0, 8)) + ' ';
}

/**
 * Live log of a run, one idea per line and grouped by phase:
 *
 *   Planning…
 *   Plan (race) – 2 subtasks
 *     1. Create module a
 *     2. Create module b
 *
 *   > T1  Create module a   [qwen3-coder@gpu1, gpt-oss@gpu2]
 *       + T1-1 done – 6 steps, 1 file (qwen3-coder@gpu1)
 *       -> chosen: T1-1
 *
 * Tool calls, shell commands, individual LLM requests and timestamps only appear with --verbose.
 */
export function attachTerminal(bus: EventBus, opts: { verbose?: boolean; write?: (line: string) => void; width?: () => number } = {}): () => void {
  const write = opts.write ?? ((line: string) => process.stderr.write(forTerminal(line) + '\n'));
  const state: FormatState = { lastProgress: -1, width: opts.width ?? (() => process.stderr.columns || 100) };
  const handler = (e: KEvent) => {
    const line = format(e, !!opts.verbose, state);
    if (line === undefined) return;
    write(opts.verbose ? time(e.ts) + line.replace(/^\n+/, '') : line);
  };
  bus.on('event', handler);
  return () => bus.off('event', handler);
}

const list = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).map(String) : []);

interface FormatState {
  lastProgress: number;
  width: () => number;
}

/**
 * A phase heading: a blank line, then "── Planning ───────…" across the terminal and a dim
 * line explaining what happens in this phase.
 */
export function section(title: string, note: string | undefined, width: number): string {
  const w = Math.max(30, Math.min(width, 120) - 1);
  const head = `── ${title} `;
  return `\n${color.bold(head)}${color.dim('─'.repeat(Math.max(3, w - head.length)))}${note ? `\n${color.dim(note)}` : ''}`;
}

const MODE_NOTE: Record<string, string> = {
  single: 'one model works the whole task through; another model takes over only if it stops answering',
  split: 'the task is split into subtasks; independent subtasks run in parallel',
  race: 'several models solve the same task in separate sandboxes; tests and reviewers pick the best',
  council: 'several candidates per subtask, ranked by a council of reviewers',
};

/** "src/a/Foo.java:Foo, bar" → "Foo.java (Foo, bar)" for the localisation line. */
function shortLocations(message: string): string {
  return message
    .replace(/^localised:\s*/, '')
    .split(/,\s*(?=[\w./\\-]+\.[A-Za-z0-9]+(?::|,|$))/)
    .map((part) => {
      const [path, ...names] = part.split(':');
      const file = path.split(/[\\/]/).pop() ?? path;
      const n = names.join(':').trim();
      return n ? `${file} (${n})` : file;
    })
    .join(' · ');
}

function format(e: KEvent, verbose: boolean, state: FormatState): string | undefined {
  const d = e.data ?? {};
  const src = e.source ? color.dim(`${e.source}: `) : '';
  switch (e.type) {
    // ---- messages from components
    case 'log.debug':
      return verbose ? `  ${src}${color.dim(e.message ?? '')}` : undefined;
    case 'log.info': {
      const m = e.message ?? '';
      if (!verbose && /^T\d+$/.test(e.source ?? '') && m.startsWith('localised:')) return `  ${color.cyan('⌖')} ${e.source} code to change: ${shortLocations(m)}`;
      if (!verbose && e.source === 'council') {
        const r = /^(\d+) candidates?, (\d+) reviewers?: (.*)$/.exec(m);
        if (r) return `    ${color.cyan('⚖')} review: ${r[1] === '1' ? '1 candidate' : `${r[1]} candidates`} · reviewers: ${r[3]}`;
      }
      if (!verbose && e.source === 'planner' && m.startsWith('plan drafts:')) return `  ${color.dim('plan drafts by')} ${m.slice(12).trim()}`;
      return `  ${src}${m}`;
    }
    case 'log.warn':
      return `  ${color.yellow(`⚠ ${e.source ? `${e.source}: ` : ''}${e.message ?? ''}`)}`;
    case 'log.error':
      return `  ${color.red(`✖ ${e.source ? `${e.source}: ` : ''}${e.message ?? ''}`)}`;

    // ---- LLM traffic (details only when verbose)
    case 'llm.request':
      return verbose ? `  ${src}${color.dim(`→ ${d.purpose ?? ''}${Number(d.attempt) > 1 ? ` (attempt ${d.attempt})` : ''}`)}` : undefined;
    case 'llm.response':
      return verbose ? `  ${src}${color.dim(`← ${d.purpose ?? ''} ${d.ms} ms, ${d.in} in / ${d.out} out tokens`)}` : undefined;
    case 'llm.error':
      if (verbose) return `  ${src}${color.yellow(`LLM error [${d.kind}] ${e.message?.slice(0, 200) ?? ''}`)}`;
      // a request that is retried is not a failure yet – keep it quiet
      if (d.retry) return `  ${color.dim(`↻ ${e.source ?? 'model'}: ${d.kind === 'timeout' ? 'no answer (timeout)' : /ECONNRESET|socket|closed/i.test(e.message ?? '') ? 'connection dropped' : `request failed (${String(d.kind)})`}, retrying`)}`;
      return `  ${color.yellow(`⚠ ${e.source ?? 'model'}: ${d.kind === 'timeout' ? 'no answer (timeout)' : `request failed (${String(d.kind)})`}`)}`;
    case 'model.quarantine':
      return `  ${color.yellow(`⚠ ${e.source}: paused for ${Math.round(Number(d.ms) / 1000)} s after a timeout`)}`;

    // ---- capability probe
    case 'probe.step':
      return verbose ? `  ${src}${color.dim(`[${d.index}/${d.total}] ${d.step}`)}` : undefined;
    case 'probe.model':
      return d.reachable ? `  ${color.green('✓')} ${e.source} ${color.dim(`(${fmtSeconds(Number(d.seconds ?? 0))})`)}` : `  ${color.red('✗')} ${e.source} ${color.dim('unreachable')}`;

    // ---- analysis
    case 'analyze.start':
      return section('Analysis', `${e.message ?? ''} – file summaries, module overviews and the architecture document`, state.width());
    case 'analyze.progress': {
      if (d.phase !== 'files') return verbose ? `  ${color.dim(`module: ${d.module}`)}` : undefined;
      const pct = Math.floor((Number(d.done) / Math.max(1, Number(d.total))) * 10);
      if (pct === state.lastProgress && Number(d.done) !== Number(d.total)) return undefined;
      state.lastProgress = pct;
      return `  ${color.dim(`file summaries ${d.done}/${d.total}`)}`;
    }

    // ---- task run
    case 'run.start':
      return `${color.dim(`  ${d.models} models · session ${d.sessionId}${d.resumed ? ' (resumed)' : ''}`)}${section('Planning', 'the task goes to one coder, who keeps its own todo list (mode multi: plan drafts from the planner models)', state.width())}`;
    case 'run.plan': {
      const subtasks = list(d.subtasks);
      const mode = String(d.mode ?? '');
      return `${section(`Plan · ${mode} · ${subtasks.length} subtask${subtasks.length === 1 ? '' : 's'}`, MODE_NOTE[mode], state.width())}\n${subtasks.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`;
    }
    case 'run.replan':
      return `\n${color.dim(`Revising the plan with your feedback…`)}`;
    case 'run.iteration':
      return Number(d.iteration) > 1
        ? section(`Iteration ${d.iteration}`, `${d.subtasks} follow-up subtask${Number(d.subtasks) === 1 ? '' : 's'} for what the checks found missing`, state.width())
        : section('Coding', 'each model works in its own sandbox copy; the project is only changed at the end, after you confirm', state.width());
    case 'subtask.start': {
      const models = list(d.models);
      const counted = [...new Set(models)].map((m) => {
        const n = models.filter((x) => x === m).length;
        return n > 1 ? `${m} ×${n}` : m;
      });
      return `\n${color.bold(`▸ ${e.source}  ${d.title}`)}\n  ${color.dim(`${models.length > 1 ? `${models.length} candidates` : 'coder'}: ${counted.join(', ')}`)}`;
    }
    case 'worker.start':
      return verbose ? `    ${src}started on ${d.model}` : undefined;
    case 'worker.tool':
      return verbose ? `    ${src}${color.dim(`${d.tool} ${JSON.stringify(d.args).slice(0, 120)}`)}` : undefined;
    case 'tool.command':
      return verbose ? `    ${src}${color.blue('$ ' + (e.message ?? ''))}` : undefined;
    case 'worker.failover':
      return `    ${color.yellow(`⚠ ${e.source}: ${d.from} stopped answering, continuing on ${d.to}`)}`;
    case 'worker.end': {
      const ok = d.status === 'done';
      const files = Number(d.files);
      return `    ${ok ? color.green('✓') : color.yellow('•')} ${e.source} ${ok ? 'done' : String(d.status)} – ${d.steps} steps, ${files} file${files === 1 ? '' : 's'} ${color.dim(`(${list(d.models).join(', ')})`)}`;
    }
    case 'subtask.winner':
      return `    ${color.green('→')} chosen: ${d.worker} ${color.dim(`(${list(d.models).join(', ')})`)}`;
    case 'run.verify':
      return `${section('Checks', 'build and tests on the result', state.width())}\n  ${d.skipped ? color.yellow('⚠ verification: no build/test commands configured – the code was not compiled or tested (kurultay init)') : d.ok ? `${color.green('✓')} verification: build and tests passed` : `${color.red('✗')} verification: failed`}`;
    case 'run.merge': {
      const written = list(d.written);
      return `\n${color.bold('Applied to the project')}${d.root ? color.dim(` (${d.root})`) : ''}: ${written.length} file${written.length === 1 ? '' : 's'} written${list(d.conflicts).length ? color.yellow(`, ${list(d.conflicts).length} conflicts`) : ''}`;
    }
    default:
      return undefined;
  }
}

export function fmtSeconds(sec: number): string {
  if (sec >= 60) return `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s`;
  return `${sec.toFixed(sec < 10 ? 1 : 0)} s`;
}
