import type { KurultayConfig } from '../config.js';
import type { Router } from '../llm/router.js';
import { color } from '../ui/terminal.js';
import { displayWidth, fitWidth } from './keys.js';

export interface EndpointHealth {
  name: string;
  baseUrl: string;
  ok: boolean;
  ms: number;
  models: string[];
  error?: string;
}

const LOGO = [' ╦╔═╦ ╦╦═╗╦ ╦╦ ╔╦╗╔═╗╦ ╦', ' ╠╩╗║ ║╠╦╝║ ║║  ║ ╠═╣╚╦╝', ' ╩ ╩╚═╝╩╚═╚═╝╩═╝╩ ╩ ╩ ╩ '];

export function banner(version: string, width: number): string {
  const tag = `v${version} · tüm yerel LLM'ler tek mecliste · çevrimdışı`;
  if (width < 40) return `${color.bold('KURULTAY')} ${color.dim(tag)}`;
  return [...LOGO.map((l) => color.cyan(l)), color.dim(` ${tag}`)].join('\n');
}

/** Pad/truncate cells to fixed display widths. */
export function table(rows: string[][], widths: number[]): string[] {
  return rows.map((r) =>
    r
      .map((cell, i) => {
        const w = widths[i];
        if (w === undefined) return cell;
        const t = fitWidth(cell, w);
        return t + ' '.repeat(Math.max(0, w - displayWidth(t)));
      })
      .join('  ')
      .trimEnd(),
  );
}

const secs = (ms: number) => (ms === 0 ? 'kapalı' : ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} dk` : `${Math.round(ms / 1000)} sn`);

/**
 * The startup "LLM settings" panel (omp / Qwen Code / Crush show the active
 * models on launch): endpoints with live health, every model with its measured
 * capabilities and best roles, the parallel capacity and the failover settings.
 */
export function llmPanel(args: { config: KurultayConfig; configPath?: string; router: Router; probed: boolean; health?: EndpointHealth[]; width: number }): string {
  const { config, router, width } = args;
  const out: string[] = [];
  const eps = config.endpoints.filter((e) => !e.disabled);
  const models = router.list();
  const reachable = args.health ? args.health.filter((h) => h.ok).length : undefined;
  out.push(
    `${color.bold('LLM ayarları')}  ${eps.length} endpoint${reachable !== undefined ? ` (${reachable} erişilebilir)` : ''} · ${models.length} model · ${router.totalCapacity()} paralel slot · ${args.probed ? 'yetenek profili: ölçülmüş' : color.yellow('yetenek profili: yok (/probe)')}`,
  );
  if (args.configPath) out.push(color.dim(`  yapılandırma: ${args.configPath}`));
  out.push('');
  out.push(color.bold('  Endpoint'));
  const epRows = eps.map((e) => {
    const h = args.health?.find((x) => x.name === e.name);
    const status = !h ? color.dim('?') : h.ok ? color.green(`● ${h.ms} ms`) : color.red(`● ${fitWidth(h.error ?? 'erişilemiyor', 40)}`);
    const n = models.filter((m) => m.caps.endpoint === e.name).length;
    return [`  ${e.name}`, e.baseUrl, `${n} model`, status];
  });
  out.push(...table(epRows, [16, Math.min(40, Math.max(20, width - 60)), 9]));
  if (models.length) {
    out.push('');
    out.push(color.bold('  Model'));
    const rows = [[color.dim('  ad'), color.dim('bağlam'), color.dim('araç'), color.dim('tok/s'), color.dim('paralel'), color.dim('en iyi roller'), color.dim('başarı'), color.dim('durum')]];
    const stats = new Map(router.stats().map((s) => [s.key, s]));
    for (const h of models) {
      const c = h.caps;
      const best = Object.entries(c.roleScores)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([r]) => r)
        .join(', ');
      const st = stats.get(c.key);
      const state = st?.circuitOpen ? color.yellow('karantina') : st && st.failures > st.successes && st.failures > 0 ? color.yellow('sorunlu') : color.green('hazır');
      const learned = router.learned?.summary(c.key);
      rows.push([`  ${c.key}`, `${Math.round(c.contextWindow / 1024)}K`, c.nativeTools ? 'native' : 'prompt', c.tokensPerSec ? String(c.tokensPerSec) : '-', String(c.maxConcurrency), best, learned ? `%${Math.round(learned.rate * 100)} (${learned.n})` : '-', state]);
    }
    out.push(...table(rows, [Math.min(36, Math.max(...models.map((m) => displayWidth(m.caps.key))) + 2), 6, 6, 7, 7, 22, 9]));
  } else {
    out.push('', color.yellow('  Kullanılabilir model yok. Endpoint adreslerini kontrol edin (/llm, /endpoint add) ve /probe çalıştırın.'));
  }
  const l = config.llm;
  out.push('');
  out.push(
    color.dim(
      `  zaman aşımı: ilk token ${secs(l.firstTokenTimeoutMs)} · sessizlik ${secs(l.idleTimeoutMs)} · toplam ${secs(l.timeoutMs)} · takılan model karantinası ${secs(l.timeoutCooldownMs)} · kalıcı failover ${l.stickyFailover ? 'açık' : 'kapalı'}`,
    ),
  );
  return out.join('\n');
}

export function helpText(commands: Array<{ name: string; args?: string; description: string }>): string {
  const w = Math.max(...commands.map((c) => displayWidth(`/${c.name}${c.args ? ' ' + c.args : ''}`))) + 2;
  return [
    color.bold('Komutlar'),
    ...commands.map((c) => {
      const left = `/${c.name}${c.args ? ' ' + c.args : ''}`;
      return `  ${color.cyan(left)}${' '.repeat(Math.max(1, w - displayWidth(left)))}${c.description}`;
    }),
    '',
    color.bold('Girdi'),
    `  ${color.cyan('düz metin')}  soru ise konsey cevaplar, iş ise planlanıp yapılır (/intent ile sabitlenebilir)`,
    `  ${color.cyan('@dosya')}     dosyayı göreve/soruya ekler (Tab ile tamamlanır)`,
    `  ${color.cyan('$skill')}     skill'i bu işte baştan yükler`,
    `  ${color.cyan('!komut')}     çalışma alanında kabuk komutu çalıştırır`,
    `  ${color.cyan('satır sonu \\')} çok satırlı girdi · ↑/↓ geçmiş · Tab tamamla · Esc menüyü kapat · Ctrl+C iptal`,
  ].join('\n');
}
