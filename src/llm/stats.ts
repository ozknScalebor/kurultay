import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Role } from '../config.js';

/**
 * Learned model quality: how often each model actually succeeded in each role
 * (its code passed verification / won the council, its plan or review was
 * usable, …). The probe score is the prior, real outcomes update it:
 *
 *   quality = (prior·K + successes) / (K + trials)      (Beta-Bernoulli mean, K = PRIOR_WEIGHT)
 *
 * so a model that keeps failing in practice sinks in the ranking even if it
 * looked good in the probe, and vice versa. Stored per user (shared by all
 * projects) in ~/.kurultay/model-stats.json.
 */
export const PRIOR_WEIGHT = 4;

export interface RoleStat {
  n: number;
  ok: number;
}

interface StatsFile {
  version: 1;
  models: Record<string, { roles: Partial<Record<Role, RoleStat>>; updatedAt: string }>;
}

export class ModelStats {
  private data: StatsFile = { version: 1, models: {} };
  /** outcomes recorded in this process (merged into the file on save) */
  private pending: Array<{ key: string; role: Role; ok: number; n: number }> = [];

  constructor(readonly file?: string) {
    if (file) this.data = ModelStats.read(file);
  }

  private static read(file: string): StatsFile {
    try {
      const d = JSON.parse(readFileSync(file, 'utf8')) as StatsFile;
      return d?.version === 1 && d.models ? d : { version: 1, models: {} };
    } catch {
      return { version: 1, models: {} };
    }
  }

  get(key: string, role: Role): RoleStat {
    return this.data.models[key]?.roles[role] ?? { n: 0, ok: 0 };
  }

  /** Record one outcome (ok = true/false, or a fraction 0..1 for partial success). */
  record(key: string, role: Role, ok: boolean | number): void {
    const v = typeof ok === 'number' ? Math.max(0, Math.min(1, ok)) : ok ? 1 : 0;
    const m = (this.data.models[key] ??= { roles: {}, updatedAt: '' });
    const r = (m.roles[role] ??= { n: 0, ok: 0 });
    r.n += 1;
    r.ok += v;
    m.updatedAt = new Date().toISOString();
    this.pending.push({ key, role, ok: v, n: 1 });
  }

  /** Probe score blended with observed outcomes. */
  quality(key: string, role: Role, prior: number): number {
    const s = this.get(key, role);
    return (prior * PRIOR_WEIGHT + s.ok) / (PRIOR_WEIGHT + s.n);
  }

  /** Overall success rate across roles (for display); undefined without data. */
  summary(key: string): { n: number; rate: number } | undefined {
    const roles = Object.values(this.data.models[key]?.roles ?? {}) as RoleStat[];
    const n = roles.reduce((a, r) => a + r.n, 0);
    if (!n) return undefined;
    return { n, rate: roles.reduce((a, r) => a + r.ok, 0) / n };
  }

  /** Merge this process's outcomes into the file (other processes may have written meanwhile). */
  save(): void {
    if (!this.file || !this.pending.length) return;
    try {
      const disk = existsSync(this.file) ? ModelStats.read(this.file) : { version: 1 as const, models: {} };
      for (const p of this.pending) {
        const m = (disk.models[p.key] ??= { roles: {}, updatedAt: '' });
        const r = (m.roles[p.role] ??= { n: 0, ok: 0 });
        r.n += p.n;
        r.ok += p.ok;
        m.updatedAt = new Date().toISOString();
      }
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(disk, null, 1));
      renameSync(tmp, this.file);
      this.data = disk;
      this.pending = [];
    } catch {
      /* statistics are an optimisation, never a failure */
    }
  }
}
