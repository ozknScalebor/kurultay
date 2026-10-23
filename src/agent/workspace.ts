import type { CheckpointRecorder } from './checkpoint.js';
import { SandboxPool, type SandboxOptions } from './sandbox.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { Semaphore } from '../util/async.js';
import { unifiedDiff } from './diff.js';
import { merge3 } from './merge3.js';

/**
 * While a Materializer has an overlay applied in place (for build/test), the
 * real files temporarily contain that candidate's changes. Every other reader
 * must keep seeing the pristine project, so originals are registered here.
 */
const pristine = new Map<string, Map<string, string | null>>();

function rootKey(root: string): string {
  return normalize(root);
}

/** Read a project file as it is WITHOUT any temporarily applied overlay. */
export function readProjectFile(root: string, path: string): string | undefined {
  const reg = pristine.get(rootKey(root));
  if (reg?.has(path)) {
    const v = reg.get(path);
    return v === null ? undefined : v;
  }
  try {
    return readFileSync(join(root, path), 'utf8');
  } catch {
    return undefined;
  }
}

function isTemporarilyCreated(root: string, path: string): boolean {
  return pristine.get(rootKey(root))?.get(path) === null;
}

/** Normalise a user/model supplied path to a safe project-relative posix path. */
export function safeRelPath(root: string, p: string): string {
  let s = (p ?? '').trim().replace(/^["'`]|["'`]$/g, '');
  if (!s) throw new Error('empty file path');
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  const abs = isAbsolute(s) ? normalize(s) : normalize(join(root, s));
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path outside the project rejected: ${p}`);
  const posix = rel.split(sep).join('/');
  if (/^(\.git|\.kurultay)(\/|$)/.test(posix)) throw new Error(`protected folder: ${p}`);
  return posix;
}

/**
 * Copy-on-write view of the project for one worker. Reads fall through to the
 * parent overlay (if any) and then to the real project; writes stay in memory
 * until the orchestrator merges the winning result. This makes N parallel
 * workers cheap – no repository copies, no git worktrees required.
 */
export class Overlay {
  readonly files = new Map<string, string | null>();
  /** project content at first touch (undefined = did not exist) */
  readonly baseSnapshot = new Map<string, string | undefined>();
  /** parent-view content at first touch – the merge base when absorbing into the parent */
  readonly parentSnapshot = new Map<string, string | undefined>();

  constructor(
    readonly id: string,
    readonly root: string,
    readonly parent?: Overlay,
  ) {}

  private baseRead(path: string): string | undefined {
    if (this.parent) {
      const v = this.parent.peek(path);
      if (v !== undefined) return v ?? undefined;
    }
    return readProjectFile(this.root, path);
  }

  /** Overlay-local lookup through the parent chain: string = content, null = deleted, undefined = untouched */
  peek(path: string): string | null | undefined {
    if (this.files.has(path)) return this.files.get(path)!;
    return this.parent?.peek(path);
  }

  read(path: string): string | undefined {
    const v = this.peek(path);
    if (v === null) return undefined;
    if (v !== undefined) return v;
    return this.baseRead(path);
  }

  exists(path: string): boolean {
    return this.read(path) !== undefined || this.isDir(path);
  }

  isDir(path: string): boolean {
    try {
      return statSync(join(this.root, path)).isDirectory();
    } catch {
      return [...this.allTouched()].some((p) => p.startsWith(path.replace(/\/$/, '') + '/'));
    }
  }

  private snapshot(path: string): void {
    if (!this.baseSnapshot.has(path)) {
      // snapshot is always the REAL project state (what the merge must match)
      const v = readProjectFile(this.root, path);
      this.baseSnapshot.set(path, v);
      this.parentSnapshot.set(path, this.parent ? this.parent.read(path) : v);
    }
  }

  write(path: string, content: string): void {
    this.snapshot(path);
    this.files.set(path, content);
  }

  delete(path: string): void {
    this.snapshot(path);
    this.files.set(path, null);
  }

  private allTouched(): Set<string> {
    const s = new Set<string>(this.files.keys());
    if (this.parent) for (const p of this.parent.allTouched()) s.add(p);
    return s;
  }

  /** Directory listing merged with overlay additions/deletions. */
  list(dir: string): Array<{ name: string; dir: boolean }> {
    const d = dir.replace(/^\.?\/?/, '').replace(/\/$/, '');
    const entries = new Map<string, boolean>();
    try {
      for (const e of readdirSync(join(this.root, d), { withFileTypes: true })) {
        if (!isTemporarilyCreated(this.root, d ? `${d}/${e.name}` : e.name)) entries.set(e.name, e.isDirectory());
      }
    } catch {
      /* dir may exist only in overlay */
    }
    for (const p of this.allTouched()) {
      if (d && !p.startsWith(d + '/')) continue;
      const rest = d ? p.slice(d.length + 1) : p;
      const [first, ...more] = rest.split('/');
      const v = this.peek(p);
      if (more.length) entries.set(first, true);
      else if (v === null) entries.delete(first);
      else entries.set(first, false);
    }
    return [...entries.entries()].map(([name, dir]) => ({ name, dir })).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  }

  /** Paths whose content differs from the project (including parent chain changes). */
  changedFiles(): string[] {
    const out: string[] = [];
    for (const p of this.allTouched()) {
      const v = this.peek(p);
      const disk = readProjectFile(this.root, p);
      const now = v === null ? undefined : v;
      if (now !== disk) out.push(p);
    }
    return out.sort();
  }

  /** Changes made by THIS overlay only (relative to what its parent showed at first touch). */
  ownChanges(): string[] {
    return [...this.files.keys()].filter((p) => {
      const v = this.files.get(p);
      return (v === null ? undefined : v) !== this.parentSnapshot.get(p);
    }).sort();
  }

  diff(): string {
    return this.changedFiles()
      .map((p) => {
        const disk = readProjectFile(this.root, p);
        const v = this.peek(p);
        return unifiedDiff(p, disk, v === null ? undefined : v ?? undefined);
      })
      .filter(Boolean)
      .join('');
  }

  /** Diff of THIS overlay's own edits relative to what its parent showed (what a reviewer should judge). */
  diffAgainstParent(): string {
    return [...this.files.keys()]
      .sort()
      .map((p) => {
        const v = this.files.get(p);
        return unifiedDiff(p, this.parentSnapshot.get(p), v === null ? undefined : v);
      })
      .filter(Boolean)
      .join('');
  }

  /** Child overlay that sees this overlay's changes (used for subtasks / fix rounds). */
  fork(id: string): Overlay {
    return new Overlay(id, this.root, this);
  }

  /**
   * Pull a child's own changes into this overlay. Files that this overlay
   * changed after the child forked are 3-way merged.
   */
  absorb(child: Overlay): { files: string[]; conflicts: string[] } {
    const files: string[] = [];
    const conflicts: string[] = [];
    for (const [p, v] of child.files) {
      const base = child.parentSnapshot.get(p);
      const mine = v === null ? undefined : v;
      if (mine === base) continue;
      const cur = this.read(p);
      if (cur === base) {
        if (mine === undefined) this.delete(p);
        else this.write(p, mine);
        files.push(p);
        continue;
      }
      if (mine === undefined || cur === undefined) {
        conflicts.push(p);
        continue;
      }
      const m = merge3(base ?? '', mine, cur);
      this.write(p, m.content);
      files.push(p);
      if (!m.ok) conflicts.push(p);
    }
    return { files, conflicts };
  }

  /** Serializable form (for session resume). */
  toJSON(): { id: string; files: Record<string, string | null>; base: Record<string, string | null> } {
    const files: Record<string, string | null> = {};
    const base: Record<string, string | null> = {};
    for (const [k, v] of this.files) files[k] = v;
    for (const [k, v] of this.baseSnapshot) base[k] = v ?? null;
    return { id: this.id, files, base };
  }

  static fromJSON(root: string, data: { id: string; files: Record<string, string | null>; base: Record<string, string | null> }): Overlay {
    const o = new Overlay(data.id, root);
    for (const [k, v] of Object.entries(data.base)) {
      o.baseSnapshot.set(k, v ?? undefined);
      o.parentSnapshot.set(k, v ?? undefined);
    }
    for (const [k, v] of Object.entries(data.files)) o.files.set(k, v);
    return o;
  }
}

export interface MergeReport {
  written: string[];
  deleted: string[];
  merged3way: string[];
  conflicts: string[];
}

/**
 * Applies overlays to the real tree.
 *  - `withApplied` temporarily materialises an overlay in-place (serialised,
 *    crash-safe journal) so build/test commands see the candidate's changes
 *    while reusing existing build artifacts.
 *  - `merge` permanently writes an overlay, doing a 3-way merge when the file
 *    changed on disk since the worker first read it.
 */
export class Materializer {
  private readonly lock = new Semaphore(1);
  /** isolated build/test copies (undefined = run in place, serialised) */
  readonly sandboxes: SandboxPool | undefined;

  constructor(
    readonly root: string,
    readonly stateDir: string,
    opts: { isolation?: 'sandbox' | 'inplace'; sandbox?: Partial<SandboxOptions> } = {},
  ) {
    if ((opts.isolation ?? 'sandbox') === 'sandbox') this.sandboxes = new SandboxPool(root, join(stateDir, 'sandboxes'), opts.sandbox);
  }

  /**
   * Run something (build, tests, a model's command) against an overlay's view
   * of the project. With sandboxes several of these run in parallel in
   * separate copies and the real project is never touched; in-place mode
   * applies the overlay temporarily (serialised, journaled).
   */
  async execute<T>(overlay: Overlay, fn: (cwd: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.sandboxes) return this.sandboxes.run(overlay, fn, signal);
    return this.withApplied(overlay, () => fn(this.root), signal);
  }

  /** Paths of sandbox copies in command output → project paths. */
  rewriteOutput(text: string): string {
    return this.sandboxes ? this.sandboxes.rewriteOutput(text) : text;
  }

  private journalPath(): string {
    return join(this.stateDir, 'journal.json');
  }

  /** Restore originals if a previous run crashed while an overlay was applied. */
  recover(): string[] {
    const jp = this.journalPath();
    if (!existsSync(jp)) return [];
    const j = JSON.parse(readFileSync(jp, 'utf8')) as { originals: Record<string, string | null> };
    const restored: string[] = [];
    for (const [p, content] of Object.entries(j.originals)) {
      const abs = join(this.root, p);
      if (content === null) {
        if (existsSync(abs)) unlinkSync(abs);
      } else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
      restored.push(p);
    }
    rmSync(jp, { force: true });
    return restored;
  }

  async withApplied<T>(overlay: Overlay, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.lock.acquire(signal);
    const originals: Record<string, string | null> = {};
    try {
      const changed = overlay.changedFiles();
      for (const p of changed) {
        const abs = join(this.root, p);
        originals[p] = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
      }
      mkdirSync(this.stateDir, { recursive: true });
      writeFileSync(this.journalPath(), JSON.stringify({ overlay: overlay.id, originals }));
      pristine.set(rootKey(this.root), new Map(Object.entries(originals)));
      for (const p of changed) {
        const abs = join(this.root, p);
        const v = overlay.read(p);
        if (v === undefined) {
          if (existsSync(abs)) unlinkSync(abs);
        } else {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, v);
        }
      }
      return await fn();
    } finally {
      for (const [p, content] of Object.entries(originals)) {
        const abs = join(this.root, p);
        try {
          if (content === null) {
            if (existsSync(abs)) unlinkSync(abs);
          } else writeFileSync(abs, content);
        } catch {
          /* journal stays → recover() next start */
          continue;
        }
      }
      rmSync(this.journalPath(), { force: true });
      pristine.delete(rootKey(this.root));
      this.lock.release();
    }
  }

  async merge(overlay: Overlay, signal?: AbortSignal, checkpoint?: CheckpointRecorder): Promise<MergeReport> {
    await this.lock.acquire(signal);
    const report: MergeReport = { written: [], deleted: [], merged3way: [], conflicts: [] };
    try {
      const touched = new Set<string>();
      for (let o: Overlay | undefined = overlay; o; o = o.parent) for (const p of o.files.keys()) touched.add(p);
      for (const p of [...touched].sort()) {
        const mine = overlay.read(p);
        let base: string | undefined;
        for (let o: Overlay | undefined = overlay; o; o = o.parent) if (o.baseSnapshot.has(p)) base = o.baseSnapshot.get(p);
        const abs = join(this.root, p);
        const disk = existsSync(abs) ? readFileSync(abs, 'utf8') : undefined;
        if (mine === disk) continue;
        checkpoint?.before(p);
        if (disk === base) {
          if (mine === undefined) {
            unlinkSync(abs);
            report.deleted.push(p);
          } else {
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, mine);
            report.written.push(p);
          }
          checkpoint?.after(p);
          continue;
        }
        // file changed on disk since the worker read it → 3-way merge
        if (mine === undefined || disk === undefined) {
          report.conflicts.push(p);
          continue;
        }
        const m = merge3(base ?? '', mine, disk);
        writeFileSync(abs, m.content);
        checkpoint?.after(p);
        if (m.ok) report.merged3way.push(p);
        else report.conflicts.push(p);
      }
      return report;
    } finally {
      this.lock.release();
    }
  }
}
