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
export function attachTerminal(bus: EventBus, opts: { verbose?: boolean; write?: (line: string) => void } = {}): () => void {
  const write = opts.write ?? ((line: string) => process.stderr.write(forTerminal(line) + '\n'));
  const state = { lastProgress: -1 };
  const handler = (e: KEvent) => {
    const line = format(e, !!opts.verbose, state);
    if (line === undefined) return;
    write(opts.verbose ? time(e.ts) + line.replace(/^\n+/, '') : line);
  };
  bus.on('event', handler);
  return () => bus.off('event', handler);
}

const list = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).map(String) : []);

function format(e: KEvent, verbose: boolean, state: { lastProgress: number }): string | undefined {
  const d = e.data ?? {};
  const src = e.source ? color.dim(`${e.source}: `) : '';
  switch (e.type) {
    // ---- messages from components
    case 'log.debug':
      return verbose ? `  ${src}${color.dim(e.message ?? '')}` : undefined;
    case 'log.info':
      return `  ${src}${e.message ?? ''}`;
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
      return verbose ? `  ${src}${color.yellow(`LLM error [${d.kind}] ${e.message?.slice(0, 200) ?? ''}`)}` : `  ${color.yellow(`⚠ ${e.source ?? 'model'}: ${d.kind === 'timeout' ? 'no answer (timeout)' : `request failed (${String(d.kind)})`}`)}`;
    case 'model.quarantine':
      return `  ${color.yellow(`⚠ ${e.source}: paused for ${Math.round(Number(d.ms) / 1000)} s after a timeout`)}`;

    // ---- capability probe
    case 'probe.step':
      return verbose ? `  ${src}${color.dim(`[${d.index}/${d.total}] ${d.step}`)}` : undefined;
    case 'probe.model':
      return d.reachable ? `  ${color.green('✓')} ${e.source} ${color.dim(`(${fmtSeconds(Number(d.seconds ?? 0))})`)}` : `  ${color.red('✗')} ${e.source} ${color.dim('unreachable')}`;

    // ---- analysis
    case 'analyze.start':
      return `\n${color.bold('Analysis')} – ${e.message}`;
    case 'analyze.progress': {
      if (d.phase !== 'files') return verbose ? `  ${color.dim(`module: ${d.module}`)}` : undefined;
      const pct = Math.floor((Number(d.done) / Math.max(1, Number(d.total))) * 10);
      if (pct === state.lastProgress && Number(d.done) !== Number(d.total)) return undefined;
      state.lastProgress = pct;
      return `  ${color.dim(`file summaries ${d.done}/${d.total}`)}`;
    }

    // ---- task run
    case 'run.start':
      return `\n${color.bold('Kurultay')} – ${d.models} models · session ${d.sessionId}${d.resumed ? ' (resumed)' : ''}\n${color.dim('Planning…')}`;
    case 'run.plan': {
      const subtasks = list(d.subtasks);
      return `\n${color.bold(`Plan (${d.mode})`)} – ${subtasks.length} subtask${subtasks.length === 1 ? '' : 's'}\n${subtasks.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`;
    }
    case 'run.replan':
      return `\n${color.dim(`Revising the plan with your feedback…`)}`;
    case 'run.iteration':
      return Number(d.iteration) > 1 ? `\n${color.bold(`Iteration ${d.iteration}`)} – ${d.subtasks} follow-up subtask${Number(d.subtasks) === 1 ? '' : 's'}` : undefined;
    case 'subtask.start':
      return `\n${color.bold(`▸ ${e.source}`)}  ${d.title}  ${color.dim(`[${list(d.models).join(', ')}]`)}`;
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
      return `\n${color.bold('Verification')}: ${d.skipped ? color.dim('no build/test commands configured') : d.ok ? color.green('passed') : color.red('failed')}`;
    case 'run.requirements': {
      const r = d as { complete?: boolean; missing?: string[] };
      return `${color.bold('Requirement check')}: ${r.complete ? color.green('complete') : color.yellow(`missing:\n${(r.missing ?? []).map((m) => `  - ${m}`).join('\n')}`)}`;
    }
    case 'run.merge':
      return `${color.bold('Applied to the project')}: ${list(d.written).length} file${list(d.written).length === 1 ? '' : 's'} written${list(d.conflicts).length ? color.yellow(`, ${list(d.conflicts).length} conflicts`) : ''}`;
    default:
      return undefined;
  }
}

export function fmtSeconds(sec: number): string {
  if (sec >= 60) return `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s`;
  return `${sec.toFixed(sec < 10 ? 1 : 0)} s`;
}
