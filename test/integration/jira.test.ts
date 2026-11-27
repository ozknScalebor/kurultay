import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';
import { branchName, GitRepo, projectOf, repoSlug } from '../../src/integrations/gitlab.js';
import { descriptionChange, JiraClient, mentionSettings, repoFor, requestOf, taskOf, type JiraIssue } from '../../src/integrations/jira.js';
import { Inbox } from '../../src/agent/inbox.js';
import { installStartup, JiraWorker } from '../../src/integrations/jira-worker.js';
import { jiraStatus } from '../../src/integrations/jira-status.js';
import { jiraPanel } from '../../src/tui/panels.js';
import { parseConfig } from '../../src/config.js';
import { tmpProject } from '../helpers.js';

const closers: Array<() => void> = [];
after(() => closers.forEach((c) => c()));

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A bare repository with one commit on main, as the "GitLab" remote. */
function remote(): string {
  const base = tmpProject({});
  const bare = join(base, 'app.git');
  mkdirSync(bare);
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const seed = join(base, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'calc.c'), 'int add(int a, int b) { return a - b; }\n');
  git(seed, 'add', '.');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  git(seed, 'push', '-q', bare, 'main');
  return bare;
}

interface Call {
  method: string;
  url: string;
  auth?: string;
  body?: unknown;
}

type FakeIssue = Partial<JiraIssue> & { key: string; broken?: boolean };

/** Fake Jira (search, issue, comment, transitions) and GitLab merge request API on one port. The issues can be changed while it runs. */
async function fakeServers(issues: FakeIssue[]) {
  const calls: Call[] = [];
  let nextComment = 100;
  const body = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const t = Buffer.concat(chunks).toString('utf8');
    return t ? (JSON.parse(t) as unknown) : undefined;
  };
  const raw = (i: FakeIssue) => ({
    key: i.key,
    fields: {
      summary: i.summary ?? 'x',
      description: i.description ?? '',
      status: { name: 'To Do' },
      updated: '2026-11-24',
      project: { key: i.key.split('-')[0] },
      comment: { comments: (i.comments ?? []).map((c) => ({ id: c.id, body: c.body, created: c.created, author: { displayName: c.author ?? 'Oz' } })) },
    },
  });
  const server = createServer(async (req, res) => {
    const b = await body(req);
    calls.push({ method: req.method ?? '', url: req.url ?? '', auth: (req.headers.authorization as string) ?? (req.headers['private-token'] as string), body: b });
    const json = (code: number, v: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    if (req.url?.startsWith('/rest/api/2/search')) return json(200, { issues: issues.map(raw) });
    if (req.url?.includes('/transitions') && req.method === 'GET') return json(200, { transitions: [{ id: '31', name: 'Start review', to: { name: 'In Review' } }] });
    if (req.url?.includes('/transitions')) return json(204, {});
    const m = /^\/rest\/api\/2\/issue\/([^/?]+)(\/comment)?/.exec(req.url ?? '');
    if (m) {
      const issue = issues.find((i) => i.key === decodeURIComponent(m[1]));
      if (!issue) return json(404, {});
      if (issue.broken && req.method === 'GET') return json(500, { errorMessages: ['down for maintenance'] });
      if (m[2] && req.method === 'POST') {
        const id = String(nextComment++);
        // Kurultay writes with the user's token: its comments look like the user's
        (issue.comments ??= []).push({ id, body: (b as { body: string }).body, created: '', author: 'Oz' });
        return json(201, { id });
      }
      return json(200, raw(issue));
    }
    if (req.url === '/rest/api/2/serverInfo') return json(200, { version: '8.20.4', deploymentType: 'Server' });
    if (req.url === '/rest/api/2/myself') return req.headers.authorization === 'Bearer bad' ? json(401, { errorMessages: ['no'] }) : json(200, { name: 'oz', displayName: 'Ozkan E' });
    if (req.url === '/api/v4/version') return json(200, { version: '19.2.7-ee' });
    if (req.url?.includes('/merge_requests')) return json(201, { web_url: 'https://gitlab.local/team/app/-/merge_requests/7', iid: 7 });
    return json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  closers.push(() => server.close());
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, calls, comments: (key: string) => (issues.find((i) => i.key === key)?.comments ?? []).map((c) => c.body) };
}

/** A config file for the fake servers and a local bare repository. */
function configFile(home: string, url: string, bare: string, jira: Record<string, unknown> = {}): string {
  const file = join(home, 'config.json');
  writeFileSync(file, JSON.stringify({ endpoints: [{ name: 'e', baseUrl: 'http://127.0.0.1:1/v1' }], jira: { url, token: 'jira-pat', pollSeconds: 0.05, ...jira }, gitlab: { repo: pathToFileURL(bare).href, url, token: 'gl-token', workDir: join(home, 'work') } }));
  return file;
}

const ok = (files: string[]) => ({ status: 'completed' as const, changedFiles: files, finalVerify: { ok: true, skipped: false, score: 1, steps: [] } as never, reportPath: '' });
const until = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('Jira: issues that mention @kurultay become merge requests', () => {
  it('builds the right Authorization header for Server/DC and Cloud', () => {
    assert.equal(new JiraClient({ url: 'https://jira.local', token: 'pat' }).authHeader(), 'Bearer pat');
    assert.equal(new JiraClient({ url: 'https://jira.local', username: 'oz', password: 'pw' }).authHeader(), `Basic ${Buffer.from('oz:pw').toString('base64')}`);
    assert.equal(new JiraClient({ url: 'https://acme.atlassian.net', username: 'oz@acme.com', token: 'api' }).authHeader(), `Basic ${Buffer.from('oz@acme.com:api').toString('base64')}`);
    assert.throws(() => new JiraClient({ url: 'https://jira.local' }).authHeader(), /token/);
    assert.match(new JiraClient({ url: 'https://jira.local' }).jql(), /assignee = currentUser\(\) AND description ~ "kurultay"/);
  });

  it('finds the repository and the task text of an issue', () => {
    const i = { key: 'ABC-1', project: 'ABC', summary: 'Fix add', description: '@kurultay please fix add()\nrepo: https://gitlab.local/x/own.git\n{code}add(1,2){code}', status: '', updated: '', url: '' };
    assert.equal(repoFor(i, {}, 'https://gitlab.local/team/app.git'), 'https://gitlab.local/x/own.git');
    assert.equal(repoFor({ ...i, description: '@kurultay' }, { ABC: 'https://g/abc.git' }, 'https://g/app.git'), 'https://g/abc.git');
    assert.equal(repoFor({ ...i, description: '@kurultay' }, {}, 'https://g/app.git'), 'https://g/app.git');
    // the repository written with the mention: @kurultay{repo:<url>} – plain, in <…>, or as a Jira link
    const withRepo = (d: string) => ({ ...i, description: d });
    assert.equal(repoFor(withRepo('Fix it. @kurultay{repo:https://gitlab.local/yna/gui.git}'), {}, 'https://g/app.git'), 'https://gitlab.local/yna/gui.git');
    assert.equal(repoFor(withRepo('@Kurultay{ repo: <https://gitlab.local/a/b.git> }'), {}), 'https://gitlab.local/a/b.git');
    assert.equal(repoFor(withRepo('@kurultay{repo:[https://gitlab.local/a/c.git|https://gitlab.local/a/c.git]}'), {}), 'https://gitlab.local/a/c.git');
    assert.equal(repoFor(withRepo('@kurultay{repo: [https://gitlab.local/a/d.git]; other: x}'), {}), 'https://gitlab.local/a/d.git');
    assert.equal(repoFor(withRepo('@kurultay{repo:"https://gitlab.local/a/e.git"}'), { ABC: 'https://g/abc.git' }), 'https://gitlab.local/a/e.git');
    assert.equal(repoFor(withRepo('@kurultay{} only'), { ABC: 'https://g/abc.git' }), 'https://g/abc.git', 'empty settings: the configured repository');
    assert.equal(repoFor(withRepo('@kurultay{repo:<x@other>}'), {}, undefined, '@bot'), undefined, 'another mention word');
    assert.deepEqual(mentionSettings('a @kurultay b @kurultay{repo: u, branch: dev}'), { repo: 'u', branch: 'dev' });
    const tr = taskOf(withRepo('Fix the table @kurultay{repo:https://gitlab.local/yna/gui.git} please'), '@kurultay');
    assert.match(tr, /^ABC-1: Fix add\n\nFix the table\s+please$/);
    assert.equal(requestOf({ id: '3', body: '@kurultay{repo:x} also y', created: '' }, '@kurultay'), 'also y');
    const t = taskOf(i, '@kurultay');
    assert.match(t, /^ABC-1: Fix add\n\nplease fix add\(\)/);
    assert.doesNotMatch(t, /@kurultay|repo:/);
    assert.match(t, /```add\(1,2\)```/);
    assert.deepEqual(projectOf('https://gitlab.local/team/app.git'), { base: 'https://gitlab.local', path: 'team/app' });
    assert.deepEqual(projectOf('https://srv.local/gitlab/team/app.git', 'https://srv.local/gitlab'), { base: 'https://srv.local/gitlab', path: 'team/app' });
    assert.deepEqual(projectOf('git@gitlab.local:team/app.git'), { base: 'https://gitlab.local', path: 'team/app' });
    assert.equal(repoSlug('https://user@gitlab.local/team/app.git'), 'gitlab.local_team_app');
    // the branch: prefix + issue key, or the key where {key} stands
    assert.equal(branchName('ABC-12'), 'kurultay/ABC-12');
    assert.equal(branchName('ABC-12', 'feature/'), 'feature/ABC-12');
    assert.equal(branchName('ABC-12', 'bugfix-'), 'bugfix-ABC-12');
    assert.equal(branchName('ABC-12', 'feature/{key}-ai'), 'feature/ABC-12-ai');
    for (const bad of ['feature //', 'a..b/', 'x~', '/lead', 'f/{key}.lock', 'with space/']) assert.throws(() => branchName('ABC-12', bad), /does not accept/, bad);
    // a changed description: what is new and what is gone, line by line
    assert.deepEqual(descriptionChange('a\nb\nb\n{code}x{code}', 'a\nb\nc\n{code}x{code}'), { added: ['c'], removed: ['b'] });
    assert.equal(requestOf({ id: '1', body: '@Kurultay also {code}mul(){code}', created: '' }, '@kurultay'), 'also ```mul()```');
    assert.equal(requestOf({ id: '2', body: 'just a note', created: '' }, '@kurultay'), undefined);
    const inbox = new Inbox();
    inbox.post('one');
    inbox.post('  ');
    assert.deepEqual(inbox.take(0), { texts: ['one'], cursor: 1 });
    inbox.post('two');
    assert.deepEqual(inbox.unread(), ['two']);
    inbox.clear();
    assert.deepEqual([inbox.unread(), inbox.size], [[], 2]);
  });

  it('clones, works on a branch, pushes, opens the merge request and comments the link on the issue – once', async () => {
    const bare = remote();
    const fake = await fakeServers([
      { key: 'ABC-1', summary: 'add() subtracts', description: 'add returns a-b. @kurultay fix it' },
      { key: 'ABC-2', summary: 'not for us', description: 'kurultay is mentioned without the @' },
    ]);
    const home = tmpProject({});
    const cfgFile = join(home, 'config.json');
    writeFileSync(cfgFile, JSON.stringify({ endpoints: [{ name: 'e', baseUrl: 'http://127.0.0.1:1/v1' }], jira: { url: fake.url, token: 'jira-pat', transition: 'In Review' }, gitlab: { repo: pathToFileURL(bare).href, url: fake.url, token: 'gl-token', workDir: join(home, 'work'), branchPrefix: 'feature/' } }));
    const tasks: string[] = [];
    const worker = new JiraWorker({
      config: cfgFile,
      home,
      run: async (root, task) => {
        tasks.push(task);
        writeFileSync(join(root, 'calc.c'), 'int add(int a, int b) { return a + b; }\n');
        return { status: 'completed', changedFiles: ['calc.c'], finalVerify: { ok: true, skipped: false, score: 1, steps: [] } as never, reportPath: '' };
      },
    });
    const r = await worker.pass();
    assert.equal(r.seen, 1, 'only the issue with the @mention');
    assert.deepEqual(r.done, [{ key: 'ABC-1', status: 'merge-request', mr: 'https://gitlab.local/team/app/-/merge_requests/7' }]);
    assert.match(tasks[0], /^ABC-1: add\(\) subtracts\n\nadd returns a-b\.\s+fix it/);
    // the branch is on the remote with the change
    assert.match(git(bare, 'show', 'feature/ABC-1:calc.c'), /return a \+ b/);
    assert.equal(git(bare, 'log', '-1', '--format=%s', 'feature/ABC-1').trim(), 'ABC-1: add() subtracts');
    // merge request through the API, with the token
    const mr = fake.calls.find((c) => c.url.includes('/merge_requests'))!;
    assert.equal(mr.auth, 'gl-token');
    assert.deepEqual({ ...(mr.body as Record<string, unknown>), description: undefined }, { source_branch: 'feature/ABC-1', target_branch: 'main', title: 'ABC-1: add() subtracts', description: undefined, remove_source_branch: true });
    // the merge request link goes under the issue as a comment
    const comment = fake.calls.find((c) => c.url === '/rest/api/2/issue/ABC-1/comment')!;
    assert.equal(comment.auth, 'Bearer jira-pat');
    assert.match((comment.body as { body: string }).body, /opened a merge request: \[https:\/\/gitlab\.local\/team\/app\/-\/merge_requests\/7\|/);
    assert.match((comment.body as { body: string }).body, /Build\/tests: passed/);
    assert.ok(fake.calls.some((c) => c.url.endsWith('/transitions') && c.method === 'POST'), 'moved to In Review');
    // a second look does nothing: the issue is done until its description changes
    const again = await worker.pass();
    assert.equal(again.done.length, 0);
    assert.ok(existsSync(join(home, 'jira.log')) && /merge request opened/.test(readFileSync(join(home, 'jira.log'), 'utf8')));
  });

  it('comments when nothing changed or the work failed, and never shows the git password', async () => {
    const bare = remote();
    const fake = await fakeServers([{ key: 'XY-9', summary: 'nothing', description: '@kurultay look' }]);
    const home = tmpProject({});
    const cfgFile = join(home, 'config.json');
    writeFileSync(cfgFile, JSON.stringify({ endpoints: [{ name: 'e', baseUrl: 'http://127.0.0.1:1/v1' }], jira: { url: fake.url, username: 'oz', password: 'pw' }, gitlab: { repo: pathToFileURL(bare).href, workDir: join(home, 'work') } }));
    const none = await new JiraWorker({ config: cfgFile, home, run: async () => ({ status: 'completed', changedFiles: [], reportPath: '' }) }).pass();
    assert.equal(none.done[0].status, 'no-change');
    assert.match(JSON.stringify(fake.calls.at(-1)?.body), /produced no change/);
    // a repository that cannot be reached: failed, with a comment
    writeFileSync(cfgFile, JSON.stringify({ endpoints: [{ name: 'e', baseUrl: 'http://127.0.0.1:1/v1' }], jira: { url: fake.url, username: 'oz', password: 'pw' }, gitlab: { repo: 'https://127.0.0.1:9/none.git', username: 'oz', password: 'sekret-pass', workDir: join(home, 'work2') } }));
    const failed = await new JiraWorker({ config: cfgFile, home: tmpProject({}), run: async () => ({ status: 'completed', changedFiles: [], reportPath: '' }) }).pass();
    assert.equal(failed.done[0].status, 'failed');
    assert.doesNotMatch(JSON.stringify(fake.calls), /sekret-pass/);
    assert.match(JSON.stringify(fake.calls.at(-1)?.body), /could not finish/);
  });

  it('dry run lists, watch mode keeps looking, an issue without a repository gets a comment', async () => {
    const fake = await fakeServers([{ key: 'NO-1', summary: 'where', description: '@kurultay do it' }]);
    const home = tmpProject({});
    const cfgFile = join(home, 'config.json');
    writeFileSync(cfgFile, JSON.stringify({ endpoints: [{ name: 'e', baseUrl: 'http://127.0.0.1:1/v1' }], jira: { url: fake.url, token: 't', repos: { ABC: 'https://g/abc.git' } } }));
    const lines: string[] = [];
    await new JiraWorker({ config: cfgFile, home, dryRun: true, onProgress: (l) => lines.push(l) }).pass();
    assert.ok(lines.some((l) => /^NO-1\twhere – in \(no repository\)$/.test(l)));
    const r = await new JiraWorker({ config: cfgFile, home }).pass();
    assert.equal(r.done[0].status, 'no-repo');
    assert.match(JSON.stringify(fake.calls.at(-1)?.body), /no repository is configured for project NO/);
    // watch: a round, then a stop request ends the loop
    const ctrl = new AbortController();
    const looks = fake.calls.filter((c) => c.url.startsWith('/rest/api/2/search')).length;
    const w = new JiraWorker({ config: cfgFile, home, intervalMinutes: 0.001, signal: ctrl.signal, onProgress: (l) => lines.push(l) });
    setTimeout(() => ctrl.abort(), 300);
    await w.watch();
    assert.ok(fake.calls.filter((c) => c.url.startsWith('/rest/api/2/search')).length > looks + 1, 'looked several times');
    assert.ok(lines.some((l) => /watching .* every 0\.001 min/.test(l)));
    assert.throws(() => new JiraWorker({ config: join(tmpProject({ 'c.json': JSON.stringify({ endpoints: [{ name: 'e', baseUrl: 'http://x/v1' }] }) }), 'c.json'), home }), /no "jira" section/);
  });

  it('pushes with GitLab push options when there is no API token', async () => {
    const bare = remote();
    git(bare, 'config', 'receive.advertisePushOptions', 'true');
    const work = join(tmpProject({}), 'w');
    const repo = new GitRepo(work, {});
    const target = await repo.prepare(pathToFileURL(bare).href, 'kurultay/T-1');
    assert.equal(target, 'main');
    writeFileSync(join(work, 'new.txt'), 'x\n');
    assert.deepEqual(await repo.changed(), ['new.txt']);
    assert.equal(await repo.commit('T-1: x'), true);
    const { openMergeRequest } = await import('../../src/integrations/gitlab.js');
    const mr = await openMergeRequest(repo, pathToFileURL(bare).href, {}, { branch: 'kurultay/T-1', target, title: 'T-1: x', description: 'd' });
    assert.equal(mr, undefined, 'a plain git server returns no merge request link');
    assert.match(git(bare, 'branch', '--list', 'kurultay/T-1'), /kurultay\/T-1/);
  });

  it('writes and removes the start-up entry', () => {
    const appData = tmpProject({});
    const w = installStartup({ platform: 'win32', appData, node: 'C:\\node\\node.exe', nodeArgs: ['--use-system-ca', '--inspect=9229'], script: 'C:\\k\\bin\\kurultay.js' });
    assert.match(w.file, /Startup[\\/]kurultay-jira\.cmd$/);
    assert.match(readFileSync(w.file, 'utf8'), /start "Kurultay Jira" \/min "C:\\node\\node\.exe" --use-system-ca "C:\\k\\bin\\kurultay\.js" jira --watch/);
    installStartup({ platform: 'win32', appData, remove: true });
    assert.equal(existsSync(w.file), false);
    const home = tmpProject({});
    const l = installStartup({ platform: 'linux', home, node: '/usr/bin/node', nodeArgs: [], script: '/k/kurultay.js' });
    assert.match(readFileSync(l.file, 'utf8'), /Exec="\/usr\/bin\/node" "\/k\/kurultay\.js" jira --watch/);
  });
  it('the console shows the Jira connection: server, user, waiting issues, GitLab, start-up entry', async () => {
    const fake = await fakeServers([{ key: 'ABC-1', description: '@kurultay fix' }, { key: 'ABC-2', description: 'no mention' }]);
    const home = tmpProject({ 'jira.log': '2026-11-26T10:00:00Z jira: 1 issue(s) to do: ABC-1\n' });
    const cfg = parseConfig({ endpoints: [{ name: 'e', baseUrl: 'http://127.0.0.1:1/v1' }], jira: { url: fake.url, token: 'jira-pat' }, gitlab: { repo: `${fake.url}/team/app.git`, url: fake.url, token: 'gl', branchPrefix: 'feature/', targetBranch: 'develop' } });
    const st = (await jiraStatus(cfg, { home, platform: 'linux' }))!;
    assert.equal(st.ok, true);
    assert.equal(st.server, 'Jira 8.20.4 (Server)');
    assert.equal(st.user, 'Ozkan E');
    assert.equal(st.pending, 1);
    assert.deepEqual({ ok: st.gitlab?.ok, version: st.gitlab?.version, branch: st.gitlab?.branch, target: st.gitlab?.target }, { ok: true, version: '19.2.7-ee', branch: 'feature/ABC-12', target: 'develop' });
    assert.match(st.lastLog ?? '', /ABC-1/);
    const panel = jiraPanel(st);
    assert.match(panel, /Jira 8\.20\.4 \(Server\) · signed in as Ozkan E · 1 issue waits/);
    assert.match(panel, /GitLab 19\.2\.7-ee/);
    assert.match(panel, /branch feature\/ABC-12 → develop/);
    const bad = (await jiraStatus(parseConfig({ endpoints: [{ name: 'e', baseUrl: 'http://127.0.0.1:1/v1' }], jira: { url: fake.url, token: 'bad' } }), { home, platform: 'linux' }))!;
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? '', /401/);
    assert.match(jiraPanel(bad), /GitLab {2}no repository/);
    assert.equal(await jiraStatus(parseConfig({ endpoints: [{ name: 'e', baseUrl: 'http://127.0.0.1:1/v1' }] })), undefined);
  });

  it('a changed description or a new @kurultay comment reaches the running work; after the merge request the work goes on on the same branch', async () => {
    const bare = remote();
    const issue: FakeIssue = { key: 'ABC-5', summary: 'fix add', description: '@kurultay add() must add' };
    const fake = await fakeServers([issue]);
    const home = tmpProject({});
    const tasks: string[] = [];
    const heard: string[] = [];
    const worker = new JiraWorker({
      config: configFile(home, fake.url, bare),
      home,
      run: async (root, task, ctx) => {
        tasks.push(task);
        if (tasks.length === 1) {
          // the user edits the description while Kurultay works: it arrives within a poll
          issue.description = '@kurultay add() must add\nand add a test';
          await until(() => ctx.inbox.size > 0);
          heard.push(...ctx.inbox.take(0).texts);
          writeFileSync(join(root, 'calc.c'), 'int add(int a, int b) { return a + b; }\n');
          writeFileSync(join(root, 'test.c'), '/* add(2,3) == 5 */\n');
          return ok(['calc.c', 'test.c']);
        }
        writeFileSync(join(root, 'mul.c'), 'int mul(int a, int b) { return a * b; }\n');
        return ok(['mul.c']);
      },
    });
    const r1 = await worker.pass();
    assert.equal(r1.done[0].status, 'merge-request');
    assert.match(heard.join('\n'), /description of the issue was changed[\s\S]*\+ and add a test/);
    assert.equal(tasks.length, 1, 'the change was read by the running agent – no extra run');
    assert.match(git(bare, 'show', 'kurultay/ABC-5:test.c'), /add\(2,3\)/);
    // nothing new: nothing to do (Kurultay's own comments are never requests)
    assert.equal((await worker.pass()).done.length, 0);
    // a comment asks for more: the work goes on on the branch, on top of the first commit
    (issue.comments ??= []).push({ id: '500', body: '@kurultay also add mul()', created: '' });
    const r2 = await worker.pass();
    assert.equal(r2.done[0].status, 'merge-request');
    assert.match(tasks[1], /# Follow-up\nKurultay already worked on this issue[\s\S]*also add mul\(\)/);
    assert.equal(git(bare, 'rev-list', '--count', 'kurultay/ABC-5').trim(), '3', 'init + first work + follow-up: no force push');
    assert.match(git(bare, 'show', 'kurultay/ABC-5:calc.c'), /a \+ b/);
    assert.match(git(bare, 'show', 'kurultay/ABC-5:mul.c'), /a \* b/);
    assert.match(fake.comments('ABC-5').at(-1) ?? '', /Done on request: also add mul\(\)/);
    // the description is edited again: only what changed goes to the run
    issue.description = '@kurultay add() must add\nand add a test\nreturn int64';
    await worker.pass();
    assert.match(tasks[2], /Lines added or changed:\n\+ return int64/);
    assert.doesNotMatch(tasks[2].split('# Follow-up')[1], /\+ and add a test/);
    // every issue has its own work tree next to the shared clone
    assert.ok(existsSync(join(home, 'work', `${repoSlug(pathToFileURL(bare).href)}.issues`, 'ABC-5', 'mul.c')));
  });

  it('a change that comes after the agent finished gets one more run before the commit', async () => {
    const bare = remote();
    const issue: FakeIssue = { key: 'LT-1', summary: 'late', description: '@kurultay make a.txt' };
    const fake = await fakeServers([issue]);
    const home = tmpProject({});
    const tasks: string[] = [];
    const r = await new JiraWorker({
      config: configFile(home, fake.url, bare),
      home,
      run: async (root, task) => {
        tasks.push(task);
        writeFileSync(join(root, `${tasks.length}.txt`), 'x\n');
        if (tasks.length === 1) issue.comments = [{ id: '9', body: '@kurultay and b.txt too', created: '' }];
        return ok([`${tasks.length}.txt`]);
      },
    }).pass();
    assert.equal(r.done[0].status, 'merge-request');
    assert.equal(tasks.length, 2);
    assert.match(tasks[1], /# New request\nThe work done so far is already in the work tree[\s\S]*and b\.txt too/);
    assert.match(git(bare, 'ls-tree', '--name-only', 'kurultay/LT-1'), /1\.txt\n2\.txt/);
  });

  it('no model answers: keeps trying, comments after maxWaitMinutes, goes on with the next issue and later continues from where it stopped', async () => {
    const bare = remote();
    const fake = await fakeServers([
      { key: 'DN-1', summary: 'first', description: '@kurultay write a.c' },
      { key: 'DN-2', summary: 'second', description: '@kurultay write b.c' },
    ]);
    const home = tmpProject({});
    // 0.003 min = 180 ms instead of two hours
    const cfg = configFile(home, fake.url, bare, { maxWaitMinutes: 0.003, retryMinutes: 0.001 });
    const tasks: string[] = [];
    const down = new JiraWorker({
      config: cfg,
      home,
      run: async (root, task, ctx) => {
        tasks.push(task);
        if (task.startsWith('DN-1')) {
          // half done, then every model stops answering
          writeFileSync(join(root, 'a.c'), 'int a;\n');
          ctx.onCheckpoint({ worker: 'T1-1', step: 4, model: 'm', files: { 'a.c': 'int a; /* half */\n', 'calc.c': null }, todos: [{ content: 'write a.c', status: 'in_progress' }], note: 'a.c is half written' });
          const since = Date.now();
          ctx.watchOutage(() => since);
          await new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }));
        }
        writeFileSync(join(root, 'b.c'), 'int b;\n');
        return ok(['b.c']);
      },
    });
    const t0 = Date.now();
    const r = await down.pass();
    assert.ok(Date.now() - t0 >= 150, 'it waited');
    assert.deepEqual(r.done.map((d) => [d.key, d.status]), [['DN-1', 'waiting'], ['DN-2', 'merge-request']], 'the next issue was done anyway');
    assert.match(fake.comments('DN-1')[0], /Kurultay paused this issue: no model has answered for 0 seconds/);
    // the paused issue is taken again on the next look – from where it stopped, without a second pause comment
    let restored = '';
    const later = await new JiraWorker({
      config: cfg,
      home,
      run: async (root, task) => {
        tasks.push(task);
        restored = readFileSync(join(root, 'a.c'), 'utf8');
        assert.equal(existsSync(join(root, 'calc.c')), false, 'the deletion was put back too');
        writeFileSync(join(root, 'a.c'), 'int a = 1;\n');
        return ok(['a.c']);
      },
    }).pass();
    assert.deepEqual(later.done.map((d) => [d.key, d.status]), [['DN-1', 'merge-request']]);
    assert.equal(restored, 'int a; /* half */\n');
    assert.match(tasks.at(-1)!, /# Continue the interrupted work\nAn earlier attempt at this stopped \(no model answered for 0 seconds\) after 4 step\(s\)[\s\S]*\[~\] write a\.c[\s\S]*a\.c is half written/);
    assert.equal(fake.comments('DN-1').filter((c) => /paused/.test(c)).length, 1);
    assert.match(git(bare, 'show', 'kurultay/DN-1:a.c'), /int a = 1/);
    assert.equal(existsSync(join(home, 'jira-progress', 'DN-1.json')), false, 'the saved progress is gone once the work is pushed');
  });

  it('a model server that cannot be reached at all: the issue waits instead of failing', async () => {
    const bare = remote();
    const fake = await fakeServers([{ key: 'NM-1', summary: 'x', description: '@kurultay do' }]);
    const home = tmpProject({});
    const lines: string[] = [];
    const r = await new JiraWorker({ config: configFile(home, fake.url, bare, { maxWaitMinutes: 0.005, retryMinutes: 0.001 }), home, onProgress: (l) => lines.push(l) }).pass();
    assert.deepEqual(r.done.map((d) => d.status), ['waiting']);
    assert.ok(lines.some((l) => /no model could be reached – trying again in 0 seconds/.test(l)));
    assert.match(fake.comments('NM-1')[0], /paused this issue/);
  });

  it('stopped from outside: the issue stays unfinished and goes on at the next start; a Jira that does not answer the look only skips one look', async () => {
    const bare = remote();
    const issue: FakeIssue = { key: 'ST-1', summary: 'stop', description: '@kurultay do it', broken: true };
    const fake = await fakeServers([issue]);
    const home = tmpProject({});
    const cfg = configFile(home, fake.url, bare);
    const ctl = new AbortController();
    const lines: string[] = [];
    const r = await new JiraWorker({
      config: cfg,
      home,
      signal: ctl.signal,
      onProgress: (l) => lines.push(l),
      run: async (_root, _task, ctx) => {
        ctx.onCheckpoint({ worker: 'T1-1', step: 2, model: 'm', files: {}, note: '' });
        await until(() => lines.some((l) => /could not read the issue \(jira GET .*HTTP 500/.test(l)));
        ctl.abort();
        assert.ok(ctx.signal.aborted, 'the stop reaches the run at once');
        throw ctx.signal.reason;
        return ok([]);
      },
    }).pass();
    assert.deepEqual(r.done.map((d) => d.status), ['working']);
    assert.equal(fake.comments('ST-1').length, 0, 'no comment for a stop');
    // the saved progress is damaged: the work tree is used as it is
    writeFileSync(join(home, 'jira-progress', 'ST-1.json'), '{not json');
    issue.broken = false;
    const tasks: string[] = [];
    const again = await new JiraWorker({
      config: cfg,
      home,
      onProgress: (l) => lines.push(l),
      run: async (root, task) => {
        tasks.push(task);
        writeFileSync(join(root, 'x.txt'), 'x\n');
        return ok(['x.txt']);
      },
    }).pass();
    assert.deepEqual(again.done.map((d) => d.status), ['merge-request']);
    assert.ok(lines.some((l) => /ST-1 \(unfinished – goes on from where it stopped\)/.test(l)));
    assert.ok(lines.some((l) => /could not read the saved progress/.test(l)));
    assert.doesNotMatch(tasks[0], /Continue the interrupted work/);
  });

  it('works through the real run: the description edited mid-run reaches the model, the result is pushed', async () => {
    const { startMockServer } = await import('../../src/mock/server.js');
    const mock = await startMockServer([{ id: 'mock-coder-strong', quality: 'good', tools: true, ctx: 65536, latencyMs: 150 }]);
    closers.push(() => void mock.close());
    const base = tmpProject({});
    const bare = join(base, 'm.git');
    mkdirSync(bare);
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    const seed = join(base, 'seed');
    mkdirSync(join(seed, 'src'), { recursive: true });
    git(seed, 'init', '-q', '-b', 'main');
    writeFileSync(join(seed, 'src', 'mathutil.js'), 'export function clamp(value, min, max) {\n  return value;\n}\n');
    git(seed, 'add', '.');
    git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    git(seed, 'push', '-q', bare, 'main');
    const issue: FakeIssue = { key: 'RR-1', summary: 'clamp is broken', description: '@kurultay fix clamp in src/mathutil.js' };
    const fake = await fakeServers([issue]);
    const home = tmpProject({});
    const cfg = join(home, 'config.json');
    writeFileSync(cfg, JSON.stringify({ endpoints: [{ name: 'mock', baseUrl: mock.url }], jira: { url: fake.url, token: 't', pollSeconds: 0.05 }, gitlab: { repo: pathToFileURL(bare).href, url: fake.url, token: 'gl', workDir: join(home, 'work') } }));
    const t = setInterval(() => {
      if (mock.log.length >= 1 && !/min <= max/.test(issue.description ?? '')) issue.description += '\nalso keep min <= max';
    }, 20);
    try {
      const r = await new JiraWorker({ config: cfg, home }).pass();
      assert.deepEqual(r.done.map((d) => d.status), ['merge-request']);
    } finally {
      clearInterval(t);
    }
    assert.ok(mock.log.some((e) => JSON.stringify(e.body.messages).includes('also keep min <= max')), 'the change went to the model');
    assert.ok(git(bare, 'diff', '--name-only', 'main', 'kurultay/RR-1').trim(), 'the work was pushed');
    assert.doesNotMatch(git(bare, 'ls-tree', '-r', '--name-only', 'kurultay/RR-1'), /\.kurultay/, 'the state folder is never committed');
    // a second issue of the same repository: no new analysis, no new probe; a skill put in the
    // project folder is there for it
    const { projectFolder } = await import('../../src/integrations/jira-worker.js');
    const project = projectFolder(pathToFileURL(bare).href, home);
    assert.ok(existsSync(join(project, 'ARCHITECTURE.md')), 'the analysis is kept in the project folder');
    mkdirSync(join(project, 'skills', 'ui-rules'), { recursive: true });
    writeFileSync(join(project, 'skills', 'ui-rules', 'SKILL.md'), '---\nname: ui-rules\ndescription: How screens are built in this project\n---\nUse the panel base class.\n');
    issue.key = 'RR-2';
    issue.description = '@kurultay fix clamp in src/mathutil.js once more';
    const lines: string[] = [];
    await new JiraWorker({ config: cfg, home, onProgress: (l) => lines.push(l) }).pass();
    assert.ok(lines.some((l) => /^analysis\tthe project's analysis is up to date \(main\)/.test(l)), lines.join('\n'));
    assert.ok(!lines.some((l) => /^analysis\tfirst issue/.test(l)));
    assert.ok(!lines.some((l) => /^models\t/.test(l)), 'the models were measured on the first issue');
    assert.ok(lines.some((l) => l === 'skills\tui-rules'));
    assert.ok(lines.some((l) => l === `project\t${project}`));
    // someone pushes to main: the next issue fetches it and summarises only the changed file again
    git(seed, 'pull', '-q', bare, 'main');
    writeFileSync(join(seed, 'src', 'extra.js'), 'export const extra = 1;\n');
    git(seed, 'add', '.');
    git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'extra');
    git(seed, 'push', '-q', bare, 'HEAD:main');
    issue.key = 'RR-3';
    const more: string[] = [];
    await new JiraWorker({ config: cfg, home, onProgress: (l) => more.push(l) }).pass();
    assert.ok(more.some((l) => /^analysis\t1 file changed on main since – summarised again/.test(l)), more.join('\n'));
    const idx = JSON.parse(readFileSync(join(project, 'index', 'index.json'), 'utf8')) as { files: Array<{ path: string; summary?: string }> };
    assert.ok(idx.files.find((f) => f.path === 'src/extra.js')?.summary, 'the new file of main is in the project analysis');
    // what an issue changed on its own branch is not part of the project's analysis
    assert.equal(git(bare, 'show', 'main:src/mathutil.js'), readFileSync(join(home, 'work', repoSlug(pathToFileURL(bare).href), 'src', 'mathutil.js'), 'utf8'));
  });

  it('Server/Cloud search fallback, error hints, an existing merge request, a status check that gets no answer', async () => {
    const res = (code: number, v: unknown) => new Response(JSON.stringify(v), { status: code, headers: { 'content-type': 'application/json' } });
    const urls: string[] = [];
    // a server without /search (404) is asked through /search/jql
    const client = new JiraClient({ url: 'https://jira.local', token: 'p' }, (async (u: string) => {
      urls.push(u);
      return u.includes('/search?') ? res(404, {}) : res(200, { issues: [{ key: 'A-1', fields: { description: '@kurultay x' } }] });
    }) as unknown as typeof fetch);
    assert.equal((await client.pending())[0].key, 'A-1');
    assert.ok(urls[1].includes('/search/jql?'));
    const denied = new JiraClient({ url: 'https://jira.local', username: 'u', password: 'p' }, (async () => res(403, {})) as unknown as typeof fetch);
    await assert.rejects(denied.comment('A-1', 'x'), /CAPTCHA blocks password logins/);
    // GitLab says the merge request exists (409): the open one is returned
    const bare = remote();
    const work = join(tmpProject({}), 'w');
    const repo = new GitRepo(work, { token: 't' });
    await repo.prepare(pathToFileURL(bare).href, 'kurultay/E-1');
    const { openMergeRequest } = await import('../../src/integrations/gitlab.js');
    const gl = (async (u: string) => (u.includes('source_branch=') ? res(200, [{ web_url: 'https://g/mr/3', iid: 3 }]) : res(409, { message: 'exists' }))) as unknown as typeof fetch;
    assert.deepEqual(await openMergeRequest(repo, 'https://g/team/app.git', { token: 't' }, { branch: 'kurultay/E-1', target: 'main', title: 't', description: 'd' }, gl), { url: 'https://g/mr/3', iid: 3, existed: true });
    await assert.rejects(openMergeRequest(repo, 'https://g/team/app.git', { token: 't' }, { branch: 'kurultay/E-1', target: 'main', title: 't', description: 'd' }, (async () => res(500, {})) as unknown as typeof fetch), /could not open the merge request: HTTP 500/);
    // the start screen: Jira does not answer in time, GitLab refuses the token
    const slow = (async (u: string) => {
      if (u.includes('/api/v4/version')) return res(401, {});
      throw new Error('The operation was aborted due to timeout');
    }) as unknown as typeof fetch;
    const st = (await jiraStatus(parseConfig({ endpoints: [{ name: 'e', baseUrl: 'http://127.0.0.1:1/v1' }], jira: { url: 'https://jira.local', token: 'p' }, gitlab: { repo: 'https://g/team/app.git', token: 'bad' } }), { fetch: slow, timeoutMs: 50, home: tmpProject({}), platform: 'linux' }))!;
    assert.equal(st.error, 'no answer within 0.05 s');
    assert.equal(st.gitlab?.error, 'HTTP 401 (check gitlab.token)');
    const badPrefix = (await jiraStatus(parseConfig({ endpoints: [{ name: 'e', baseUrl: 'http://127.0.0.1:1/v1' }], jira: { url: 'https://jira.local', token: 'p' }, gitlab: { repo: 'https://g/a.git', branchPrefix: 'a b/' } }), { fetch: slow, timeoutMs: 50, home: tmpProject({}), platform: 'linux' }))!;
    assert.match(badPrefix.gitlab?.error ?? '', /does not accept/);
  });

  it('a changed summary is a request too; comments can be off; a transition the workflow lacks is only logged', async () => {
    const bare = remote();
    const issue: FakeIssue = { key: 'SM-1', summary: 'first title', description: '@kurultay do it' };
    const fake = await fakeServers([issue]);
    const home = tmpProject({});
    const lines: string[] = [];
    const tasks: string[] = [];
    const heard: string[] = [];
    const worker = new JiraWorker({
      config: configFile(home, fake.url, bare, { comment: false, transition: 'Shipped' }),
      home,
      onProgress: (l) => lines.push(l),
      run: async (root, task, ctx) => {
        tasks.push(task);
        if (tasks.length === 1) {
          issue.summary = 'second title';
          await until(() => ctx.inbox.size > 0);
          heard.push(...ctx.inbox.take(0).texts);
        }
        writeFileSync(join(root, `${tasks.length}.txt`), 'x\n');
        return ok([`${tasks.length}.txt`]);
      },
    });
    assert.deepEqual((await worker.pass()).done.map((d) => d.status), ['merge-request']);
    assert.deepEqual(heard, ['The summary is now: second title']);
    assert.equal(fake.comments('SM-1').length, 0, 'comment: false');
    assert.ok(lines.some((l) => /no transition "Shipped" in its workflow/.test(l)));
    // after the merge request: only the summary changes
    issue.summary = 'third title';
    assert.deepEqual((await worker.pass()).done.map((d) => d.status), ['merge-request']);
    assert.match(tasks[1], /# Follow-up[\s\S]*The summary is now: third title/);
  });

  it('error paths: Jira down during watch, a broken state file, a comment that cannot be written, a repository without origin/HEAD', async () => {
    const lines: string[] = [];
    // watch: Jira cannot be reached – the round is skipped, the loop goes on
    const home = tmpProject({});
    const dead = join(home, 'dead.json');
    writeFileSync(dead, JSON.stringify({ endpoints: [{ name: 'e', baseUrl: 'http://127.0.0.1:1/v1' }], jira: { url: 'http://127.0.0.1:9', token: 't' }, gitlab: { repo: 'https://g/a.git' } }));
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 300);
    await new JiraWorker({ config: dead, home, intervalMinutes: 0.001, signal: ctl.signal, onProgress: (l) => lines.push(l) }).watch();
    assert.ok(lines.some((l) => /^Jira: .* – trying again in 0\.001 min/.test(l)));
    // a damaged state file counts as empty; a comment Jira refuses is logged, the work goes on
    const bare = remote();
    const fake = await fakeServers([{ key: 'CM-1', summary: 'x', description: '@kurultay do', broken: true }]);
    const h2 = tmpProject({ 'jira-state.json': '{oops' });
    const failing = (async (u: string, init?: RequestInit) => (init?.method === 'POST' && u.includes('/comment') ? new Response('no', { status: 500 }) : fetch(u, init))) as typeof fetch;
    const r = await new JiraWorker({ config: configFile(h2, fake.url, bare), home: h2, fetch: failing, onProgress: (l) => lines.push(l), run: async () => ok([]) }).pass();
    assert.deepEqual(r.done.map((d) => d.status), ['no-change']);
    assert.ok(lines.some((l) => /^could not write the comment – jira POST/.test(l)));
    assert.match(readFileSync(join(h2, 'jira.log'), 'utf8'), /Z == CM-1 {2}x\n.*Z CM-1: repo {2}file:.*\n[\s\S]*Z CM-1: ! could not write the comment/);
    // no origin/HEAD: main, master or develop is taken; none of them – a clear error
    const work = join(tmpProject({}), 'w');
    const repo = new GitRepo(work, {});
    await repo.sync(pathToFileURL(bare).href);
    git(work, 'remote', 'set-head', 'origin', '-d');
    assert.equal(await repo.defaultBranch(), 'main');
    git(work, 'update-ref', '-d', 'refs/remotes/origin/main');
    await assert.rejects(repo.defaultBranch(), /set gitlab\.targetBranch/);
  });

  it('submodules are checked out in the work tree of the issue; changes inside them are not committed', async () => {
    // git refuses file:// submodules unless allowed (https ones need nothing)
    const prev = { c: process.env.GIT_CONFIG_COUNT, k: process.env.GIT_CONFIG_KEY_0, v: process.env.GIT_CONFIG_VALUE_0 };
    Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' });
    try {
      const base = tmpProject({});
      const lib = join(base, 'lib.git');
      mkdirSync(lib);
      git(lib, 'init', '-q', '--bare', '-b', 'main');
      const libSeed = join(base, 'lib-seed');
      mkdirSync(libSeed);
      git(libSeed, 'init', '-q', '-b', 'main');
      writeFileSync(join(libSeed, 'util.c'), 'int util(void) { return 1; }\n');
      git(libSeed, 'add', '.');
      git(libSeed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'lib');
      git(libSeed, 'push', '-q', lib, 'main');
      const bare = remote();
      const seed = join(base, 'app-seed');
      git(base, 'clone', '-q', bare, seed);
      git(seed, 'submodule', 'add', '-q', pathToFileURL(lib).href, 'lib');
      git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'add lib');
      git(seed, 'push', '-q', 'origin', 'main');
      const fake = await fakeServers([{ key: 'SB-1', summary: 'use util', description: '@kurultay call util()' }]);
      const home = tmpProject({});
      const lines: Array<[string, string]> = [];
      let seen = '';
      const r = await new JiraWorker({
        config: configFile(home, fake.url, bare),
        home,
        onProgress: (l, k) => lines.push([l, k]),
        run: async (root) => {
          // git on Windows may check text out with CRLF
          seen = readFileSync(join(root, 'lib', 'util.c'), 'utf8').replace(/\r\n/g, '\n');
          writeFileSync(join(root, 'calc.c'), 'int add(int a, int b) { return a + b; }\n');
          writeFileSync(join(root, 'lib', 'util.c'), 'int util(void) { return 2; }\n');
          return ok(['calc.c', 'lib/util.c']);
        },
      }).pass();
      assert.deepEqual(r.done.map((d) => d.status), ['merge-request']);
      assert.equal(seen, 'int util(void) { return 1; }\n', 'the submodule was there when the work started');
      assert.ok(lines.some(([l, k]) => k === 'info' && l === 'submods\tlib'));
      assert.ok(lines.some(([l, k]) => k === 'warn' && /changes inside the submodule\(s\) lib are not committed/.test(l)));
      // the main repository's change is committed, the submodule pointer is not
      assert.match(git(bare, 'show', 'kurultay/SB-1:calc.c'), /a \+ b/);
      assert.equal(git(bare, 'diff', '--name-only', 'main', 'kurultay/SB-1').trim(), 'calc.c');
      // a submodule that cannot be fetched: a warning, the work goes on
      const broken = new GitRepo(join(tmpProject({}), 'w'), {});
      await broken.sync(pathToFileURL(bare).href);
      git(broken.dir, 'checkout', '-q', 'origin/main');
      writeFileSync(join(broken.dir, '.gitmodules'), '[submodule "gone"]\n\tpath = gone\n\turl = file:///nowhere/gone.git\n');
      const sm = await broken.submodules();
      assert.deepEqual(sm.paths, ['gone']);
    } finally {
      for (const [k, v] of [['GIT_CONFIG_COUNT', prev.c], ['GIT_CONFIG_KEY_0', prev.k], ['GIT_CONFIG_VALUE_0', prev.v]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('the repository written in the issue: @kurultay{repo:<url>} – no gitlab.repo needed', async () => {
    const bare = remote();
    const url = pathToFileURL(bare).href;
    const fake = await fakeServers([
      { key: 'RP-1', summary: 'own repo', description: `Fix add. @kurultay{repo:<${url}>}` },
      { key: 'RP-2', summary: 'none', description: '@kurultay but no repository anywhere' },
    ]);
    const home = tmpProject({});
    const cfg = join(home, 'config.json');
    writeFileSync(cfg, JSON.stringify({ endpoints: [{ name: 'e', baseUrl: 'http://127.0.0.1:1/v1' }], jira: { url: fake.url, token: 't', pollSeconds: 0.05 }, gitlab: { url: fake.url, token: 'g', workDir: join(home, 'work') } }));
    const tasks: string[] = [];
    const r = await new JiraWorker({
      config: cfg,
      home,
      run: async (root, task) => {
        tasks.push(task);
        writeFileSync(join(root, 'calc.c'), 'int add(int a, int b) { return a + b; }\n');
        return ok(['calc.c']);
      },
    }).pass();
    assert.deepEqual(r.done.map((d) => [d.key, d.status]), [['RP-1', 'merge-request'], ['RP-2', 'no-repo']]);
    assert.match(git(bare, 'show', 'kurultay/RP-1:calc.c'), /a \+ b/);
    assert.doesNotMatch(tasks[0], /repo:|@kurultay|\{/, 'the setting is not part of the task');
    assert.match(fake.comments('RP-2')[0], /@kurultay\{repo:<url>\}/);
  });

  it('the user configuration template names every value to fill in', async () => {
    const { placeholdersIn, loadConfig } = await import('../../src/config.js');
    const text = readFileSync(new URL('../../../config_template.json', import.meta.url), 'utf8');
    const left = placeholdersIn(JSON.parse(text));
    assert.deepEqual(left, ['baseUrl', 'apiKey', 'models[0]', 'models[1]', 'helper.baseUrl', 'helper.models[0]', 'jira.url', 'jira.token', 'gitlab.repo', 'gitlab.token']);
    const dir = tmpProject({ 'kurultay.config.json': text });
    assert.throws(() => loadConfig(dir), /still has values to fill in: baseUrl, apiKey, .*jira\.url.* – replace each <\.\.\.>/);
    // filled in (and the unused sections deleted): it loads
    const cfg = JSON.parse(text) as Record<string, unknown>;
    Object.assign(cfg, { baseUrl: 'http://10.0.0.5:8000/v1', apiKey: 'none', models: ['qwen3-coder'] });
    delete cfg.helper;
    delete cfg.jira;
    delete cfg.gitlab;
    writeFileSync(join(dir, 'kurultay.config.json'), JSON.stringify(cfg));
    assert.equal(loadConfig(dir).config.endpoints[0].baseUrl, 'http://10.0.0.5:8000/v1');
  });
});
