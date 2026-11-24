import type { KEvent } from '../util/events.js';

/**
 * Where the wall-clock time of a run went, from its own event stream. Separates the time a
 * single-model agent would not spend – the multi-model work – so a run that got slower BECAUSE
 * of the extra models says so:
 *  - planCouncil      several planners drafting + a judge (not on the fast path)
 *  - slowerCandidates waiting for the other candidates after the first one was done
 *  - selection        checking the candidates against each other and the council review
 *  - requirements     the final judges
 *  - rateLimitWait / slotWait   requests held back for a provider limit or a busy endpoint
 * Subtasks can run in parallel, so the parts may overlap; the share is capped at 100%.
 */
export interface RunTiming {
  totalSeconds: number;
  planning: number;
  planCouncil: boolean;
  coding: number;
  slowerCandidates: number;
  selection: number;
  fixes: number;
  verify: number;
  requirements: number;
  rateLimitWait: number;
  slotWait: number;
  /** distinct models that answered at least one request */
  models: number;
  /** seconds of multi-model work (see above) and its share of the run */
  multiModel: number;
  multiModelShare: number;
}

interface Worker {
  start: number;
  end?: number;
  done?: boolean;
  fix: boolean;
}

export class TimingTracker {
  private start: number | undefined;
  private planAt: number | undefined;
  private fast = false;
  private readonly workers = new Map<string, Worker>();
  private readonly winners = new Map<string, number>();
  private verifyAt: number | undefined;
  private requirementsAt: number | undefined;
  private rateLimitMs = 0;
  private slotMs = 0;
  private readonly modelKeys = new Set<string>();

  onEvent(e: KEvent): void {
    const d = e.data ?? {};
    switch (e.type) {
      case 'run.start':
        this.start ??= e.ts;
        break;
      case 'run.plan':
        if (this.planAt === undefined) {
          this.planAt = e.ts;
          this.fast = !!d.fast;
        }
        break;
      case 'worker.start':
        this.workers.set(e.source ?? '?', { start: e.ts, fix: /-fix\d+$/.test(e.source ?? '') });
        break;
      case 'worker.end': {
        const w = this.workers.get(e.source ?? '?');
        if (w) {
          w.end = e.ts;
          w.done = d.status === 'done';
        }
        break;
      }
      case 'subtask.winner':
        this.winners.set(e.source ?? '?', e.ts);
        break;
      case 'run.verify':
        this.verifyAt = e.ts;
        break;
      case 'run.requirements':
        this.requirementsAt = e.ts;
        break;
      case 'llm.response':
        if (e.source) this.modelKeys.add(e.source);
        break;
      case 'llm.wait':
        if (d.reason === 'rate_limit') this.rateLimitMs += Number(d.ms ?? 0);
        else this.slotMs += Number(d.ms ?? 0);
        break;
    }
  }

  /** `waitedMs`: time spent waiting for the user (plan approval, apply confirmation) – not run time. */
  result(now = Date.now(), waitedMs = 0): RunTiming {
    const s = (ms: number) => Math.max(0, Math.round(ms / 100) / 10);
    const start = this.start ?? now;
    const total = s(now - start - waitedMs);
    const bySubtask = new Map<string, Worker[]>();
    for (const [id, w] of this.workers) {
      const st = id.replace(/r?-\d+(-fix\d+)?$/, '');
      bySubtask.set(st, [...(bySubtask.get(st) ?? []), w]);
    }
    let coding = 0;
    let slower = 0;
    let selection = 0;
    let checks = 0;
    let fixes = 0;
    for (const [st, ws] of bySubtask) {
      const cands = ws.filter((w) => !w.fix);
      for (const w of ws.filter((x) => x.fix)) fixes += (w.end ?? now) - w.start;
      if (!cands.length) continue;
      const first = Math.min(...cands.map((w) => w.start));
      const lastEnd = Math.max(...cands.map((w) => w.end ?? now));
      const doneEnds = cands.filter((w) => w.done && w.end).map((w) => w.end!);
      const firstDone = doneEnds.length ? Math.min(...doneEnds) : lastEnd;
      coding += firstDone - first;
      if (cands.length > 1) slower += lastEnd - firstDone;
      const won = this.winners.get(st);
      // the winner is announced before the fix rounds start
      // with one candidate the time before the winner is its build/test run, not multi-model work
      if (won) {
        if (cands.length > 1) selection += Math.max(0, won - lastEnd);
        else checks += Math.max(0, won - lastEnd);
      }
    }
    const lastWinner = this.winners.size ? Math.max(...this.winners.values()) : undefined;
    const verify = (this.verifyAt && lastWinner ? Math.max(0, this.verifyAt - lastWinner - fixes) : 0) + checks;
    const requirements = this.requirementsAt && this.verifyAt ? this.requirementsAt - this.verifyAt : 0;
    const planning = this.planAt ? this.planAt - start : 0;
    // with one model the waits are the provider's, not the price of the extra models
    const several = this.modelKeys.size > 1;
    const waits = several ? this.rateLimitMs + this.slotMs : 0;
    const multiModel = s((this.fast ? 0 : planning) + slower + selection + requirements + waits);
    return {
      totalSeconds: total,
      planning: s(planning),
      planCouncil: !this.fast,
      coding: s(coding),
      slowerCandidates: s(slower),
      selection: s(selection),
      fixes: s(fixes),
      verify: s(verify),
      requirements: s(requirements),
      rateLimitWait: s(this.rateLimitMs),
      slotWait: s(this.slotMs),
      models: this.modelKeys.size,
      multiModel,
      multiModelShare: total ? Math.min(1, multiModel / total) : 0,
    };
  }
}

const fmt = (sec: number) => (sec >= 60 ? `${(sec / 60).toFixed(1)} min` : `${Math.round(sec)} s`);

/** One line for the console when the extra models cost a noticeable part of the run. */
export function multiModelNote(t: RunTiming): string | undefined {
  if (t.totalSeconds < 30 || t.multiModelShare < 0.25) return undefined;
  const parts = [
    t.planCouncil && t.planning ? `plan council ${fmt(t.planning)}` : '',
    t.slowerCandidates ? `waiting for slower candidates ${fmt(t.slowerCandidates)}` : '',
    t.selection ? `candidate checks and reviews ${fmt(t.selection)}` : '',
    t.requirements ? `requirement judges ${fmt(t.requirements)}` : '',
    t.rateLimitWait ? `provider rate limit ${fmt(t.rateLimitWait)}` : '',
    t.slotWait ? `busy endpoints ${fmt(t.slotWait)}` : '',
  ].filter(Boolean);
  return `multi-model work took ${Math.round(t.multiModelShare * 100)}% of the time (${fmt(t.multiModel)} of ${fmt(t.totalSeconds)}): ${parts.join(', ')}`;
}

export function renderTiming(t: RunTiming): string[] {
  const row = (label: string, sec: number, extra = '') => `| ${label} | ${fmt(sec)} | ${t.totalSeconds ? Math.round((sec / t.totalSeconds) * 100) : 0}%${extra} |`;
  return [
    '## Time',
    '',
    '| Phase | Time | Share |',
    '|---|---:|---:|',
    row(t.planCouncil ? 'Planning (plan council)' : 'Planning (fast path: localisation only)', t.planning, t.planCouncil ? ' · multi-model' : ''),
    row('Coding (until the first candidate was done)', t.coding),
    row('Waiting for slower candidates', t.slowerCandidates, ' · multi-model'),
    row('Candidate checks and reviews', t.selection, ' · multi-model'),
    row('Fix rounds', t.fixes),
    row('Final verification', t.verify),
    row('Requirement check', t.requirements, ' · multi-model'),
    row('Held back by the provider rate limit', t.rateLimitWait, t.models > 1 ? ' · multi-model' : ''),
    row('Waiting for a free endpoint slot', t.slotWait, t.models > 1 ? ' · multi-model' : ''),
    '',
    `**Multi-model work** (${t.models} model${t.models === 1 ? '' : 's'} answered): ${fmt(t.multiModel)} = ${Math.round(t.multiModelShare * 100)}% of ${fmt(t.totalSeconds)}. Parallel subtasks can overlap, so the rows need not add up.`,
  ];
}
