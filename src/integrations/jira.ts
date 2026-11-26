import type { JiraConfig } from '../config.js';

/**
 * Minimal Jira REST client (no dependencies): finds the issues assigned to the user that hand
 * work to Kurultay, writes comments and moves issues. Works with Jira Server / Data Center
 * (personal access token as Bearer, or user name + password) and Jira Cloud (e-mail + API
 * token). Uses REST API v2, whose description and comment fields are plain (wiki) text.
 */

export interface JiraIssue {
  key: string;
  project: string;
  summary: string;
  description: string;
  status: string;
  updated: string;
  url: string;
  /** comments, oldest first (Jira returns them with the issue) */
  comments?: JiraComment[];
}

export interface JiraComment {
  id: string;
  body: string;
  created: string;
  author?: string;
}

type RawIssue = {
  key: string;
  fields: {
    summary?: string;
    description?: string | null;
    status?: { name?: string };
    updated?: string;
    project?: { key?: string };
    comment?: { comments?: Array<{ id: string; body?: string; created?: string; author?: { displayName?: string; name?: string } }> };
  };
};

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

const FIELDS = 'summary,description,status,updated,project,comment';

export class JiraClient {
  private readonly base: string;

  constructor(
    private readonly cfg: JiraConfig,
    private readonly doFetch: Fetch = fetch,
  ) {
    this.base = cfg.url.replace(/\/+$/, '');
  }

  get mention(): string {
    return this.cfg.mention ?? '@kurultay';
  }

  get isCloud(): boolean {
    return /\.atlassian\.net$/i.test(new URL(this.base).hostname);
  }

  /** Authorization header: a token alone is a Bearer PAT; with a user name (Cloud e-mail) or a password it is Basic. */
  authHeader(): string {
    const { username, password, token } = this.cfg;
    if (token && !username) return `Bearer ${token}`;
    if (token && username) return this.isCloud ? `Basic ${b64(`${username}:${token}`)}` : `Bearer ${token}`;
    if (username && password) return `Basic ${b64(`${username}:${password}`)}`;
    throw new JiraError('jira: set "token" (personal access token / API token) or "username" and "password"');
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.doFetch(`${this.base}${path}`, {
      method,
      headers: { authorization: this.authHeader(), accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text();
    if (!r.ok) {
      const hint = r.status === 401 ? ' (check the user name / password or token)' : r.status === 403 ? ' (the account may lack the permission, or a CAPTCHA blocks password logins – use a personal access token)' : '';
      throw new JiraError(`jira ${method} ${path}: HTTP ${r.status}${hint}: ${text.slice(0, 300)}`, r.status);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** The query: assigned to the user, mention in the description, not done (the mention is checked again locally). */
  jql(): string {
    if (this.cfg.jql) return this.cfg.jql;
    // the text index drops "@", so the search looks for the bare word
    const word = this.mention.replace(/^@/, '').replace(/"/g, '');
    return `assignee = currentUser() AND description ~ "${word}" AND statusCategory != Done ORDER BY updated ASC`;
  }

  /** Issues to work on: every issue the query returns whose description really contains the mention. */
  async pending(max = 50): Promise<JiraIssue[]> {
    const q = `jql=${encodeURIComponent(this.jql())}&fields=${FIELDS}&maxResults=${max}`;
    type Raw = { issues?: RawIssue[] };
    let raw: Raw;
    try {
      // Cloud replaced /search with /search/jql; Server / Data Center only has /search
      raw = await this.call<Raw>('GET', `/rest/api/2/${this.isCloud ? 'search/jql' : 'search'}?${q}`);
    } catch (e) {
      if (!(e instanceof JiraError) || (e.status !== 404 && e.status !== 410)) throw e;
      raw = await this.call<Raw>('GET', `/rest/api/2/${this.isCloud ? 'search' : 'search/jql'}?${q}`);
    }
    const mention = this.mention.toLowerCase();
    return (raw.issues ?? []).map((i) => this.toIssue(i)).filter((i) => i.description.toLowerCase().includes(mention));
  }

  /** One issue as it is now (summary, description, status, comments). */
  async issue(key: string): Promise<JiraIssue> {
    return this.toIssue(await this.call<RawIssue>('GET', `/rest/api/2/issue/${encodeURIComponent(key)}?fields=${FIELDS}`));
  }

  private toIssue(i: RawIssue): JiraIssue {
    return {
      key: i.key,
      project: i.fields.project?.key ?? i.key.split('-')[0],
      summary: i.fields.summary ?? '',
      description: typeof i.fields.description === 'string' ? i.fields.description : '',
      status: i.fields.status?.name ?? '',
      updated: i.fields.updated ?? '',
      url: `${this.base}/browse/${i.key}`,
      comments: (i.fields.comment?.comments ?? []).map((c) => ({ id: String(c.id), body: c.body ?? '', created: c.created ?? '', author: c.author?.displayName ?? c.author?.name })),
    };
  }

  /** Version and kind of the server (works without a login on most servers). */
  serverInfo(): Promise<{ version?: string; deploymentType?: string; serverTitle?: string }> {
    return this.call('GET', '/rest/api/2/serverInfo');
  }

  /** The user the token or password belongs to (fails with 401 when the credentials are wrong). */
  myself(): Promise<{ name?: string; displayName?: string; emailAddress?: string }> {
    return this.call('GET', '/rest/api/2/myself');
  }

  /** Write a comment; returns its id. */
  async comment(key: string, text: string): Promise<string | undefined> {
    const r = await this.call<{ id?: string | number }>('POST', `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { body: text });
    return r.id === undefined ? undefined : String(r.id);
  }

  /** Move the issue to the status (or transition) with this name; false when the workflow has none. */
  async transition(key: string, name: string): Promise<boolean> {
    const r = await this.call<{ transitions?: Array<{ id: string; name: string; to?: { name?: string } }> }>('GET', `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`);
    const want = name.toLowerCase();
    const t = r.transitions?.find((x) => x.name.toLowerCase() === want || x.to?.name?.toLowerCase() === want);
    if (!t) return false;
    await this.call('POST', `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: t.id } });
    return true;
  }
}

/**
 * The repository of an issue: a "repo: <url>" line in the description, else the project's
 * entry in jira.repos, else its "*" entry, else gitlab.repo.
 */
export function repoFor(issue: JiraIssue, repos: Record<string, string> = {}, fallback?: string): string | undefined {
  const own = /(?:^|\n)\s*repo\s*[:=]\s*(\S+)/i.exec(issue.description)?.[1];
  return own ?? repos[issue.project] ?? repos[issue.project.toUpperCase()] ?? repos['*'] ?? fallback;
}

/** The task Kurultay gets: summary and description, without the mention and the repo line. */
export function taskOf(issue: JiraIssue, mention: string): string {
  const esc = mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = issue.description
    .replace(new RegExp(esc, 'gi'), '')
    .replace(/(?:^|\n)\s*repo\s*[:=]\s*\S+/gi, '');
  // Jira wiki markup that only gets in the way
  return `${issue.key}: ${issue.summary}\n\n${cleanWiki(body).trim()}`.trim();
}

/** The text of an @kurultay comment without the mention (undefined: not for Kurultay). */
export function requestOf(comment: JiraComment, mention: string): string | undefined {
  if (!comment.body.toLowerCase().includes(mention.toLowerCase())) return undefined;
  return cleanWiki(comment.body.replace(new RegExp(mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '')).trim() || undefined;
}

/**
 * What changed between two versions of a description, line by line: the lines that are new
 * and the ones that are gone (order kept, Jira wiki markup made plain).
 */
export function descriptionChange(before: string, after: string): { added: string[]; removed: string[] } {
  const lines = (t: string) => cleanWiki(t).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  // the lines of xs that ys does not have (as often as they occur)
  const minus = (xs: string[], ys: string[]) => {
    const left = ys.reduce((m, y) => m.set(y, (m.get(y) ?? 0) + 1), new Map<string, number>());
    return xs.filter((x) => {
      const n = left.get(x) ?? 0;
      if (n) left.set(x, n - 1);
      return !n;
    });
  };
  const a = lines(before);
  const b = lines(after);
  return { added: minus(b, a), removed: minus(a, b) };
}

function cleanWiki(t: string): string {
  return t.replace(/\{code(?::[^}]*)?\}/g, '```').replace(/\{noformat\}/g, '```');
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}
