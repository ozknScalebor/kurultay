import { constants, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { Semaphore } from '../util/async.js';
import type { Overlay } from './workspace.js';

/**
 * Isolated build/test directories ("sandboxes") so parallel workers can run
 * builds and tests at the same time without touching the real project
 * (OpenHands runtime / Codex sandbox idea, implemented with plain copies so it
 * works offline on Linux, macOS and Windows).
 *
 *  - A pool of N persistent copies lives in .kurultay/sandboxes/sb-<i>.
 *  - Copies use copy-on-write clones where the filesystem supports them
 *    (btrfs/xfs/APFS reflink), plain copies otherwise.
 *  - Build output folders are not copied (CMake caches contain absolute
 *    paths); they are rebuilt inside the sandbox and then reused – later
 *    commands in the same sandbox are incremental.
 *  - Large read-mostly folders (node_modules) are symlinked.
 *  - Before every use the sandbox is synced to the overlay: only files that
 *    differ are written; files changed in the project since the last use are
 *    refreshed via a size/mtime manifest.
 */

export interface SandboxOptions {
  /** max simultaneous sandboxes (= parallel builds) */
  size: number;
  /** top-level or nested folder names never copied (build outputs) */
  exclude: string[];
  /** folders symlinked instead of copied */
  link: string[];
  /** reuse a project scan for this long (ms) – many commands run back to back */
  rescanMs?: number;
}

export const DEFAULT_SANDBOX: SandboxOptions = {
  size: 4,
  exclude: ['.git', '.kurultay', '.svn', '.hg', 'build', 'out', 'target', 'bin', 'obj', 'cmake-build-debug', 'cmake-build-release', '.gradle', '.idea', '.vs', '__pycache__', '.pytest_cache', 'dist', 'coverage'],
  link: ['node_modules'],
};

interface Manifest {
  /** project files at the last refresh: rel path → "size:mtimeMs" */
  files: Record<string, string>;
}

interface SandboxState {
  dir: string;
  ready: boolean;
  /** files currently differing from the project because an overlay put them there */
  dirty: Set<string>;
  /** id of the overlay last synced (to prefer re-use by the same worker) */
  lastOverlay?: string;
  busy: boolean;
}

export class SandboxPool {
  private readonly sandboxes: SandboxState[];
  private readonly slots: Semaphore;
  private readonly opts: SandboxOptions;
  private lastScan: { at: number; files: Record<string, string> } | undefined;

  constructor(
    readonly root: string,
    readonly baseDir: string,
    opts: Partial<SandboxOptions> = {},
  ) {
    this.opts = { ...DEFAULT_SANDBOX, ...opts };
    this.slots = new Semaphore(Math.max(1, this.opts.size));
    this.sandboxes = Array.from({ length: Math.max(1, this.opts.size) }, (_, i) => ({ dir: join(baseDir, `sb-${i + 1}`), ready: false, dirty: new Set<string>(), busy: false }));
  }

  private excluded(rel: string): boolean {
    const parts = rel.split(/[\\/]/);
    return parts.some((p) => this.opts.exclude.includes(p));
  }

  /** Walk the project (respecting excludes/links) → rel path → "size:mtime". Cached briefly: many commands run back to back. */
  private scan(): Record<string, string> {
    if (this.lastScan && Date.now() - this.lastScan.at < (this.opts.rescanMs ?? 2000)) return this.lastScan.files;
    const files = this.scanNow();
    this.lastScan = { at: Date.now(), files };
    return files;
  }

  private scanNow(): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = join(dir, e.name);
        const rel = relative(this.root, abs).split(sep).join('/');
        if (this.excluded(rel) || this.opts.link.includes(e.name)) continue;
        if (e.isDirectory()) walk(abs);
        else if (e.isFile()) {
          try {
            const st = statSync(abs);
            out[rel] = `${st.size}:${Math.round(st.mtimeMs)}`;
          } catch {
            /* vanished */
          }
        }
      }
    };
    walk(this.root);
    return out;
  }

  private copyFile(rel: string, sb: SandboxState): void {
    const src = join(this.root, rel);
    const dst = join(sb.dir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    // reflink when possible (instant, no extra space), real copy otherwise
    cpSync(src, dst, { mode: constants.COPYFILE_FICLONE, force: true });
  }

  /** Create the copy (first use) or refresh it with project changes since the last use. */
  private prepare(sb: SandboxState): void {
    const manifestPath = join(sb.dir, '.kurultay-sandbox.json');
    const now = this.scan();
    let prev: Manifest | undefined;
    if (existsSync(manifestPath)) {
      try {
        prev = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
      } catch {
        prev = undefined;
      }
    }
    if (!prev) {
      rmSync(sb.dir, { recursive: true, force: true });
      mkdirSync(sb.dir, { recursive: true });
    }
    for (const [rel, sig] of Object.entries(now)) if (!prev || prev.files[rel] !== sig || !existsSync(join(sb.dir, rel))) this.copyFile(rel, sb);
    if (prev) for (const rel of Object.keys(prev.files)) if (!(rel in now)) rmSync(join(sb.dir, rel), { force: true });
    for (const name of this.opts.link) {
      const src = join(this.root, name);
      const dst = join(sb.dir, name);
      if (existsSync(src) && !existsSync(dst)) {
        try {
          symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
        } catch {
          cpSync(src, dst, { recursive: true });
        }
      }
    }
    writeFileSync(manifestPath, JSON.stringify({ files: now } satisfies Manifest));
    sb.dirty.clear();
    sb.ready = true;
  }

  /** Make the sandbox show exactly the overlay's view of the project. */
  private sync(sb: SandboxState, overlay: Overlay): void {
    const want = new Set(overlay.changedFiles());
    for (const rel of new Set([...sb.dirty, ...want])) {
      const v = overlay.read(rel);
      const abs = join(sb.dir, rel);
      if (v === undefined) {
        if (existsSync(abs) && !lstatSync(abs).isDirectory()) unlinkSync(abs);
      } else {
        let cur: string | undefined;
        try {
          cur = readFileSync(abs, 'utf8');
        } catch {
          cur = undefined;
        }
        if (cur !== v) {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, v);
        }
      }
    }
    sb.dirty = want;
    sb.lastOverlay = overlay.id;
  }

  /** Run `fn` with a sandbox directory that reflects the overlay. Parallel up to `size`. */
  async run<T>(overlay: Overlay, fn: (dir: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.slots.acquire(signal);
    // prefer the sandbox this overlay (or its parent chain) used last: its build outputs are freshest
    const chain = new Set<string>();
    for (let o: Overlay | undefined = overlay; o; o = o.parent) chain.add(o.id);
    const free = this.sandboxes.filter((s) => !s.busy);
    const sb = free.find((s) => s.lastOverlay === overlay.id) ?? free.find((s) => s.lastOverlay && chain.has(s.lastOverlay)) ?? free.find((s) => s.ready) ?? free[0];
    sb.busy = true;
    try {
      if (!sb.ready) this.prepare(sb);
      else this.refresh(sb);
      this.sync(sb, overlay);
      return await fn(sb.dir);
    } finally {
      sb.busy = false;
      this.slots.release();
    }
  }

  /** Cheap per-use refresh: pick up project files edited since the last use. */
  private refresh(sb: SandboxState): void {
    const manifestPath = join(sb.dir, '.kurultay-sandbox.json');
    let prev: Manifest;
    try {
      prev = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    } catch {
      return this.prepare(sb);
    }
    const now = this.scan();
    let changed = false;
    for (const [rel, sig] of Object.entries(now)) {
      if (prev.files[rel] !== sig) {
        if (!sb.dirty.has(rel)) this.copyFile(rel, sb);
        changed = true;
      }
    }
    for (const rel of Object.keys(prev.files)) {
      if (!(rel in now)) {
        if (!sb.dirty.has(rel)) rmSync(join(sb.dir, rel), { force: true });
        changed = true;
      }
    }
    if (changed) writeFileSync(manifestPath, JSON.stringify({ files: now } satisfies Manifest));
  }

  /** Map sandbox paths in command output back to project paths (so models do not try to open the copy). */
  rewriteOutput(text: string): string {
    let out = text;
    for (const sb of this.sandboxes) out = out.split(sb.dir).join(this.root);
    return out;
  }

  /** Remove all sandboxes from disk. */
  destroy(): void {
    rmSync(this.baseDir, { recursive: true, force: true });
    for (const sb of this.sandboxes) {
      sb.ready = false;
      sb.dirty.clear();
    }
  }
}
