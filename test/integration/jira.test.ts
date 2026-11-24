import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';
import { GitRepo, projectOf, repoSlug } from '../../src/integrations/gitlab.js';
import { JiraClient, repoFor, taskOf, type JiraIssue } from '../../src/integrations/jira.js';
import { installStartup, JiraWorker } from '../../src/integrations/jira-worker.js';
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

/** Fake Jira (search, comment, transitions) and GitLab merge request API on one port. */
async function fakeServers(issues: Array<Partial<JiraIssue> & { key: string }>) {
  const calls: Call[] = [];
  const body = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const t = Buffer.concat(chunks).toString('utf8');
    return t ? (JSON.parse(t) as unknown) : undefined;
  };
  const server = createServer(async (req, res) => {
    const b = await body(req);
    calls.push({ method: req.method ?? '', url: req.url ?? '', auth: (req.headers.authorization as string) ?? (req.headers['private-token'] as string), body: b });
    const json = (code: number, v: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    if (req.url?.startsWith('/rest/api/2/search')) {
      return json(200, {
        issues: issues.map((i) => ({ key: i.key, fields: { summary: i.summary ?? 'x', description: i.description ?? '', status: { name: 'To Do' }, updated: '2026-11-24', project: { key: i.key.split('-')[0] } } })),
      });
    }
    if (req.url?.includes('/transitions') && req.method === 'GET') return json(200, { transitions: [{ id: '31', name: 'Start review', to: { name: 'In Review' } }] });
    if (req.url?.includes('/transitions')) return json(204, {});
    if (req.url?.includes('/comment')) return json(201, { id: '1' });
    if (req.url?.includes('/merge_requests')) return json(201, { web_url: 'https://gitlab.local/team/app/-/merge_requests/7', iid: 7 });
    return json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  closers.push(() => server.close());
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, calls };
}

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
    const t = taskOf(i, '@kurultay');
    assert.match(t, /^ABC-1: Fix add\n\nplease fix add\(\)/);
    assert.doesNotMatch(t, /@kurultay|repo:/);
    assert.match(t, /```add\(1,2\)```/);
    assert.deepEqual(projectOf('https://gitlab.local/team/app.git'), { base: 'https://gitlab.local', path: 'team/app' });
    assert.deepEqual(projectOf('https://srv.local/gitlab/team/app.git', 'https://srv.local/gitlab'), { base: 'https://srv.local/gitlab', path: 'team/app' });
    assert.deepEqual(projectOf('git@gitlab.local:team/app.git'), { base: 'https://gitlab.local', path: 'team/app' });
    assert.equal(repoSlug('https://user@gitlab.local/team/app.git'), 'gitlab.local_team_app');
  });

  it('clones, works on a branch, pushes, opens the merge request and comments the link on the issue – once', async () => {
    const bare = remote();
    const fake = await fakeServers([
      { key: 'ABC-1', summary: 'add() subtracts', description: 'add returns a-b. @kurultay fix it' },
      { key: 'ABC-2', summary: 'not for us', description: 'kurultay is mentioned without the @' },
    ]);
    const home = tmpProject({});
    const cfgFile = join(home, 'config.json');
    writeFileSync(cfgFile, JSON.stringify({ endpoints: [{ name: 'e', baseUrl: 'http://127.0.0.1:1/v1' }], jira: { url: fake.url, token: 'jira-pat', transition: 'In Review' }, gitlab: { repo: pathToFileURL(bare).href, url: fake.url, token: 'gl-token', workDir: join(home, 'work') } }));
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
    assert.match(git(bare, 'show', 'kurultay/ABC-1:calc.c'), /return a \+ b/);
    assert.equal(git(bare, 'log', '-1', '--format=%s', 'kurultay/ABC-1').trim(), 'ABC-1: add() subtracts');
    // merge request through the API, with the token
    const mr = fake.calls.find((c) => c.url.includes('/merge_requests'))!;
    assert.equal(mr.auth, 'gl-token');
    assert.deepEqual({ ...(mr.body as Record<string, unknown>), description: undefined }, { source_branch: 'kurultay/ABC-1', target_branch: 'main', title: 'ABC-1: add() subtracts', description: undefined, remove_source_branch: true });
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
    assert.ok(lines.some((l) => /would do NO-1 "where" in \(no repository\)/.test(l)));
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
    const w = installStartup({ platform: 'win32', appData, node: 'C:\\node\\node.exe', script: 'C:\\k\\bin\\kurultay.js' });
    assert.match(w.file, /Startup[\\/]kurultay-jira\.cmd$/);
    assert.match(readFileSync(w.file, 'utf8'), /start "Kurultay Jira" \/min "C:\\node\\node\.exe" "C:\\k\\bin\\kurultay\.js" jira --watch/);
    installStartup({ platform: 'win32', appData, remove: true });
    assert.equal(existsSync(w.file), false);
    const home = tmpProject({});
    const l = installStartup({ platform: 'linux', home, node: '/usr/bin/node', script: '/k/kurultay.js' });
    assert.match(readFileSync(l.file, 'utf8'), /Exec="\/usr\/bin\/node" "\/k\/kurultay\.js" jira --watch/);
  });
});
