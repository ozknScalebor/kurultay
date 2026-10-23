/**
 * Live token / context accounting for the console: every LLM request of the
 * session (questions, tasks, analysis, probe) is counted from the router's
 * llm.request / llm.response events.
 *
 *  - session totals and per-model figures (/stats, status line)
 *  - per operation deltas (spinner while working, summary line afterwards)
 *  - context fill: prompt tokens ÷ the model's context window, live for
 *    requests in flight (estimate) and measured for answered ones
 */

export interface LiveModelUsage {
  requests: number;
  tokensIn: number;
  tokensOut: number;
  ms: number;
  errors: number;
  truncated: number;
  /** highest prompt/window ratio seen (0..1) */
  peakFill: number;
  window: number;
}

export interface ContextFill {
  model: string;
  used: number;
  window: number;
  fill: number;
}

export interface UsageMark {
  requests: number;
  tokensIn: number;
  tokensOut: number;
  errors: number;
  started: number;
  peak?: ContextFill;
}

interface UsageEvent {
  type: string;
  source?: string;
  data?: Record<string, unknown>;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export class UsageMeter {
  requests = 0;
  tokensIn = 0;
  tokensOut = 0;
  errors = 0;
  readonly byModel: Record<string, LiveModelUsage> = {};
  /** requests in flight per model (FIFO: answers are matched to the oldest request) */
  private readonly inFlight = new Map<string, Array<{ prompt: number; window: number }>>();
  /** the most recently answered request */
  last?: ContextFill;
  /** marks of running operations – each records its own peak fill */
  private readonly marks = new Set<UsageMark>();

  private model(key: string): LiveModelUsage {
    return (this.byModel[key] ??= { requests: 0, tokensIn: 0, tokensOut: 0, ms: 0, errors: 0, truncated: 0, peakFill: 0, window: 0 });
  }

  onEvent(e: UsageEvent): void {
    const key = e.source ?? '?';
    if (e.type === 'llm.request') {
      const list = this.inFlight.get(key) ?? [];
      list.push({ prompt: num(e.data?.prompt), window: num(e.data?.window) });
      this.inFlight.set(key, list);
      const w = num(e.data?.window);
      if (w) this.observe({ model: key, used: num(e.data?.prompt), window: w, fill: num(e.data?.prompt) / w });
    } else if (e.type === 'llm.response') {
      const req = this.inFlight.get(key)?.shift();
      const m = this.model(key);
      const i = num(e.data?.in);
      const o = num(e.data?.out);
      this.requests++;
      this.tokensIn += i;
      this.tokensOut += o;
      m.requests++;
      m.tokensIn += i;
      m.tokensOut += o;
      m.ms += num(e.data?.ms);
      const window = num(e.data?.window) || req?.window || m.window;
      if (window) {
        m.window = window;
        // the server's prompt count is exact; fall back to the estimate when a server reports no usage
        const used = i || req?.prompt || 0;
        const fill: ContextFill = { model: key, used, window, fill: used / window };
        this.last = fill;
        this.observe(fill);
      }
    } else if (e.type === 'llm.error') {
      this.inFlight.get(key)?.shift();
      this.errors++;
      this.model(key).errors++;
    } else if (e.type === 'llm.truncated') {
      this.model(key).truncated++;
    }
  }

  private observe(f: ContextFill): void {
    const m = this.model(f.model);
    if (f.window) m.window = f.window;
    if (f.fill > m.peakFill) m.peakFill = f.fill;
    for (const mark of this.marks) if (!mark.peak || f.fill > mark.peak.fill) mark.peak = f;
  }

  /** Requests currently waiting for an answer. */
  get active(): number {
    let n = 0;
    for (const l of this.inFlight.values()) n += l.length;
    return n;
  }

  /** The fullest context among requests in flight. */
  liveFill(): ContextFill | undefined {
    let best: ContextFill | undefined;
    for (const [model, list] of this.inFlight) {
      for (const r of list) {
        if (!r.window) continue;
        const fill = r.prompt / r.window;
        if (!best || fill > best.fill) best = { model, used: r.prompt, window: r.window, fill };
      }
    }
    return best;
  }

  /** Start counting an operation (a question, a task, an analysis). */
  begin(): UsageMark {
    const m: UsageMark = { requests: this.requests, tokensIn: this.tokensIn, tokensOut: this.tokensOut, errors: this.errors, started: Date.now() };
    this.marks.add(m);
    return m;
  }

  end(mark: UsageMark): void {
    this.marks.delete(mark);
  }

  since(mark: UsageMark): { requests: number; tokensIn: number; tokensOut: number; errors: number; seconds: number; peak?: ContextFill } {
    return {
      requests: this.requests - mark.requests,
      tokensIn: this.tokensIn - mark.tokensIn,
      tokensOut: this.tokensOut - mark.tokensOut,
      errors: this.errors - mark.errors,
      seconds: (Date.now() - mark.started) / 1000,
      peak: mark.peak,
    };
  }

  /** Spinner text while an operation runs: requests in flight, tokens so far, fullest live context. */
  activityText(mark?: UsageMark): string {
    const parts: string[] = [];
    if (this.active) parts.push(`${this.active} LLM isteği sürüyor`);
    if (mark) {
      const d = this.since(mark);
      if (d.tokensIn + d.tokensOut) parts.push(`${fmtTok(d.tokensIn)}↑ ${fmtTok(d.tokensOut)}↓ token`);
    }
    const live = this.liveFill();
    if (live) parts.push(`bağlam ${fillText(live)}`);
    return parts.join(' · ');
  }

  /** One line after an operation finished. */
  summary(mark: UsageMark): string {
    const d = this.since(mark);
    if (!d.requests && !d.errors) return '';
    const parts = [`${d.requests} istek`, `${fmtTok(d.tokensIn)} giriş / ${fmtTok(d.tokensOut)} çıkış token`];
    if (d.peak) parts.push(`en dolu bağlam ${fillText(d.peak)} (${d.peak.model})`);
    if (d.errors) parts.push(`${d.errors} hata`);
    return parts.join(' · ');
  }

  /** Short status-line part: session tokens and the context fill of the last answer. */
  footerText(): string {
    if (!this.requests) return '';
    const parts = [`${fmtTok(this.tokensIn + this.tokensOut)} token`];
    if (this.last) parts.push(`bağlam ${Math.round(this.last.fill * 100)}%`);
    return parts.join(' · ');
  }

  /** Markdown table of the session per model, including the peak context fill. */
  table(): string[] {
    const rows = Object.entries(this.byModel).sort((a, b) => b[1].tokensIn + b[1].tokensOut - (a[1].tokensIn + a[1].tokensOut));
    return [
      '| Model | İstek | Giriş | Çıkış | Ort. yanıt | En dolu bağlam | Hata | Kesilme |',
      '|---|---:|---:|---:|---:|---:|---:|---:|',
      ...rows.map(
        ([k, m]) =>
          `| ${k} | ${m.requests} | ${fmtTok(m.tokensIn)} | ${fmtTok(m.tokensOut)} | ${m.requests ? (m.ms / m.requests / 1000).toFixed(1) + ' sn' : '-'} | ${m.window ? `${Math.round(m.peakFill * 100)}% / ${fmtTok(m.window)}` : '-'} | ${m.errors} | ${m.truncated} |`,
      ),
    ];
  }

  reset(): void {
    this.requests = this.tokensIn = this.tokensOut = this.errors = 0;
    for (const k of Object.keys(this.byModel)) delete this.byModel[k];
    this.last = undefined;
  }
}

export function fmtTok(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(Math.round(n));
}

/** "62% (80K/128K)" – a visual bar is drawn by the caller where there is room. */
export function fillText(f: ContextFill): string {
  return `${Math.round(f.fill * 100)}% (${fmtTok(f.used)}/${fmtTok(f.window)})`;
}

/** Ten-cell bar for the context fill, e.g. "▰▰▰▰▰▰▱▱▱▱". */
export function fillBar(fill: number, cells = 10): string {
  const n = Math.max(0, Math.min(cells, Math.round(fill * cells)));
  return '▰'.repeat(n) + '▱'.repeat(cells - n);
}
