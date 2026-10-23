import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Checkpoints make every change Kurultay applies to the project reversible
 * (Claude Code / Qwen Code "rewind"): before a file is written or deleted its
 * previous content is stored, after the write a hash of the new content, so a
 * later rewind can tell whether the user edited the file in the meantime.
 */
export interface CheckpointFile {
  /** content before Kurultay touched the file; null = the file did not exist */
  before: string | null;
  /** sha256 of the content Kurultay left; null = Kurultay deleted the file */
  afterHash: string | null;
}

export interface Checkpoint {
  version: 1;
  createdAt: string;
  /** what was applied (session id / task) */
  label: string;
  files: Record<string, CheckpointFile>;
  /** set once the checkpoint has been rewound */
  rewoundAt?: string;
}

export const hashText = (s: string): string => createHash('sha256').update(s).digest('hex');

export class CheckpointRecorder {
  private readonly files: Record<string, CheckpointFile> = {};

  constructor(private readonly root: string) {}

  /** Call before changing `path` (relative to the root). Only the first call per file counts. */
  before(path: string): void {
    if (path in this.files) return;
    const abs = join(this.root, path);
    this.files[path] = { before: existsSync(abs) ? readFileSync(abs, 'utf8') : null, afterHash: null };
  }

  /** Call after changing `path`. */
  after(path: string): void {
    const f = this.files[path];
    if (!f) return;
    const abs = join(this.root, path);
    f.afterHash = existsSync(abs) ? hashText(readFileSync(abs, 'utf8')) : null;
  }

  get size(): number {
    return Object.keys(this.files).length;
  }

  save(file: string, label: string): Checkpoint {
    const cp: Checkpoint = { version: 1, createdAt: new Date().toISOString(), label, files: this.files };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cp, null, 1));
    return cp;
  }
}

export function readCheckpoint(file: string): Checkpoint | undefined {
  try {
    const cp = JSON.parse(readFileSync(file, 'utf8')) as Checkpoint;
    return cp && cp.version === 1 && cp.files ? cp : undefined;
  } catch {
    return undefined;
  }
}

/** Files whose current content differs from what Kurultay left (edited by someone since). */
export function modifiedSince(root: string, cp: Checkpoint): string[] {
  return Object.entries(cp.files)
    .filter(([p, f]) => {
      const abs = join(root, p);
      const now = existsSync(abs) ? hashText(readFileSync(abs, 'utf8')) : null;
      return now !== f.afterHash;
    })
    .map(([p]) => p);
}

/**
 * Restore the project to the state before the checkpoint. Files edited since
 * are skipped unless `force` is set. Returns what was restored and skipped.
 */
export function rewindCheckpoint(root: string, file: string, opts: { force?: boolean } = {}): { restored: string[]; skipped: string[] } {
  const cp = readCheckpoint(file);
  if (!cp) throw new Error(`could not read the checkpoint: ${file}`);
  if (cp.rewoundAt) throw new Error(`this change was already undone (${cp.rewoundAt})`);
  const changed = new Set(modifiedSince(root, cp));
  const restored: string[] = [];
  const skipped: string[] = [];
  for (const [p, f] of Object.entries(cp.files)) {
    if (changed.has(p) && !opts.force) {
      skipped.push(p);
      continue;
    }
    const abs = join(root, p);
    if (f.before === null) {
      if (existsSync(abs)) unlinkSync(abs);
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.before);
    }
    restored.push(p);
  }
  if (!skipped.length) {
    cp.rewoundAt = new Date().toISOString();
    writeFileSync(file, JSON.stringify(cp, null, 1));
  }
  return { restored, skipped };
}
