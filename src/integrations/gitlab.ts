import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GitLabConfig } from '../config.js';

/**
 * Git and GitLab for the Jira work: a clone per repository, a branch per issue, a commit,
 * a push and a merge request. Credentials never touch the disk or the remote URL: git gets
 * them from an inline credential helper that reads two environment variables of the child
 * process, and the API gets the token in a header.
 */

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {}

export class GitRepo {
  constructor(
    readonly dir: string,
    private readonly cfg: GitLabConfig = {},
  ) {}

  /** Environment and -c options that hand the configured credentials to git (nothing else is asked). */
  private auth(): { args: string[]; env: NodeJS.ProcessEnv } {
    const user = this.cfg.username ?? (this.cfg.token ? 'oauth2' : undefined);
    const pass = this.cfg.password ?? this.cfg.token;
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    if (!user || !pass) return { args: [], env };
    env.KURULTAY_GIT_USER = user;
    env.KURULTAY_GIT_PASS = pass;
    // an empty helper first drops the configured ones (Git Credential Manager would ask in a window)
    return { args: ['-c', 'credential.helper=', '-c', 'credential.helper=!f() { echo "username=$KURULTAY_GIT_USER"; echo "password=$KURULTAY_GIT_PASS"; }; f'], env };
  }

  git(args: string[], opts: { cwd?: string; allowFail?: boolean; timeoutMs?: number } = {}): Promise<GitResult> {
    const { args: pre, env } = this.auth();
    return new Promise((resolve, reject) => {
      execFile('git', [...pre, ...args], { cwd: opts.cwd ?? this.dir, env, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 10 * 60_000 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
        const r = { code, stdout: String(stdout), stderr: redact(String(stderr), env) };
        if (code && !opts.allowFail) reject(new GitError(`git ${args[0]} failed (${code}): ${r.stderr.trim().slice(0, 600)}`));
        else resolve(r);
      });
    });
  }

  /** Clone once, then fetch; afterwards the work tree is the target branch exactly as on the server. */
  async prepare(url: string, branch: string): Promise<string> {
    if (!existsSync(join(this.dir, '.git'))) {
      mkdirSync(this.dir, { recursive: true });
      await this.git(['clone', '--quiet', url, '.'], { timeoutMs: 30 * 60_000 });
    } else {
      await this.git(['remote', 'set-url', 'origin', url]);
      await this.git(['fetch', '--quiet', '--prune', 'origin'], { timeoutMs: 30 * 60_000 });
    }
    // Kurultay's state folder never goes into a commit
    const exclude = join(this.dir, '.git', 'info', 'exclude');
    if (!existsSync(exclude) || !readFileSync(exclude, 'utf8').includes('.kurultay')) {
      mkdirSync(join(this.dir, '.git', 'info'), { recursive: true });
      appendFileSync(exclude, '\n.kurultay/\n');
    }
    const target = this.cfg.targetBranch ?? (await this.defaultBranch());
    await this.git(['reset', '--quiet', '--hard']);
    await this.git(['clean', '-fdq', '-e', '.kurultay']);
    await this.git(['checkout', '--quiet', '-B', branch, `origin/${target}`]);
    return target;
  }

  async defaultBranch(): Promise<string> {
    const head = await this.git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { allowFail: true });
    const name = head.stdout.trim().replace(/^refs\/remotes\/origin\//, '');
    if (head.code === 0 && name) return name;
    for (const b of ['main', 'master', 'develop']) if ((await this.git(['rev-parse', '--verify', '--quiet', `origin/${b}`], { allowFail: true })).code === 0) return b;
    throw new GitError('cannot find the default branch of origin – set gitlab.targetBranch');
  }

  /** Files changed in the work tree (Kurultay's state excluded). */
  async changed(): Promise<string[]> {
    const r = await this.git(['status', '--porcelain', '--untracked-files=all']);
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3).replace(/^"|"$/g, ''))
      .filter((p) => !p.startsWith('.kurultay/'));
  }

  async commit(message: string): Promise<boolean> {
    await this.git(['add', '-A', '--', '.', ':(exclude).kurultay']);
    if ((await this.git(['diff', '--cached', '--quiet'], { allowFail: true })).code === 0) return false;
    const name = (await this.git(['config', 'user.name'], { allowFail: true })).stdout.trim() || 'Kurultay';
    const email = (await this.git(['config', 'user.email'], { allowFail: true })).stdout.trim() || 'kurultay@localhost';
    await this.git(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '--quiet', '-m', message]);
    return true;
  }

  /** Push the branch; `options` are git push options (GitLab creates the merge request from them). */
  async push(branch: string, options: string[] = []): Promise<GitResult> {
    return this.git(['push', '--force-with-lease', ...options.flatMap((o) => ['-o', o]), '-u', 'origin', branch], { timeoutMs: 30 * 60_000 });
  }
}

/** GitLab base URL and project path of a repository URL (HTTPS or SSH). */
export function projectOf(repoUrl: string, base?: string): { base: string; path: string } {
  const ssh = /^(?:ssh:\/\/)?(?:[^@/]+@)?([^:/]+)[:/](?:\d+\/)?(.+?)(?:\.git)?\/?$/.exec(repoUrl);
  if (!/^https?:\/\//i.test(repoUrl) && ssh) return { base: (base ?? `https://${ssh[1]}`).replace(/\/+$/, ''), path: ssh[2] };
  const u = new URL(repoUrl);
  const root = (base ?? `${u.protocol}//${u.host}`).replace(/\/+$/, '');
  const full = `${u.protocol}//${u.host}${u.pathname}`.replace(/\.git\/?$/, '').replace(/\/+$/, '');
  const path = full.startsWith(root) ? full.slice(root.length).replace(/^\/+/, '') : u.pathname.replace(/^\/+/, '').replace(/\.git\/?$/, '');
  return { base: root, path };
}

export interface MergeRequest {
  url: string;
  iid?: number;
  existed?: boolean;
}

/**
 * Open (or find) the merge request of a branch. With a token through the API; without one
 * the branch is pushed with GitLab push options, which open the merge request on the server.
 */
export async function openMergeRequest(
  repo: GitRepo,
  repoUrl: string,
  cfg: GitLabConfig,
  mr: { branch: string; target: string; title: string; description: string },
  doFetch: typeof fetch = fetch,
): Promise<MergeRequest | undefined> {
  if (!cfg.token) {
    const r = await repo.push(mr.branch, ['merge_request.create', `merge_request.target=${mr.target}`, `merge_request.title=${mr.title}`, `merge_request.description=${mr.description.slice(0, 2000)}`, 'merge_request.remove_source_branch']);
    const out = `${r.stdout}\n${r.stderr}`;
    const url = /(https?:\/\/\S+\/-\/merge_requests\/\d+)/.exec(out)?.[1] ?? /(https?:\/\/\S+merge_requests\/new\S*)/.exec(out)?.[1];
    return url ? { url } : undefined;
  }
  await repo.push(mr.branch);
  const { base, path } = projectOf(repoUrl, cfg.url);
  const api = `${base}/api/v4/projects/${encodeURIComponent(path)}/merge_requests`;
  const headers = { 'private-token': cfg.token, 'content-type': 'application/json', accept: 'application/json' };
  const r = await doFetch(api, {
    method: 'POST',
    headers,
    body: JSON.stringify({ source_branch: mr.branch, target_branch: mr.target, title: mr.title, description: mr.description, remove_source_branch: true }),
    signal: AbortSignal.timeout(60_000),
  });
  if (r.ok) {
    const j = (await r.json()) as { web_url: string; iid: number };
    return { url: j.web_url, iid: j.iid };
  }
  // 409: a merge request for this branch is already open – the push updated it
  if (r.status === 409) {
    const q = await doFetch(`${api}?state=opened&source_branch=${encodeURIComponent(mr.branch)}`, { headers, signal: AbortSignal.timeout(60_000) });
    const list = q.ok ? ((await q.json()) as Array<{ web_url: string; iid: number }>) : [];
    if (list[0]) return { url: list[0].web_url, iid: list[0].iid, existed: true };
  }
  throw new GitError(`gitlab: could not open the merge request: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
}

/** Never echo the password or token in an error message. */
function redact(text: string, env: NodeJS.ProcessEnv): string {
  let out = text;
  for (const v of [env.KURULTAY_GIT_PASS]) if (v && v.length > 3) out = out.split(v).join('***');
  return out;
}

/** A folder name for a repository URL. */
export function repoSlug(url: string): string {
  return url
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/\.git\/?$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 120);
}
