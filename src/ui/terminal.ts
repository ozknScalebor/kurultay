import type { EventBus, KEvent } from '../util/events.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = { dim: c(2), bold: c(1), red: c(31), green: c(32), yellow: c(33), blue: c(34), magenta: c(35), cyan: c(36), gray: c(90) };

const PALETTE = [color.cyan, color.magenta, color.yellow, color.blue, color.green];
const sourceColor = new Map<string, (s: string) => string>();
function tint(source: string): string {
  const key = source.split(/[-:]/)[0];
  if (!sourceColor.has(key)) sourceColor.set(key, PALETTE[sourceColor.size % PALETTE.length]);
  return sourceColor.get(key)!(source);
}

function time(ts: number): string {
  return color.gray(new Date(ts).toTimeString().slice(0, 8));
}

/** Human-readable live log of what every model/worker is doing. */
export function attachTerminal(bus: EventBus, opts: { verbose?: boolean } = {}): () => void {
  const handler = (e: KEvent) => {
    const line = format(e, !!opts.verbose);
    if (line) process.stderr.write(line + '\n');
  };
  bus.on('event', handler);
  return () => bus.off('event', handler);
}

function format(e: KEvent, verbose: boolean): string | undefined {
  const src = e.source ? tint(e.source) + ' ' : '';
  const d = e.data ?? {};
  switch (e.type) {
    case 'log.info':
      return `${time(e.ts)} ${src}${e.message}`;
    case 'log.warn':
      return `${time(e.ts)} ${src}${color.yellow('⚠ ' + (e.message ?? ''))}`;
    case 'log.error':
      return `${time(e.ts)} ${src}${color.red('✖ ' + (e.message ?? ''))}`;
    case 'llm.request':
      return verbose ? `${time(e.ts)} ${src}${color.dim(`→ ${d.purpose ?? ''}${Number(d.attempt) > 1 ? ` (deneme ${d.attempt})` : ''}`)}` : undefined;
    case 'llm.response':
      return verbose ? `${time(e.ts)} ${src}${color.dim(`← ${d.purpose ?? ''} ${d.ms}ms in=${d.in} out=${d.out}`)}` : undefined;
    case 'llm.error':
      return `${time(e.ts)} ${src}${color.yellow(`LLM hatası [${d.kind}] ${e.message?.slice(0, 160) ?? ''}`)}`;
    case 'analyze.start':
      return `${time(e.ts)} ${color.bold('Analiz')} ${e.message}`;
    case 'analyze.progress':
      return d.phase === 'files' ? `${time(e.ts)} ${color.dim(`dosya özetleri ${d.done}/${d.total}`)}` : verbose ? `${time(e.ts)} ${color.dim(`modül: ${d.module}`)}` : undefined;
    case 'run.start':
      return `${time(e.ts)} ${color.bold('Kurultay toplandı')} — ${d.models} model · oturum ${d.sessionId}`;
    case 'run.plan':
      return `${time(e.ts)} ${color.bold('Plan')} (mod: ${d.mode})\n${(d.subtasks as string[]).map((s, i) => `   ${i + 1}. ${s}`).join('\n')}`;
    case 'run.iteration':
      return `${time(e.ts)} ${color.bold(`İterasyon ${d.iteration}`)} — ${d.subtasks} alt görev`;
    case 'subtask.start':
      return `${time(e.ts)} ${src}${color.bold(String(d.title))} → ${(d.models as string[]).join(', ')}`;
    case 'subtask.winner':
      return `${time(e.ts)} ${src}${color.green('🏆 kazanan')} ${d.worker} [${(d.models as string[]).join(', ')}]`;
    case 'worker.start':
      return `${time(e.ts)} ${src}başladı (${d.model})`;
    case 'worker.tool':
      return `${time(e.ts)} ${src}${color.dim(`${d.tool} ${JSON.stringify(d.args).slice(0, 120)}`)}`;
    case 'worker.end':
      return `${time(e.ts)} ${src}${d.status === 'done' ? color.green('bitti') : color.yellow(String(d.status))} · ${d.steps} adım · ${d.files} dosya · ${(d.models as string[]).join(', ')}`;
    case 'tool.command':
      return `${time(e.ts)} ${src}${color.blue('$ ' + (e.message ?? ''))}`;
    case 'run.verify':
      return `${time(e.ts)} ${color.bold('Doğrulama')}: ${d.skipped ? 'komut tanımlı değil' : d.ok ? color.green('geçti') : color.red('kaldı')}`;
    case 'run.requirements': {
      const r = d as { complete?: boolean; missing?: string[] };
      return `${time(e.ts)} ${color.bold('Gereksinim kontrolü')}: ${r.complete ? color.green('tamam') : color.yellow('eksik: ' + (r.missing ?? []).join(' | '))}`;
    }
    case 'run.merge':
      return `${time(e.ts)} ${color.bold('Projeye uygulandı')}: ${(d.written as string[]).length} yazıldı, ${(d.conflicts as string[]).length} çakışma`;
    default:
      return undefined;
  }
}
