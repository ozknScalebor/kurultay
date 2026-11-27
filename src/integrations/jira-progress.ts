import { describeTool } from '../tui/activity.js';
import { wrap } from '../tui/markdown.js';
import { plural } from '../util/text.js';
import { color } from '../ui/terminal.js';
import type { KEvent } from '../util/events.js';

/**
 * What the Jira work shows while it runs. Every line has a kind; the console and the command line
 * draw it with a heading per issue, the log file keeps the plain text:
 *
 *   ── Jira ───────────────────────────────────────────
 *     1 issue to do: YNAVYS-3883 (new)
 *
 *   ── YNAVYS-3883 ────────────────────────────────────
 *   Silah Muhimmat > Atesleme Bilgileri ekranindaki …
 *     repo     https://gitlab.company.local/team/app.git
 *     branch   kurultay/YNAVYS-3883 → dev
 *     ⚠ no build/test commands – the changes are not compiled or tested
 *     0:12  step 1 · Qwen3.8-Flash-Next-FP8 · looking at the repository map
 *     0:40  step 2 · reading AteslemeBilgileriPanel.java
 *     2:10  still working · waiting for Qwen3.8-Flash-Next-FP8 for 1m 30s
 *     ✓ merge request opened: https://…
 */
export type JiraLineKind = 'pass' | 'issue' | 'info' | 'step' | 'change' | 'warn' | 'ok' | 'fail' | 'plain';

/** A line as it goes to the log file (no colours, the tab of a label becomes spaces). */
export function plainLine(text: string, kind: JiraLineKind): string {
  const t = text.replace(/\t/g, '  ');
  if (kind === 'issue') return `== ${t}`;
  if (kind === 'warn') return `! ${t}`;
  if (kind === 'fail') return `x ${t}`;
  return t;
}

const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;

/**
 * A heading in colour, not only bold or dim: a classic Windows console shows dim text as plain
 * text, so the start of every line has its own colour (headings cyan, labels cyan, times gray,
 * step numbers magenta).
 */
function heading(title: string, width: number): string {
  const w = Math.max(30, Math.min(width, 120) - 1);
  return `\n${color.gray('── ')}${color.bold(color.cyan(title))} ${color.gray('─'.repeat(Math.max(3, w - title.length - 4)))}`;
}

/** A line for the terminal: headings, labels, symbols and colours; long text goes on in the next line. */
export function formatJiraLine(text: string, kind: JiraLineKind, width = 100): string {
  const w = Math.max(40, Math.min(width, 140) - 1);
  // wrapped under its own start: "  ⚠ text …\n    … text"
  const block = (t: string, lead: string, paint: (s: string) => string = (x) => x, rest = ' '.repeat(visible(lead))) =>
    wrap(t, w - visible(lead)).map((l, i) => (i ? rest : lead) + paint(l)).join('\n');
  switch (kind) {
    case 'pass':
      return `${heading('Jira', width)}\n${block(text, '  ')}`;
    case 'issue': {
      const [key, ...rest] = text.split('\t');
      const summary = rest.join(' ').trim();
      return `${heading(key, width)}${summary ? `\n${block(summary, '', color.bold)}` : ''}`;
    }
    case 'info': {
      const [label, ...rest] = text.split('\t');
      return rest.length ? block(rest.join(' '), `  ${color.cyan(label.padEnd(8))} `) : block(text, '  ', color.gray);
    }
    case 'step': {
      const [time, ...rest] = text.split('\t');
      if (!rest.length) return block(text, '  ');
      const body = rest.join(' ');
      const lead = `  ${color.gray(time.padStart(5))}  `;
      // "step 3 · reading X": the step number in its own colour
      const m = /^(step \d+)( · )([\s\S]*)$/.exec(body);
      if (m) return block(m[3], `${lead}${color.magenta(m[1])}${color.gray(m[2])}`, undefined, ' '.repeat(9));
      if (/^still working|^no model answers/.test(body)) return block(body, lead, color.gray, ' '.repeat(9));
      if (/^build\/tests: passed/.test(body)) return block(body, lead, color.green, ' '.repeat(9));
      return block(body, lead, undefined, ' '.repeat(9));
    }
    case 'change':
      return block(text, `  ${color.cyan('↻')} `, color.cyan, '    ');
    case 'warn':
      return block(text, `  ${color.yellow('⚠')} `, color.yellow, '    ');
    case 'ok':
      return block(text, `  ${color.green('✓')} `, undefined, '    ');
    case 'fail':
      return block(text, `  ${color.red('✗')} `, color.red, '    ');
    default:
      return text;
  }
}

/** The "Done" heading and one line per issue (console and command line). */
export function formatDone(done: Array<{ key: string; status: string; mr?: string; error?: string }>, width = 100): string {
  const lines = done.map((d) => {
    const sym = d.status === 'merge-request' ? color.green('✓') : d.status === 'failed' || d.status === 'no-repo' ? color.red('✗') : color.yellow('⚠');
    const err = d.error && d.status !== 'merge-request' ? color.gray(`  ${d.error.split('\n')[0].slice(0, 120)}`) : '';
    return `  ${sym} ${color.bold(d.key.padEnd(14))} ${d.status}${d.mr ? `  ${d.mr}` : ''}${err}`;
  });
  return [heading('Done', width), ...lines].join('\n');
}

const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtSpan = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};
const short = (model: string) => model.split('@')[0];

/**
 * Turns the events of a run into a few lines: every agent step with what it does, model
 * changes, warnings, the build/test result – and, when nothing visible happened for a while,
 * a line saying what it is waiting for.
 */
export class RunNarrator {
  private readonly t0: number;
  private steps = 0;
  private lastLine: number;
  private model = '';
  /** model → since when a request is open */
  private readonly inflight = new Map<string, number>();
  /** no model answers since (the router's retry warnings are folded into one line) */
  private down: number | undefined;
  /** quarters of the file summaries already told */
  private analyzed = 0;
  /** info lines already shown */
  private readonly told = new Set<string>();

  constructor(
    private readonly emit: (text: string, kind: JiraLineKind) => void,
    private readonly now: () => number = Date.now,
    /** after this long without a line, heartbeat() writes one */
    private readonly quietMs = 60_000,
  ) {
    this.t0 = now();
    this.lastLine = this.t0;
  }

  private step(text: string): void {
    this.lastLine = this.now();
    this.emit(`${fmtTime(this.lastLine - this.t0)}\t${text}`, 'step');
  }

  private say(text: string, kind: JiraLineKind): void {
    this.lastLine = this.now();
    this.emit(text, kind);
  }

  onEvent(e: KEvent): void {
    const d = e.data ?? {};
    switch (e.type) {
      case 'worker.start':
        this.model = String(d.model ?? '');
        this.step(`the agent starts on ${short(this.model)}`);
        break;
      case 'worker.tool': {
        this.steps++;
        const tool = String(d.tool ?? '');
        const what = tool === 'todo_write' ? 'updating its todo list' : describeTool(tool, (d.args ?? {}) as Record<string, unknown>);
        this.step(`step ${this.steps} · ${what}`);
        break;
      }
      case 'worker.failover':
        this.model = String(d.to ?? this.model);
        this.say(`${short(String(d.from ?? '?'))} stopped answering – continuing on ${short(String(d.to ?? '?'))}`, 'warn');
        break;
      case 'worker.inbox':
        this.say('the agent read the change of the issue and follows it from now on', 'change');
        break;
      case 'worker.end': {
        const files = Number(d.files ?? 0);
        this.step(`the agent ${d.status === 'done' ? 'is done' : `stopped (${String(d.status)})`}${files ? ` – ${plural(files, 'file')} changed` : ''}`);
        break;
      }
      case 'run.verify':
        if (d.skipped) break;
        if (d.ok) this.step('build/tests: passed');
        else this.say('build/tests failed – the agent gets the errors', 'warn');
        break;
      case 'run.merge':
        this.step('changes written to the work tree');
        break;
      case 'log.warn': {
        const msg = e.message ?? '';
        if (/^no build\/test commands/i.test(msg)) this.say('no build/test commands – the changes are not compiled or tested', 'warn');
        else if (/stopped answering|answers too late/.test(msg)) break; // worker.failover says it shorter
        else if (/All models are unreachable|circuit breaker open|no backup model left|retrying the models that failed/i.test(msg)) {
          // one line for the whole outage; the heartbeat says how long it lasts
          if (this.down === undefined) {
            this.down = this.now();
            this.say('no model answers – Kurultay keeps trying', 'warn');
          }
        } else this.say(msg.split('\n')[0], 'warn');
        break;
      }
      case 'analyze.progress': {
        // every quarter of the file summaries, then each module
        if (d.phase === 'files') {
          const done = Number(d.done ?? 0);
          const total = Math.max(1, Number(d.total ?? 1));
          const q = Math.floor((done / total) * 4);
          if (q > this.analyzed && done < total) {
            this.analyzed = q;
            this.step(`analysis · ${done}/${total} files summarised`);
          }
        } else if (d.phase === 'modules' && d.module) this.step(`analysis · module ${String(d.module)}`);
        break;
      }
      case 'analyze.done':
        this.analyzed = 0;
        break;
      case 'log.info':
        // once per run, even when the project is opened again (after the capability probe)
        if (e.source === 'verify' && typeof d.source === 'string' && !this.told.has(e.message ?? '')) {
          this.told.add(e.message ?? '');
          if (d.build) this.say(`build\t${String(d.build)} (from ${d.source})`, 'info');
          if (d.test) this.say(`test\t${String(d.test)} (from ${d.source})`, 'info');
        }
        break;
      case 'llm.request':
        if (e.source) this.inflight.set(e.source, this.now());
        break;
      case 'llm.response':
        if (e.source) this.inflight.delete(e.source);
        if (this.down !== undefined) {
          this.say(`${short(e.source ?? 'a model')} answers again after ${fmtSpan(this.now() - this.down)}`, 'ok');
          this.down = undefined;
        }
        break;
      case 'llm.error':
        if (e.source) this.inflight.delete(e.source);
        break;
    }
  }

  /** Called every few seconds: after a quiet minute, a line saying what is going on. */
  heartbeat(): void {
    const now = this.now();
    if (now - this.lastLine < this.quietMs) return;
    if (this.down !== undefined) return this.step(`no model answers for ${fmtSpan(now - this.down)} – still trying`);
    const open = [...this.inflight.entries()].sort((a, b) => a[1] - b[1])[0];
    this.step(open ? `still working · waiting for ${short(open[0])} for ${fmtSpan(now - open[1])}` : 'still working');
  }
}
