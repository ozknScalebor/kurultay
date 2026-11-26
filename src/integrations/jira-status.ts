import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kurultayHome, type KurultayConfig } from '../config.js';
import { errorMessage } from '../util/async.js';
import { branchName, projectOf } from './gitlab.js';
import { JiraClient } from './jira.js';
import { startupFile } from './jira-worker.js';

/**
 * What the console shows about the Jira work on start: can Jira be reached and with which user,
 * how many issues wait, which GitLab answers, is the start-up entry installed, what happened last.
 */
export interface JiraStatus {
  url: string;
  ok: boolean;
  /** "Jira 8.20.4 (Server)" */
  server?: string;
  /** the user the token / password belongs to */
  user?: string;
  /** issues assigned to the user that mention @kurultay and are not done */
  pending?: number;
  error?: string;
  ms: number;
  gitlab?: { repo?: string; ok?: boolean; version?: string; error?: string; branch?: string; target?: string };
  startup: boolean;
  /** last line of ~/.kurultay/jira.log */
  lastLog?: string;
}

export async function jiraStatus(config: KurultayConfig, opts: { timeoutMs?: number; fetch?: typeof fetch; home?: string; platform?: NodeJS.Platform } = {}): Promise<JiraStatus | undefined> {
  const jira = config.jira;
  if (!jira?.url) return undefined;
  const doFetch = opts.fetch ?? fetch;
  const timeout = opts.timeoutMs ?? 6000;
  const t0 = Date.now();
  const st: JiraStatus = { url: jira.url, ok: false, ms: 0, startup: existsSync(startupFile({ platform: opts.platform })) };
  const client = new JiraClient(jira, (u, init) => doFetch(u, { ...init, signal: AbortSignal.timeout(timeout) }));
  try {
    const [info, me] = await Promise.all([client.serverInfo(), client.myself()]);
    st.server = `Jira ${info.version ?? '?'}${info.deploymentType ? ` (${info.deploymentType})` : ''}`;
    st.user = me.displayName ?? me.name ?? me.emailAddress;
    st.pending = (await client.pending()).length;
    st.ok = true;
  } catch (e) {
    st.error = /abort|timeout/i.test(errorMessage(e)) ? `no answer within ${timeout / 1000} s` : errorMessage(e).replace(/^jira GET \S+: /, '');
  }
  st.ms = Date.now() - t0;
  const gl = config.gitlab ?? {};
  if (gl.repo || Object.keys(jira.repos ?? {}).length) {
    st.gitlab = { repo: gl.repo, target: gl.targetBranch ?? 'default branch' };
    try {
      st.gitlab.branch = branchName('ABC-12', gl.branchPrefix);
    } catch (e) {
      st.gitlab.error = errorMessage(e);
    }
    if (gl.repo && gl.token && !st.gitlab.error) {
      try {
        const { base } = projectOf(gl.repo, gl.url);
        const r = await doFetch(`${base}/api/v4/version`, { headers: { 'private-token': gl.token, accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
        if (r.ok) {
          st.gitlab.ok = true;
          st.gitlab.version = ((await r.json()) as { version?: string }).version;
        } else st.gitlab.error = `HTTP ${r.status}${r.status === 401 ? ' (check gitlab.token)' : ''}`;
      } catch (e) {
        st.gitlab.error = /abort|timeout/i.test(errorMessage(e)) ? `no answer within ${timeout / 1000} s` : errorMessage(e);
      }
    }
  }
  try {
    const log = join(opts.home ?? kurultayHome(), 'jira.log');
    if (existsSync(log)) st.lastLog = readFileSync(log, 'utf8').trimEnd().split('\n').pop();
  } catch {
    /* no log yet */
  }
  return st;
}
