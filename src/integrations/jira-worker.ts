import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Inbox, type WorkSnapshot } from '../agent/inbox.js';
import { safeRelPath } from '../agent/workspace.js';
import { createApp, loadOrBuildIndex } from '../app.js';
import { kurultayHome, loadConfig, type GitLabConfig, type JiraConfig } from '../config.js';
import { LlmError } from '../llm/types.js';
import { Orchestrator, type RunReport } from '../orchestrator/orchestrator.js';
import { copySharedState } from '../tui/worktree.js';
import { errorMessage, sleep } from '../util/async.js';
import { plural } from '../util/text.js';
import { EventBus, type KEvent } from '../util/events.js';
import { branchName, GitRepo, openMergeRequest, projectOf, repoSlug, type MergeRequest } from './gitlab.js';
import { filesToSummarise, ProjectAnalyzer } from '../analyze/summarizer.js';
import { ProjectIndex } from '../index/project-index.js';
import { runProbe } from '../probe/profile.js';
import { SkillRegistry } from '../skills/skills.js';
import { plainLine, RunNarrator, type JiraLineKind } from './jira-progress.js';
import { descriptionChange, JiraClient, repoFor, requestOf, taskOf, type JiraComment, type JiraIssue } from './jira.js';

/**
 * `kurultay jira`: the issues assigned to the user whose description mentions @kurultay are
 * done one after another – the repository is cloned once, every issue gets a work tree of its
 * own on its branch, the usual Kurultay run, commit, push, merge request, and the merge
 * request link as a comment on the issue. With `watch` it looks again every few minutes.
 *
 * While an issue is being worked on, Jira is asked every jira.pollSeconds whether its
 * description changed or a new comment mentions @kurultay; the change goes to the running
 * agent at once. After the merge request, the same two ways ask for more: the work goes on on
 * the issue's branch and the merge request is updated. When no model answers, Kurultay keeps
 * trying for jira.maxWaitMinutes, then comments, moves on and comes back to the issue later –
 * from where it stopped (its work tree, the files written so far and the todo list are kept).
 */

/** What a run gets from the Jira worker. */
export interface IssueRunContext {
  signal: AbortSignal;
  /** changes of the issue while the run is going */
  inbox: Inbox;
  /** progress after every agent step */
  onCheckpoint: (s: WorkSnapshot) => void;
  /** the run tells how to find out since when no model has answered */
  watchOutage: (since: () => number | undefined) => void;
  /** keep trying this long when no model answers */
  maxWaitMs: number;
  /** longest pause between two tries */
  retryMs: number;
  /** the repository's shared clone (at the target branch) and its project folder: the analysis is made there */
  project?: { clone: string; dir: string; target: string };
}

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
  /** every line of progress, with its kind (heading, step, warning…) for the display */
  onProgress?: (line: string, kind: JiraLineKind) => void;
  /** the events of the run (the console shows them in its live activity block) */
  events?: (e: KEvent) => void;
  signal?: AbortSignal;
  /** for tests */
  fetch?: typeof fetch;
  home?: string;
  run?: (root: string, task: string, ctx: IssueRunContext) => Promise<Pick<RunReport, 'status' | 'changedFiles' | 'finalVerify' | 'reportPath'>>;
}

type Status = 'merge-request' | 'no-change' | 'failed' | 'no-repo' | 'working' | 'waiting';

interface IssueState {
  hash: string;
  at: string;
  status: Status;
  mr?: string;
  error?: string;
  /** the description the work so far follows */
  description?: string;
  summary?: string;
  /** newest comment already handed over */
  lastComment?: string;
  /** comments Kurultay wrote (never read as requests) */
  own?: string[];
  /** requests of the unfinished work (follow-ups, changes) – kept across interruptions */
  requests?: string[];
  /** why the last attempt stopped (shown when it goes on) */
  stopped?: string;
  /** the "no model answers" comment was written for this pause */
  notified?: boolean;
}

interface StateFile {
  issues: Record<string, IssueState>;
}

export interface JiraPassResult {
  seen: number;
  done: Array<{ key: string; status: Status; mr?: string; error?: string }>;
}

/** No model answered for jira.maxWaitMinutes. */
export class ModelsDownError extends Error {}

const hashOf = (i: JiraIssue) => createHash('sha256').update(`${i.summary}\n${i.description}`).digest('hex').slice(0, 16);

/** Jira comment ids are numbers that grow; anything else is compared as text. */
const newer = (id: string, than?: string) => (than === undefined ? true : /^\d+$/.test(id) && /^\d+$/.test(than) ? Number(id) > Number(than) : id > than);

/** Errors that mean "the models are not answering" rather than "this issue cannot be done". */
function isOutage(e: unknown): boolean {
  if (e instanceof ModelsDownError) return true;
  if (!(e instanceof LlmError)) return false;
  return ['network', 'timeout', 'server', 'rate_limit', 'circuit_open'].includes(e.kind) || /No registered model|No suitable model/.test(e.message);
}

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
    // without gitlab.repo or jira.repos every issue names its repository: @kurultay{repo: <url>}
    // a branch prefix git would refuse is reported at once, not on every issue
    branchName('ABC-1', this.gitlab.branchPrefix);
    this.client = new JiraClient(this.jira, opts.fetch);
  }

  private get maxWaitMs(): number {
    return (this.jira.maxWaitMinutes ?? 120) * 60_000;
  }

  private get retryMs(): number {
    return (this.jira.retryMinutes ?? 5) * 60_000;
  }

  private get pollMs(): number {
    return Math.max(10, (this.jira.pollSeconds ?? 30) * 1000);
  }

  /** the issue being worked on: the log file names it on every line */
  private current: string | undefined;
  /** the models without a profile were measured (once per worker) */
  private probed = false;
  /** project folders analysed in this pass (several issues of one repository: once) */
  private readonly analysed = new Set<string>();

  private log(line: string, kind: JiraLineKind = 'plain'): void {
    this.opts.onProgress?.(line, kind);
    try {
      appendFileSync(this.logPath, `${new Date().toISOString()} ${this.current && kind !== 'issue' ? `${this.current}: ` : ''}${plainLine(line, kind)}\n`);
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

  private progressPath(key: string): string {
    return join(this.home, 'jira-progress', `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  }

  /** The @kurultay comments that came after the last one handed over. */
  private newRequests(issue: JiraIssue, st?: IssueState): JiraComment[] {
    const own = new Set(st?.own ?? []);
    return (issue.comments ?? []).filter((c) => !own.has(c.id) && newer(c.id, st?.lastComment) && requestOf(c, this.client.mention));
  }

  /** Why an issue needs work now (undefined: it does not). */
  private reason(issue: JiraIssue, st?: IssueState): string | undefined {
    if (!st) return 'new';
    if (st.status === 'working' || st.status === 'waiting') return 'unfinished – goes on from where it stopped';
    if (st.hash !== hashOf(issue)) return 'description changed';
    if (this.newRequests(issue, st).length) return 'new comment';
    return undefined;
  }

  /** One look at Jira: every waiting issue, one after another. */
  async pass(): Promise<JiraPassResult> {
    this.analysed.clear();
    const issues = (await this.client.pending()).filter((i) => !this.opts.issue || i.key === this.opts.issue);
    const state = this.state();
    const todo = issues.map((i) => ({ issue: i, why: this.opts.issue ? 'asked for' : this.reason(i, state.issues[i.key]) })).filter((x) => x.why);
    const out: JiraPassResult = { seen: issues.length, done: [] };
    if (todo.length) this.log(`${plural(todo.length, 'issue')} to do: ${todo.map((x) => `${x.issue.key} (${x.why})`).join(', ')}`, 'pass');
    for (const { issue } of todo) {
      if (this.opts.signal?.aborted) break;
      if (this.opts.dryRun) {
        this.log(`${issue.key}\t${issue.summary} – in ${repoFor(issue, this.jira.repos, this.gitlab.repo, this.client.mention) ?? '(no repository)'}`, 'info');
        continue;
      }
      this.current = issue.key;
      try {
        const r = await this.doIssue(issue);
        out.done.push({ key: issue.key, ...r });
      } finally {
        this.current = undefined;
      }
    }
    return out;
  }

  private async doIssue(issue: JiraIssue): Promise<Pick<IssueState, 'status' | 'mr' | 'error'>> {
    const prev = this.state().issues[issue.key];
    const resuming = prev?.status === 'working' || prev?.status === 'waiting';
    const cur: IssueState = {
      ...prev,
      hash: hashOf(issue),
      at: new Date().toISOString(),
      status: 'working',
      description: issue.description,
      summary: issue.summary,
      own: prev?.own ?? [],
      requests: resuming ? [...(prev.requests ?? [])] : [],
    };
    const write = (s: Partial<IssueState>) => {
      Object.assign(cur, s, { at: new Date().toISOString() });
      this.save(issue.key, cur);
    };
    const finish = (s: Pick<IssueState, 'status' | 'mr' | 'error'>) => {
      write({ ...s, requests: s.status === 'failed' ? cur.requests : [], stopped: undefined, notified: s.status === 'failed' ? cur.notified : false });
      return s;
    };
    this.log(`${issue.key}\t${issue.summary}`, 'issue');
    const url = repoFor(issue, this.jira.repos, this.gitlab.repo, this.client.mention);
    if (!url) {
      this.log(`no repository for project ${issue.project}`, 'fail');
      await this.comment(issue, cur, `Kurultay could not start: no repository is configured for project ${issue.project} (write it with the mention in the description: @kurultay{repo:<url>}, or set gitlab.repo / jira.repos in the Kurultay configuration).`);
      return finish({ status: 'no-repo' });
    }
    const slug = repoSlug(url);
    const work = resolve(this.gitlab.workDir ?? join(this.home, 'jira-work'));
    const shared = new GitRepo(join(work, slug), this.gitlab);
    const project = projectFolder(url, this.home);
    const treeDir = join(work, `${slug}.issues`, issue.key.replace(/[^A-Za-z0-9._-]/g, '_'));
    try {
      const branch = branchName(issue.key, this.gitlab.branchPrefix);
      await shared.sync(url);
      const { tree, target, continued, submodules } = await shared.issueTree(treeDir, branch, resuming);
      this.log(`repo\t${url}`, 'info');
      this.log(`branch\t${branch} → ${target}${continued ? ' (goes on from the server)' : ' (new)'}`, 'info');
      if (submodules.paths.length) {
        if (submodules.error) this.log(`submodules could not all be fetched (${submodules.error}) – the work goes on without them`, 'warn');
        else this.log(`submods\t${submodules.paths.join(', ')}`, 'info');
      }
      // the project folder of the repository: index, analysis, skills and rules – made from the
      // shared clone at the target branch, used by every issue of the repository
      mkdirSync(join(project, 'skills'), { recursive: true });
      copySharedState(project, join(treeDir, '.kurultay'));
      this.log(`project\t${project}`, 'info');
      // the skills of this repository (its own folders and the project folder); user-wide ones apply too but are not listed
      const skills = SkillRegistry.discover(treeDir, { includeUser: false }).visible();
      if (skills.length) this.log(`skills\t${skills.map((x) => x.name).join(', ')}`, 'info');

      // what to do: the issue, plus what came since Kurultay last worked on it
      const known = prev?.description !== undefined && continued;
      if (known && prev.description !== issue.description) cur.requests!.push(changeText(prev.description ?? '', issue.description, this.client.mention));
      else if (known && prev.summary !== issue.summary) cur.requests!.push(`The summary is now: ${issue.summary}`);
      const comments = this.newRequests(issue, prev);
      for (const c of comments) cur.requests!.push(commentText(c, this.client.mention));
      if (comments.length) cur.lastComment = comments[comments.length - 1].id;
      else cur.lastComment = (issue.comments ?? []).map((c) => c.id).reduce<string | undefined>((m, id) => (newer(id, m) ? id : m), prev?.lastComment);
      const progress = resuming ? this.restore(issue.key, treeDir) : undefined;
      let task = taskText(issue, this.client.mention, { followUp: known, requests: cur.requests!, resume: progress, stopped: prev?.stopped });
      write({});
      if (resuming) this.log(`resume\tthe interrupted work goes on${prev?.stopped ? ` (it stopped: ${prev.stopped})` : ''}`, 'info');
      for (const r of cur.requests!) this.log(`request\t${firstLine(r)}`, 'info');

      const report = await this.runWatched(issue, cur, tree.dir, task, write, (t) => (task = t), { clone: shared.dir, dir: project, target });
      // changes inside a submodule belong to its own repository: they are not committed here
      const inSub = (f: string) => submodules.paths.some((p) => f === p || f.startsWith(`${p}/`));
      const all = await tree.changed();
      const files = all.filter((f) => !inSub(f));
      const subChanged = submodules.paths.filter((p) => all.some((f) => f === p || f.startsWith(`${p}/`)));
      if (subChanged.length) this.log(`changes inside the submodule(s) ${subChanged.join(', ')} are not committed – Kurultay commits to ${slug} only`, 'warn');
      const verify = report.finalVerify ? (report.finalVerify.skipped ? 'not run (no build/test commands)' : report.finalVerify.ok ? 'passed' : 'FAILED') : 'not run';
      const asked = cur.requests!.length ? cur.requests! : undefined;
      if (!files.length) {
        this.log(`no change (status ${report.status}) – nothing to commit`, 'warn');
        await this.comment(issue, cur, `Kurultay worked on this ${asked ? 'request' : 'issue'} but produced no change (status: ${report.status}). Edit the description, or write a comment with ${this.client.mention}, to hand it over again.`);
        rmSync(this.progressPath(issue.key), { force: true });
        return finish({ status: 'no-change' });
      }
      await tree.commit(`${issue.key}: ${issue.summary}\n\n${issue.url}\n${asked ? `Follow-up: ${firstLine(asked[asked.length - 1])}\n` : ''}Done by Kurultay (${report.status}); build/tests: ${verify}.`, submodules.paths);
      const description = `${issue.url}\n\n${issue.summary}\n\nDone by Kurultay – status: ${report.status}, build/tests: ${verify}.\n\nChanged files:\n${files.map((f) => `- ${f}`).join('\n')}`;
      const mr: MergeRequest | undefined = await openMergeRequest(tree, url, this.gitlab, { branch, target, title: `${issue.key}: ${issue.summary}`.slice(0, 250), description }, this.opts.fetch);
      const link = mr?.url ?? `branch ${branch} (the server did not return a merge request link)`;
      rmSync(this.progressPath(issue.key), { force: true });
      this.log(`${mr?.existed ? 'merge request updated' : 'merge request opened'}: ${link}`, 'ok');
      await this.comment(
        issue,
        cur,
        [
          `Kurultay ${mr?.existed ? 'updated the merge request' : 'opened a merge request'}: ${mr?.url ? `[${mr.url}|${mr.url}]` : link}`,
          ...(asked ? [`Done on request: ${asked.map((r) => firstLine(r)).join(' · ').slice(0, 400)}`] : []),
          `Branch: {{${branch}}} → {{${target}}}`,
          `Build/tests: ${verify} · status: ${report.status}`,
          `Changed files: ${files.slice(0, 20).map((f) => `{{${f}}}`).join(', ')}${files.length > 20 ? ` (+${files.length - 20})` : ''}`,
        ].join('\n'),
      );
      if (this.jira.transition && mr) {
        const moved = await this.client.transition(issue.key, this.jira.transition).catch(() => false);
        if (!moved) this.log(`no transition "${this.jira.transition}" in its workflow`, 'warn');
      }
      return finish({ status: 'merge-request', mr: mr?.url ?? cur.mr });
    } catch (e) {
      const error = errorMessage(e).slice(0, 500);
      if (isOutage(e) && !this.opts.signal?.aborted) {
        const wait = fmtWait(this.maxWaitMs);
        this.log(`no model answered for ${wait} – paused; the next issue goes on, this one continues later from where it stopped`, 'warn');
        if (!cur.notified) await this.comment(issue, cur, `Kurultay paused this issue: no model has answered for ${wait} (${error}). The work so far is kept; Kurultay keeps trying and goes on from where it stopped.`);
        write({ status: 'waiting', error, stopped: `no model answered for ${wait}`, notified: true });
        return { status: 'waiting', error };
      }
      if (this.opts.signal?.aborted) {
        // stopped from outside (Ctrl+C, shutdown): the next start goes on from here
        write({ status: 'working', stopped: 'Kurultay was stopped' });
        return { status: 'working', error };
      }
      this.log(`failed – ${error}`, 'fail');
      await this.comment(issue, cur, `Kurultay could not finish this issue: ${error}`);
      return finish({ status: 'failed', error });
    }
  }

  /**
   * The run, with Jira watched alongside: every pollSeconds the issue is read again and a
   * changed description or a new @kurultay comment goes to the running agent; a run that ends
   * before an agent could read it is followed by one more run for it. No model answering for
   * maxWaitMinutes stops the run (ModelsDownError).
   */
  private async runWatched(issue: JiraIssue, cur: IssueState, root: string, task: string, write: (s: Partial<IssueState>) => void, setTask: (t: string) => void, project?: IssueRunContext['project']) {
    const inbox = new Inbox();
    const ctl = new AbortController();
    const stop = () => ctl.abort(this.opts.signal?.reason ?? new Error('stopped'));
    this.opts.signal?.addEventListener('abort', stop, { once: true });
    let outage: () => number | undefined = () => undefined;
    let polling = false;
    const progressFile = this.progressPath(issue.key);
    const poll = async () => {
      const since = outage();
      if (since !== undefined && Date.now() - since >= this.maxWaitMs) {
        ctl.abort(new ModelsDownError(`no model has answered since ${new Date(since).toISOString()}`));
        return;
      }
      if (polling) return;
      polling = true;
      try {
        const now = await this.client.issue(issue.key);
        const msgs: string[] = [];
        if (now.description !== cur.description) msgs.push(changeText(cur.description ?? '', now.description, this.client.mention));
        else if (now.summary !== cur.summary) msgs.push(`The summary is now: ${now.summary}`);
        const comments = this.newRequests(now, cur);
        msgs.push(...comments.map((c) => commentText(c, this.client.mention)));
        if (msgs.length) {
          for (const m of msgs) inbox.post(m);
          this.log(`the issue changed while working – ${msgs.map(firstLine).join(' · ').slice(0, 200)}`, 'change');
          write({ description: now.description, summary: now.summary, hash: hashOf(now), requests: [...(cur.requests ?? []), ...msgs], ...(comments.length ? { lastComment: comments[comments.length - 1].id } : {}) });
        }
      } catch (e) {
        this.log(`could not read the issue (${errorMessage(e)}); trying again in ${Math.round(this.pollMs / 1000)} s`, 'warn');
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void poll(), this.pollMs);
    timer.unref?.();
    const ctx: IssueRunContext = {
      signal: ctl.signal,
      inbox,
      onCheckpoint: (snap) => {
        try {
          mkdirSync(dirname(progressFile), { recursive: true });
          writeFileSync(progressFile, JSON.stringify({ ...snap, at: new Date().toISOString() }));
        } catch {
          /* best effort */
        }
      },
      watchOutage: (fn) => (outage = fn),
      maxWaitMs: this.maxWaitMs,
      retryMs: this.retryMs,
      project,
    };
    try {
      let report = await (this.opts.run ?? this.runKurultay.bind(this))(root, task, ctx);
      // changes that came when no agent was running any more: one more run for them (at most 3)
      for (let round = 0; round < 3 && !ctl.signal.aborted; round++) {
        await poll();
        const unread = inbox.unread();
        if (!unread.length) break;
        inbox.clear();
        task = `${taskOf({ ...issue, description: cur.description ?? issue.description, summary: cur.summary ?? issue.summary }, this.client.mention)}\n\n# New request\nThe work done so far is already in the work tree. The request changed while it was being done – do this now, on top of it:\n\n${unread.join('\n\n---\n\n')}`;
        setTask(task);
        this.log('one more run for the change that came at the end', 'change');
        report = await (this.opts.run ?? this.runKurultay.bind(this))(root, task, ctx);
      }
      if (ctl.signal.aborted) throw ctl.signal.reason;
      return report;
    } catch (e) {
      throw ctl.signal.aborted ? (ctl.signal.reason ?? e) : e;
    } finally {
      clearInterval(timer);
      this.opts.signal?.removeEventListener('abort', stop);
    }
  }

  /** Put the files of an interrupted run back into the work tree; returns what it had done. */
  private restore(key: string, root: string): WorkSnapshot | undefined {
    const file = this.progressPath(key);
    if (!existsSync(file)) return undefined;
    try {
      const snap = JSON.parse(readFileSync(file, 'utf8')) as WorkSnapshot;
      for (const [p, content] of Object.entries(snap.files ?? {})) {
        const abs = join(root, safeRelPath(root, p));
        if (content === null) rmSync(abs, { force: true });
        else {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, content);
        }
      }
      this.log(`resume\t${plural(Object.keys(snap.files ?? {}).length, 'file')} of the interrupted work put back`, 'info');
      return snap;
    } catch (e) {
      this.log(`could not read the saved progress (${errorMessage(e)}); the work tree is used as it is`, 'warn');
      return undefined;
    }
  }

  private async comment(issue: JiraIssue, cur: IssueState, text: string): Promise<void> {
    if (this.jira.comment === false) return;
    try {
      const id = await this.client.comment(issue.key, text);
      if (id) {
        cur.own = [...(cur.own ?? []), id].slice(-50);
        this.save(issue.key, cur);
      }
    } catch (e) {
      this.log(`could not write the comment – ${errorMessage(e)}`, 'warn');
    }
  }

  private async runKurultay(root: string, task: string, ctx: IssueRunContext) {
    const bus = new EventBus();
    // every agent step as one line; a line after a quiet minute says what it waits for
    const narrator = new RunNarrator((text, kind) => this.log(text, kind));
    bus.on('event', (e: KEvent) => {
      narrator.onEvent(e);
      this.opts.events?.(e);
    });
    const beat = setInterval(() => narrator.heartbeat(), 5000);
    beat.unref?.();
    try {
      return await this.orchestrate(root, task, ctx, bus);
    } finally {
      clearInterval(beat);
    }
  }

  private async orchestrate(root: string, task: string, ctx: IssueRunContext, bus: EventBus) {
    const started = Date.now();
    let app = await createApp({ root, config: this.opts.config, bus, requireModels: true });
    // no model could be found at all: try again every few minutes, as long as models may answer late
    while (app.router.size === 0) {
      if (Date.now() - started >= ctx.maxWaitMs) throw new ModelsDownError('no model could be reached');
      this.log(`no model could be reached – trying again in ${fmtWait(ctx.retryMs)}`, 'warn');
      await sleep(Math.min(ctx.retryMs, Math.max(1000, ctx.maxWaitMs - (Date.now() - started))), ctx.signal);
      app = await createApp({ root, config: this.opts.config, bus, requireModels: true });
    }
    // models without a capability profile are measured once (the profile is per user, kept)
    if (!this.probed) {
      this.probed = true;
      const run = await runProbe(app.config, bus, { scope: 'missing', signal: ctx.signal }).catch((e: unknown) => {
        if (ctx.signal.aborted) throw e;
        this.log(`the capability probe failed (${errorMessage(e)}) – going on with what is known`, 'warn');
        return undefined;
      });
      if (run) {
        this.log(`models\t${plural(run.measured.models.length, 'model')} measured once: ${run.measured.models.map((m) => m.key.split('@')[0]).join(', ')}`, 'info');
        app = await createApp({ root, config: this.opts.config, bus, requireModels: true });
      }
    }
    // the router waits instead of giving up; the Jira worker decides when it is enough
    app.router.recoveryWaitMs = ctx.maxWaitMs + 10 * 60_000;
    app.router.recoveryMaxIntervalMs = ctx.retryMs;
    ctx.watchOutage(() => app.router.outageSince);
    app.config.orchestrator.confirmMerge = false;
    if (ctx.project) {
      await this.analyseProject(ctx.project, app, bus, ctx.signal);
      // the issue's work tree starts from the project's index and analysis (its own changes are indexed on top)
      copySharedState(ctx.project.dir, join(root, app.config.stateDir));
    }
    const { index } = loadOrBuildIndex(app);
    return new Orchestrator(root, app.config, app.router, app.materializer, index, bus).run(task, { signal: ctx.signal, inbox: ctx.inbox, onCheckpoint: ctx.onCheckpoint });
  }

  /**
   * The repository's analysis, made in its shared clone at the target branch and kept in the
   * project folder: the first issue analyses the project; later issues fetch, and the files that
   * changed on the target branch since are summarised again (many changed files – jira.
   * reanalyzeFiles, default 30 – bring the whole architecture analysis up to date). The changes
   * of an issue's own branch never go into it.
   */
  private async analyseProject(p: NonNullable<IssueRunContext['project']>, app: Awaited<ReturnType<typeof createApp>>, bus: EventBus, signal: AbortSignal): Promise<void> {
    if (this.jira.analyze === false) return;
    if (this.analysed.has(p.dir)) return;
    const clone = new GitRepo(p.clone, this.gitlab);
    await clone.git(['checkout', '--quiet', '--detach', `origin/${p.target}`]);
    await clone.submodules();
    const cfg = app.config.index;
    const index = ProjectIndex.load(p.clone, p.dir) ?? new ProjectIndex(p.clone, p.dir);
    index.build({ include: cfg.include, exclude: cfg.exclude, maxFileBytes: cfg.maxFileBytes });
    index.save();
    const pending = filesToSummarise(index).length;
    const has = existsSync(join(p.dir, 'ARCHITECTURE.md'));
    const limit = this.jira.reanalyzeFiles ?? 30;
    const analyzer = new ProjectAnalyzer(index, app.router, app.config, bus);
    const t0 = Date.now();
    try {
      if (has && !pending) this.log(`analysis\tthe project's analysis is up to date (${p.target})`, 'info');
      else if (has && pending < limit) {
        this.log(`analysis\t${plural(pending, 'file')} changed on ${p.target} since – summarised again`, 'info');
        await analyzer.updateSummaries(signal);
      } else {
        this.log(`analysis\t${has ? `${plural(pending, 'file')} changed on ${p.target} – the analysis is made again` : `first issue of this repository: analysing the project at ${p.target} (${plural(pending, 'file')}) – once, for all its issues`}`, 'info');
        const r = await analyzer.run({ signal });
        this.log(`analysis\tdone in ${fmtWait(Date.now() - t0)} – ${plural(r.filesSummarized, 'file')} summarised, ${plural(r.modules, 'module')}${r.failures ? `, ${plural(r.failures, 'failure')}` : ''}`, 'info');
      }
      this.analysed.add(p.dir);
    } catch (e) {
      if (signal.aborted) throw e;
      this.log(`the analysis failed (${errorMessage(e)}) – the work goes on with the index only`, 'warn');
    }
  }

  /** Look at Jira every few minutes until stopped; network or server errors only skip one round. */
  async watch(): Promise<void> {
    const minutes = this.opts.intervalMinutes ?? this.jira.intervalMinutes ?? 5;
    this.log(`watching ${this.jira.url} every ${minutes} min for issues assigned to you that mention ${this.client.mention}`, 'pass');
    while (!this.opts.signal?.aborted) {
      try {
        await this.pass();
      } catch (e) {
        this.log(`Jira: ${errorMessage(e)} – trying again in ${minutes} min`, 'warn');
      }
      await sleep(minutes * 60_000, this.opts.signal).catch(() => undefined);
    }
  }
}

/**
 * The folder of a repository's shared state – index, architecture analysis, skills, rules – that
 * every issue of the repository uses: ~/.kurultay/projects/<group_project>.
 */
export function projectFolder(url: string, home = kurultayHome()): string {
  let name: string;
  try {
    name = projectOf(url).path.replace(/[\\/]+/g, '_');
  } catch {
    name = repoSlug(url);
  }
  return join(home, 'projects', name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || repoSlug(url));
}

const fmtWait = (ms: number) => (ms >= 60_000 ? plural(Math.round(ms / 60_000), 'minute') : plural(Math.round(ms / 1000), 'second'));

const firstLine = (t: string) => t.split('\n').find((l) => l.trim() && !/^(The description|Lines|A comment)/.test(l))?.trim().slice(0, 120) ?? t.split('\n')[0].slice(0, 120);

/** A changed description as a request: what is new, what is gone, the whole text. */
function changeText(before: string, after: string, mention: string): string {
  // the mention and its settings ({repo: …}) are not part of the request
  const strip = (t: string) => t.replace(new RegExp(`${mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s*\\{[^}]*\\})?`, 'gi'), '');
  const { added, removed } = descriptionChange(strip(before), strip(after));
  return [
    'The description of the issue was changed.',
    ...(added.length ? ['Lines added or changed:', ...added.map((l) => `+ ${l}`)] : []),
    ...(removed.length ? ['Lines removed (no longer asked for):', ...removed.map((l) => `- ${l}`)] : []),
  ].join('\n');
}

function commentText(c: JiraComment, mention: string): string {
  return `A comment${c.author ? ` by ${c.author}` : ''} asks:\n${requestOf(c, mention) ?? ''}`;
}

/** The task of a run: the issue, what was asked since, and where an interrupted attempt stopped. */
function taskText(issue: JiraIssue, mention: string, o: { followUp: boolean; requests: string[]; resume?: WorkSnapshot; stopped?: string }): string {
  const parts = [taskOf(issue, mention)];
  if (o.requests.length) {
    parts.push(
      o.followUp
        ? `# Follow-up\nKurultay already worked on this issue; that work is on this branch (see git log). Do what is asked now, on top of it – keep what is done unless the request changes it:\n\n${o.requests.join('\n\n---\n\n')}`
        : `# Also asked\n${o.requests.join('\n\n---\n\n')}`,
    );
  }
  if (o.resume) {
    const files = Object.keys(o.resume.files ?? {});
    const todos = o.resume.todos?.length ? `\nTodo list at that point:\n${o.resume.todos.map((t) => `- [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`).join('\n')}` : '';
    parts.push(
      `# Continue the interrupted work\nAn earlier attempt at this stopped${o.stopped ? ` (${o.stopped})` : ''} after ${o.resume.step} step(s). Its changes are already in the work tree${files.length ? `: ${files.slice(0, 30).join(', ')}` : ''}. Check them, keep what is right and go on from there – do not start over.${todos}${o.resume.note ? `\nIts last note: ${o.resume.note.slice(0, 800)}` : ''}`,
    );
  }
  return parts.join('\n\n');
}

/**
 * Start `kurultay jira --watch` when the user logs in: a .cmd in the Windows Startup folder,
 * an autostart entry on Linux desktops. Returns the file written (or removed).
 */
/** Where `kurultay jira startup` puts its entry: the Windows Startup folder, or the Linux autostart folder. */
export function startupFile(opts: { platform?: NodeJS.Platform; appData?: string; home?: string } = {}): string {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? process.env.HOME ?? process.env.USERPROFILE ?? '.';
  if (platform === 'win32') return join(opts.appData ?? process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'kurultay-jira.cmd');
  return join(home, '.config', 'autostart', 'kurultay-jira.desktop');
}

export function installStartup(opts: { remove?: boolean; node?: string; nodeArgs?: string[]; script?: string; config?: string; platform?: NodeJS.Platform; appData?: string; home?: string } = {}): { file: string; removed?: boolean } {
  const platform = opts.platform ?? process.platform;
  const node = opts.node ?? process.execPath;
  const script = opts.script ?? process.argv[1];
  const cfg = opts.config ? ` --config "${resolve(opts.config)}"` : '';
  // the flags Node was started with go into the start-up line too (e.g. --use-system-ca for a
  // company certificate in the Windows store) – without them the watch could not reach Jira
  const flags = (opts.nodeArgs ?? process.execArgv).filter((a) => a.startsWith('--') && !/^--(inspect|test|eval|print)/.test(a)).map((a) => ` ${a}`).join('');
  const home = opts.home ?? process.env.HOME ?? process.env.USERPROFILE ?? '.';
  const file = startupFile({ platform, appData: opts.appData, home });
  let body: string;
  if (platform === 'win32') {
    body = `@echo off\r\nrem Kurultay: Jira issues that mention @kurultay (log: %USERPROFILE%\\.kurultay\\jira.log)\r\nstart "Kurultay Jira" /min "${node}"${flags} "${script}" jira --watch${cfg}\r\n`;
  } else {
    body = `[Desktop Entry]\nType=Application\nName=Kurultay Jira\nExec="${node}"${flags} "${script}" jira --watch${cfg}\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n`;
  }
  if (opts.remove) {
    rmSync(file, { force: true });
    return { file, removed: true };
  }
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, body);
  return { file };
}
