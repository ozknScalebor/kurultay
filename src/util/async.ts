/** Small async primitives with no external dependencies. */

/**
 * Requests-per-minute limiter (sliding 60 s window). `take` resolves when one more request fits
 * and reports how long it waited. Shared by every endpoint behind the same key (a provider's
 * limit is per key, not per model).
 */
export class RateLimiter {
  private readonly stamps: number[] = [];

  constructor(readonly perMinute: number) {}

  async take(signal?: AbortSignal): Promise<number> {
    const t0 = Date.now();
    for (;;) {
      const now = Date.now();
      while (this.stamps.length && now - this.stamps[0] >= 60_000) this.stamps.shift();
      if (this.stamps.length < this.perMinute) {
        this.stamps.push(now);
        return now - t0;
      }
      await sleep(Math.max(50, 60_000 - (now - this.stamps[0]) + 5), signal);
    }
  }
}

export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private capacity: number) {
    if (capacity < 1) this.capacity = 1;
  }

  get inUse(): number {
    return this.active;
  }

  get limit(): number {
    return this.capacity;
  }

  get queued(): number {
    return this.waiters.length;
  }

  setLimit(n: number): void {
    this.capacity = Math.max(1, Math.floor(n));
    this.drain();
  }

  tryAcquire(): boolean {
    if (this.active < this.capacity) {
      this.active++;
      return true;
    }
    return false;
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (this.tryAcquire()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        this.active++;
        resolve();
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(signal?.reason ?? new Error('aborted'));
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.waiters.push(grant);
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.drain();
  }

  private drain(): void {
    while (this.active < this.capacity && this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      next();
    }
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Run `fn` over items with bounded parallelism, preserving order of results. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Like Promise.allSettled but typed for convenience. */
export async function settle<T>(promises: Promise<T>[]): Promise<Array<{ ok: true; value: T } | { ok: false; error: unknown }>> {
  const r = await Promise.allSettled(promises);
  return r.map((x) => (x.status === 'fulfilled' ? { ok: true as const, value: x.value } : { ok: false as const, error: x.reason }));
}

export function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; dispose: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${ms}ms`)), ms);
  const onAbort = () => ctrl.abort(signal?.reason ?? new Error('aborted'));
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export interface QuorumOptions {
  signal?: AbortSignal;
  /** once this many have answered, the rest get a grace period (default 1) */
  quorum?: number;
  /** grace = max(minGraceMs, factor × time the quorum took); defaults 30 s and 0.5 */
  minGraceMs?: number;
  factor?: number;
  /** called for each call stopped because it was slower than the others */
  onLate?: (index: number, waitedMs: number) => void;
}

/**
 * Like settle(), but a fan-out to several models does not wait for the slowest: once `quorum`
 * calls have succeeded, the others get a grace period and are then stopped. A broken or
 * overloaded model can no longer hold every council step until its timeout. Stopped calls
 * come back as `{ ok: false, late: true }`.
 */
export async function settleQuorum<T>(
  calls: Array<(signal: AbortSignal) => Promise<T>>,
  opts: QuorumOptions = {},
): Promise<Array<{ ok: true; value: T } | { ok: false; error: unknown; late?: boolean }>> {
  // nothing to wait for: an empty fan-out would never settle (and Node would just exit)
  if (!calls.length) return [];
  const t0 = Date.now();
  const need = Math.min(Math.max(1, opts.quorum ?? 1), calls.length);
  const ctrls = calls.map(() => new AbortController());
  const onAbort = () => ctrls.forEach((c) => c.abort(opts.signal?.reason ?? new Error('aborted')));
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const out: Array<{ ok: true; value: T } | { ok: false; error: unknown; late?: boolean } | undefined> = calls.map(() => undefined);
  let ok = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((done) => {
      let left = calls.length;
      const settled = () => {
        if (--left === 0) done();
      };
      calls.forEach((call, i) => {
        call(ctrls[i].signal).then(
          (value) => {
            if (!out[i]) out[i] = { ok: true, value };
            if (++ok === need && left > 1 && !timer) {
              const grace = Math.max(opts.minGraceMs ?? 30_000, (opts.factor ?? 0.5) * (Date.now() - t0));
              timer = setTimeout(() => {
                ctrls.forEach((c, j) => {
                  if (out[j]) return;
                  out[j] = { ok: false, error: new Error('stopped: slower than the other models'), late: true };
                  opts.onLate?.(j, Date.now() - t0);
                  c.abort(new Error('stopped: slower than the other models'));
                });
                done();
              }, grace);
            }
            settled();
          },
          (error: unknown) => {
            if (!out[i]) out[i] = { ok: false, error };
            settled();
          },
        );
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
  return out.map((r) => r ?? { ok: false, error: new Error('no result') });
}
