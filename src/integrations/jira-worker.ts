import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp, loadOrBuildIndex } from '../app.js';
import { kurultayHome, loadConfig, type GitLabConfig, type JiraConfig } from '../config.js';
import { Orchestrator, type RunReport } from '../orchestrator/orchestrator.js';
import { errorMessage, sleep } from '../util/async.js';
import { EventBus } from '../util/events.js';
import { branchName, GitRepo, openMergeRequest, repoSlug, type MergeRequest } from './gitlab.js';
import { JiraClient, repoFor, taskOf, type JiraIssue } from './jira.js';

/**
 * `kurultay jira`: the issues assigned to the user whose description mentions @kurultay are
 * done one after another – clone/update the repository, a branch per issue, the usual
 * Kurultay run, commit, push, merge request, and the merge request link as a comment on the
 * issue. With `watch` it looks again every few minutes (for a start-up entry on the PC).
 * An issue is done once; editing its description hands it over again (same branch, the
 * merge request is updated).
 */

export interface JiraRunOptions {
  /** Kurultay config file with the models, jira and gitlab (default: the normal lookup) */
  config?: string;
  watch?: boolean;
  /** minutes between two looks in watch mode (default jira.intervalMinutes, 5) */
  intervalMinutes?: number;
  /** only list what would be done */
  dryRun?: boolean;
  /** only this issue (e.g. ABC-123) */
  issue?: string;
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
  /** for tests */
  fetch?: typeof fetch;
  home?: string;
  run?: (root: string, task: string, signal?: AbortSignal) => Promise<Pick<RunReport, 'status' | 'changedFiles' | 'finalVerify' | 'reportPath'>>;
}

interface IssueState {
  hash: string;
  at: string;
  status: 'merge-request' | 'no-change' | 'failed' | 'no-repo';
  mr?: string;
  error?: string;
}

interface StateFile {
  issues: Record<string, IssueState>;
}

export interface JiraPassResult {
  seen: number;
  done: Array<{ key: string; status: IssueState['status']; mr?: string; error?: string }>;
}

const hashOf = (i: JiraIssue) => createHash('sha256').update(`${i.summary}\n${i.description}`).digest('hex').slice(0, 16);

export class JiraWorker {
  private readonly home: string;
  private readonly statePath: string;
  private readonly logPath: string;
  readonly jira: JiraConfig;
  readonly gitlab: GitLabConfig;
  private readonly client: JiraClient;

  constructor(private readonly opts: JiraRunOptions = {}) {
    this.home = opts.home ?? kurultayHome();
    mkdirSync(this.home, { recursive: true });
    this.statePath = join(this.home, 'jira-state.json');
    this.logPath = join(this.home, 'jira.log');
    const { config } = loadConfig(process.cwd(), opts.config);
    if (!config.jira?.url) throw new Error('no "jira" section in the configuration (url, username + password or token)');
    this.jira = config.jira;
    this.gitlab = config.gitlab ?? {};
    if (!this.gitlab.repo && !Object.keys(this.jira.repos ?? {}).length) throw new Error('no repository: set "gitlab.repo" (or jira.repos per project)');
    // a branch prefix git would refuse is reported at once, not on every issue
    branchName('ABC-1', this.gitlab.branchPrefix);
    this.client = new JiraClient(this.jira, opts.fetch);
  }

  private log(line: string): void {
    this.opts.onProgress?.(line);
    try {
      appendFileSync(this.logPath, `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* logging is best-effort */
    }
  }

  private state(): StateFile {
    try {
      return existsSync(this.statePath) ? (JSON.parse(readFileSync(this.statePath, 'utf8')) as StateFile) : { issues: {} };
    } catch {
      return { issues: {} };
    }
  }

  private save(key: string, s: IssueState): void {
    const st = this.state();
    st.issues[key] = s;
    writeFileSync(this.statePath, JSON.stringify(st, null, 2));
  }

  /** One look at Jira: every waiting issue, one after another. */
  async pass(): Promise<JiraPassResult> {
    const issues = (await this.client.pending()).filter((i) => !this.opts.issue || i.key === this.opts.issue);
    const state = this.state();
    const todo = issues.filter((i) => this.opts.issue || state.issues[i.key]?.hash !== hashOf(i));
    const out: JiraPassResult = { seen: issues.length, done: [] };
    if (todo.length) this.log(`jira: ${todo.length} issue(s) to do: ${todo.map((i) => i.key).join(', ')}`);
    for (const issue of todo) {
      if (this.opts.signal?.aborted) break;
      if (this.opts.dryRun) {
        this.log(`would do ${issue.key} "${issue.summary}" in ${repoFor(issue, this.jira.repos, this.gitlab.repo) ?? '(no repository)'}`);
        continue;
      }
      const r = await this.doIssue(issue);
      out.done.push({ key: issue.key, ...r });
    }
    return out;
  }

  private async doIssue(issue: JiraIssue): Promise<Pick<IssueState, 'status' | 'mr' | 'error'>> {
    const save = (s: Pick<IssueState, 'status' | 'mr' | 'error'>) => {
      this.save(issue.key, { hash: hashOf(issue), at: new Date().toISOString(), ...s });
      return s;
    };
    const url = repoFor(issue, this.jira.repos, this.gitlab.repo);
    if (!url) {
      this.log(`${issue.key}: no repository for project ${issue.project}`);
      await this.comment(issue, `Kurultay could not start: no repository is configured for project ${issue.project} (gitlab.repo or jira.repos in the Kurultay configuration, or a line "repo: <url>" in the description).`);
      return save({ status: 'no-repo' });
    }
    const dir = resolve(this.gitlab.workDir ?? join(this.home, 'jira-work'), repoSlug(url));
    const repo = new GitRepo(dir, this.gitlab);
    try {
      const branch = branchName(issue.key, this.gitlab.branchPrefix);
      this.log(`${issue.key}: "${issue.summary}" – ${url}, branch ${branch}`);
      const target = await repo.prepare(url, branch);
      const report = await (this.opts.run ?? this.runKurultay.bind(this))(dir, taskOf(issue, this.client.mention), this.opts.signal);
      const files = await repo.changed();
      const verify = report.finalVerify ? (report.finalVerify.skipped ? 'not run (no build/test commands)' : report.finalVerify.ok ? 'passed' : 'FAILED') : 'not run';
      if (!files.length) {
        this.log(`${issue.key}: no change (${report.status})`);
        await this.comment(issue, `Kurultay worked on this issue but produced no change (status: ${report.status}). Edit the description to hand it over again.`);
        return save({ status: 'no-change' });
      }
      await repo.commit(`${issue.key}: ${issue.summary}\n\n${issue.url}\nDone by Kurultay (${report.status}); build/tests: ${verify}.`);
      const description = `${issue.url}\n\n${issue.summary}\n\nDone by Kurultay – status: ${report.status}, build/tests: ${verify}.\n\nChanged files:\n${files.map((f) => `- ${f}`).join('\n')}`;
      const mr: MergeRequest | undefined = await openMergeRequest(repo, url, this.gitlab, { branch, target, title: `${issue.key}: ${issue.summary}`.slice(0, 250), description }, this.opts.fetch);
      const link = mr?.url ?? `branch ${branch} (the server did not return a merge request link)`;
      this.log(`${issue.key}: ${mr?.existed ? 'merge request updated' : 'merge request opened'}: ${link}`);
      await this.comment(
        issue,
        [
          `Kurultay ${mr?.existed ? 'updated the merge request' : 'opened a merge request'}: ${mr?.url ? `[${mr.url}|${mr.url}]` : link}`,
          `Branch: {{${branch}}} → {{${target}}}`,
          `Build/tests: ${verify} · status: ${report.status}`,
          `Changed files: ${files.slice(0, 20).map((f) => `{{${f}}}`).join(', ')}${files.length > 20 ? ` (+${files.length - 20})` : ''}`,
        ].join('\n'),
      );
      if (this.jira.transition && mr) {
        const moved = await this.client.transition(issue.key, this.jira.transition).catch(() => false);
        if (!moved) this.log(`${issue.key}: no transition "${this.jira.transition}" in its workflow`);
      }
      return save({ status: 'merge-request', mr: mr?.url });
    } catch (e) {
      const error = errorMessage(e).slice(0, 500);
      this.log(`${issue.key}: failed – ${error}`);
      await this.comment(issue, `Kurultay could not finish this issue: ${error}`);
      return save({ status: 'failed', error });
    }
  }

  private async comment(issue: JiraIssue, text: string): Promise<void> {
    if (this.jira.comment === false) return;
    try {
      await this.client.comment(issue.key, text);
    } catch (e) {
      this.log(`${issue.key}: could not write the comment – ${errorMessage(e)}`);
    }
  }

  private async runKurultay(root: string, task: string, signal?: AbortSignal) {
    const bus = new EventBus();
    bus.on('event', (e: { type: string; source?: string; message?: string }) => {
      if (e.type === 'log.warn' || e.type === 'run.plan' || e.type === 'run.end') this.log(`  ${e.source ?? e.type}: ${e.message ?? ''}`.trimEnd());
    });
    const app = await createApp({ root, config: this.opts.config, bus, requireModels: true });
    app.config.orchestrator.confirmMerge = false;
    const { index } = loadOrBuildIndex(app);
    return new Orchestrator(root, app.config, app.router, app.materializer, index, bus).run(task, { signal });
  }

  /** Look at Jira every few minutes until stopped; network or server errors only skip one round. */
  async watch(): Promise<void> {
    const minutes = this.opts.intervalMinutes ?? this.jira.intervalMinutes ?? 5;
    this.log(`jira: watching ${this.jira.url} every ${minutes} min for issues assigned to you that mention ${this.client.mention}`);
    while (!this.opts.signal?.aborted) {
      try {
        await this.pass();
      } catch (e) {
        this.log(`jira: ${errorMessage(e)} – trying again in ${minutes} min`);
      }
      await sleep(minutes * 60_000, this.opts.signal).catch(() => undefined);
    }
  }
}

/**
 * Start `kurultay jira --watch` when the user logs in: a .cmd in the Windows Startup folder,
 * an autostart entry on Linux desktops. Returns the file written (or removed).
 */
export function installStartup(opts: { remove?: boolean; node?: string; script?: string; config?: string; platform?: NodeJS.Platform; appData?: string; home?: string } = {}): { file: string; removed?: boolean } {
  const platform = opts.platform ?? process.platform;
  const node = opts.node ?? process.execPath;
  const script = opts.script ?? process.argv[1];
  const cfg = opts.config ? ` --config "${resolve(opts.config)}"` : '';
  const home = opts.home ?? process.env.HOME ?? process.env.USERPROFILE ?? '.';
  let file: string;
  let body: string;
  if (platform === 'win32') {
    const startup = join(opts.appData ?? process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    file = join(startup, 'kurultay-jira.cmd');
    body = `@echo off\r\nrem Kurultay: Jira issues that mention @kurultay (log: %USERPROFILE%\\.kurultay\\jira.log)\r\nstart "Kurultay Jira" /min "${node}" "${script}" jira --watch${cfg}\r\n`;
  } else {
    file = join(home, '.config', 'autostart', 'kurultay-jira.desktop');
    body = `[Desktop Entry]\nType=Application\nName=Kurultay Jira\nExec="${node}" "${script}" jira --watch${cfg}\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n`;
  }
  if (opts.remove) {
    rmSync(file, { force: true });
    return { file, removed: true };
  }
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, body);
  return { file };
}
