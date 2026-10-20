import { createHash } from 'node:crypto';

/**
 * Loop / stuck detection for agent workers. Combines the strongest ideas found in
 * the reference agents:
 *  - Crush: signature = tool call + its RESULT (re-reading a changed file is fine)
 *  - Cline: arguments hashed with sorted keys; soft warning at 3, hard stop at 5
 *  - Qwen Code / OpenHands: alternating A-B-A-B patterns, read-only exploration budget
 *  - Cline mistake tracker: consecutive failing calls
 */

export interface LoopGuardOptions {
  softRepeat?: number; // warn when the same call+result happens this often
  hardRepeat?: number; // stop
  window?: number; // steps considered for repeats / alternation
  explorationBudget?: number; // consecutive read-only calls before a reminder
  maxConsecutiveErrors?: number; // stop after this many failing calls in a row
}

export type GuardVerdict =
  | { action: 'ok' }
  | { action: 'warn'; kind: 'repeat' | 'alternating' | 'exploration' | 'errors'; message: string }
  | { action: 'stop'; kind: 'repeat' | 'alternating' | 'errors'; message: string };

function sortKeys(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sortKeys);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
  return out;
}

export function callSignature(name: string, args: Record<string, unknown>, result: string): string {
  return createHash('sha256').update(name).update('\u0000').update(JSON.stringify(sortKeys(args))).update('\u0000').update(result).digest('hex').slice(0, 16);
}

export function callKey(name: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(name).update('\u0000').update(JSON.stringify(sortKeys(args))).digest('hex').slice(0, 16);
}

const READ_ONLY = new Set(['read_file', 'list_dir', 'search_code', 'grep', 'find_symbol', 'repo_map', 'skill', 'skill_file']);

export class LoopGuard {
  private readonly o: Required<LoopGuardOptions>;
  private readonly history: string[] = []; // signatures (call+result)
  private readonly keys: string[] = []; // call keys (call only)
  private readOnlyStreak = 0;
  private errorStreak = 0;
  private warned = new Set<string>();

  constructor(opts: LoopGuardOptions = {}) {
    this.o = { softRepeat: 3, hardRepeat: 5, window: 10, explorationBudget: 15, maxConsecutiveErrors: 6, ...opts };
  }

  get consecutiveErrors(): number {
    return this.errorStreak;
  }

  /** Record one executed tool call and decide what to do. */
  record(name: string, args: Record<string, unknown>, result: string, isError: boolean): GuardVerdict {
    const sig = callSignature(name, args, result);
    const key = callKey(name, args);
    this.history.push(sig);
    this.keys.push(key);
    if (this.history.length > this.o.window * 3) {
      this.history.shift();
      this.keys.shift();
    }

    // consecutive failures (Cline mistake tracker)
    this.errorStreak = isError ? this.errorStreak + 1 : 0;
    if (this.errorStreak >= this.o.maxConsecutiveErrors) {
      return { action: 'stop', kind: 'errors', message: `${this.errorStreak} araç çağrısı üst üste başarısız oldu` };
    }

    // identical call + identical result within the window (Crush / Cline)
    const recent = this.history.slice(-this.o.window);
    const repeats = recent.filter((s) => s === sig).length;
    if (repeats >= this.o.hardRepeat) {
      return { action: 'stop', kind: 'repeat', message: `aynı "${name}" çağrısı aynı sonuçla ${repeats} kez tekrarlandı (döngü)` };
    }

    // A-B-A-B-A-B alternation on call keys (Qwen / OpenHands)
    const k = this.keys.slice(-6);
    if (k.length === 6 && k[0] !== k[1] && k[0] === k[2] && k[2] === k[4] && k[1] === k[3] && k[3] === k[5]) {
      const tag = `alt:${k[0]}:${k[1]}`;
      if (this.warned.has(tag)) return { action: 'stop', kind: 'alternating', message: 'iki çağrı arasında gidip gelme döngüsü' };
      this.warned.add(tag);
      return {
        action: 'warn',
        kind: 'alternating',
        message: 'Aynı iki çağrı arasında gidip geliyorsunuz. Durun, şu ana kadar öğrendiklerinizi özetleyin ve farklı bir yaklaşım seçin.',
      };
    }

    if (repeats === this.o.softRepeat) {
      return {
        action: 'warn',
        kind: 'repeat',
        message: `Bu "${name}" çağrısını aynı sonuçla ${repeats}. kez yaptınız. Tekrarlamak sonucu değiştirmez: farklı bir araç/yaklaşım deneyin ya da iş bittiyse finish çağırın.`,
      };
    }

    if (isError && this.errorStreak === Math.ceil(this.o.maxConsecutiveErrors / 2)) {
      return { action: 'warn', kind: 'errors', message: 'Son araç çağrılarınız başarısız oldu. Hata mesajlarını dikkatle okuyun; düzenleme hatalarında önce dosyayı read_file ile yeniden okuyun.' };
    }

    // read-only exploration budget (Qwen tool-exploration-budget)
    if (READ_ONLY.has(name)) {
      this.readOnlyStreak++;
      if (this.readOnlyStreak > 0 && this.readOnlyStreak % this.o.explorationBudget === 0) {
        return {
          action: 'warn',
          kind: 'exploration',
          message: `${this.readOnlyStreak} salt-okuma çağrısı yaptınız. Toplanan bilgiyi gözden geçirip uygulamaya geçin; yalnızca belirli bir eksik için aramaya devam edin.`,
        };
      }
    } else this.readOnlyStreak = 0;
    return { action: 'ok' };
  }
}
