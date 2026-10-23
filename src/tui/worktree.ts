import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Git worktrees for isolated work (Qwen Code --worktree, Claude Code worktrees):
 * each worktree lives in <repo>/.kurultay/worktrees/<slug> on branch kurultay/<slug>.
 */

export interface WorktreeInfo {
  slug: string;
  path: string;
  branch: string;
  /** uncommitted changes in the worktree */
  dirty: boolean;
}

/** Canonical path (Windows 8.3 short names, symlinked temp dirs on macOS) for comparisons. */
export function realPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

function git(cwd: string, args: string[], timeoutMs = 30_000): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitOk(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: git(cwd, args) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || err.message };
  }
}

/** Top-level directory of the main repository (also when called inside a worktree). */
export function repoRoot(dir: string): string | undefined {
  const r = gitOk(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!r.ok) return undefined;
  // <main>/.git → <main>
  return realPath(r.out.replace(/[\\/]\.git$/, ''));
}

/** Current branch name read from .git without spawning git (cheap enough for every prompt). */
export function currentBranch(dir: string): string | undefined {
  try {
    let gitDir = join(dir, '.git');
    if (!existsSync(gitDir)) return undefined;
    if (statSync(gitDir).isFile()) {
      const m = readFileSync(gitDir, 'utf8').match(/gitdir:\s*(.+)/);
      if (!m) return undefined;
      gitDir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(dir, m[1].trim());
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = head.match(/^ref: refs\/heads\/(.+)$/);
    return ref ? ref[1] : head.slice(0, 7);
  } catch {
    return undefined;
  }
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/ı/g, 'i')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || `wt-${Date.now().toString(36)}`
  );
}

export function worktreeDir(root: string, slug: string): string {
  return join(root, '.kurultay', 'worktrees', slug);
}

export function listWorktrees(root: string): WorktreeInfo[] {
  const r = gitOk(root, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return [];
  const base = realPath(worktreeDir(root, ''));
  const out: WorktreeInfo[] = [];
  for (const block of r.out.split(/\n\n+/)) {
    const raw = block.match(/^worktree (.+)$/m)?.[1];
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? '';
    if (!raw) continue;
    const path = realPath(raw);
    if (!path.startsWith(base) || path === base) continue;
    const dirty = gitOk(path, ['status', '--porcelain']).out.length > 0;
    out.push({ slug: path.slice(base.length).replace(/^[\\/]/, ''), path, branch, dirty });
  }
  return out;
}

/** Create <root>/.kurultay/worktrees/<slug> on a new branch kurultay/<slug> from HEAD. */
export function createWorktree(root: string, name: string): WorktreeInfo {
  const slug = slugify(name);
  const path = worktreeDir(root, slug);
  if (existsSync(path)) throw new Error(`worktree already exists: ${slug}`);
  const branch = `kurultay/${slug}`;
  ignoreStateDir(root);
  const r = gitOk(root, ['worktree', 'add', '-b', branch, path, 'HEAD']);
  if (!r.ok) throw new Error(`git worktree add failed: ${r.out}`);
  return { slug, path, branch, dirty: false };
}

/** Keep Kurultay's own folder (index, sessions, worktrees) out of git without touching .gitignore. */
export function ignoreStateDir(root: string): void {
  const common = gitOk(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common.ok) return;
  const file = join(common.out, 'info', 'exclude');
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (/^\/?\.kurultay\/?$/m.test(cur)) return;
  mkdirSync(join(common.out, 'info'), { recursive: true });
  appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}.kurultay/\n`);
}

/** Commit everything in the worktree (so it can be merged). Returns false when there was nothing to commit. */
export function commitWorktree(wt: WorktreeInfo, message: string): boolean {
  if (!gitOk(wt.path, ['status', '--porcelain']).out) return false;
  const add = gitOk(wt.path, ['add', '-A']); // .kurultay/ is excluded via info/exclude
  if (!add.ok) throw new Error(add.out);
  const c = gitOk(wt.path, ['-c', 'user.name=Kurultay', '-c', 'user.email=kurultay@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message]);
  if (!c.ok) throw new Error(`commit failed: ${c.out}`);
  return true;
}

/** Diff of the worktree branch (committed + uncommitted) against where it started. */
export function worktreeDiff(root: string, wt: WorktreeInfo): string {
  const base = gitOk(root, ['merge-base', 'HEAD', wt.branch]).out;
  const committed = gitOk(wt.path, ['diff', base]).out;
  const untracked = gitOk(wt.path, ['ls-files', '--others', '--exclude-standard']).out;
  return committed + (untracked ? `\n# new untracked files:\n${untracked}` : '');
}

/** Merge the worktree branch into the main repository's current branch. */
export function mergeWorktree(root: string, wt: WorktreeInfo): { ok: boolean; output: string } {
  commitWorktree(wt, `kurultay: ${wt.slug}`);
  const r = gitOk(root, ['-c', 'user.name=Kurultay', '-c', 'user.email=kurultay@localhost', '-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-edit', wt.branch]);
  if (!r.ok) gitOk(root, ['merge', '--abort']);
  return { ok: r.ok, output: r.out };
}

export function removeWorktree(root: string, wt: WorktreeInfo, deleteBranch = true): void {
  const r = gitOk(root, ['worktree', 'remove', '--force', wt.path]);
  if (!r.ok) throw new Error(`git worktree remove failed: ${r.out}`);
  if (deleteBranch && wt.branch) gitOk(root, ['branch', '-D', wt.branch]);
}
