import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { DEFAULT_MOCK_MODELS, startMockServer, type MockServerHandle } from '../../src/mock/server.js';
import { KurultayConsole, type ConsoleOptions } from '../../src/tui/console.js';
import { stripAnsi } from '../../src/tui/keys.js';
import { CLAMP_PROJECT, tmpProject } from '../helpers.js';
import { FAKE_MCP, script } from '../fixtures.js';

let mock: MockServerHandle;
const prevHome = process.env.KURULTAY_HOME;
before(async () => {
  mock = await startMockServer(DEFAULT_MOCK_MODELS);
});
after(async () => {
  await mock.close();
  if (prevHome === undefined) delete process.env.KURULTAY_HOME;
  else process.env.KURULTAY_HOME = prevHome;
});

/** A fresh per-user Kurultay folder with (optionally) a global config pointing at the mock server. */
function home(withConfig = true, url?: string): string {
  const dir = tmpProject({});
  process.env.KURULTAY_HOME = dir;
  if (withConfig) writeFileSync(join(dir, 'config.json'), JSON.stringify({ endpoints: [{ name: 'mock', baseUrl: url ?? mock.url }], verify: { test: 'node test.js' }, skills: { includeUser: false } }));
  return dir;
}

async function session(lines: string[], opts: Partial<ConsoleOptions> & { cwd: string }) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (d) => (text += String(d)));
  const c = new KurultayConsole({ input, output }, { version: '9.9.9', healthTimeoutMs: 3000, ...opts });
  input.end(lines.join('\n') + '\n');
  const code = await c.run();
  return { code, out: stripAnsi(text), console: c };
}

describe('Kurultay console', () => {
  it('shows the LLM panel, requires a workspace, prepares it automatically, then answers and works', async () => {
    const h = home();
    const proj = tmpProject({ ...CLAMP_PROJECT, '.kurultay/skills/log-format/SKILL.md': '---\nname: log-format\ndescription: Log satırı biçimi\n---\nLOG' });
    const cwd = tmpProject({ 'notes.txt': 'not a project' });
    const { code, out } = await session(
      [
        '/run too early',
        'clamp nedir?',
        '/models',
        join(proj, 'nope'),
        proj,
        'clamp fonksiyonu nerede?',
        'peki nasıl test ediliyor?',
        'Implement clamp in @src/mathutil.js',
        'y',
        '/diff',
        '/report',
        '/runs',
        '/sessions',
        '/mode race',
        '/mode bogus',
        '/mode',
        '/intent ask',
        '/intent maybe',
        '/dry-run on',
        '/auto-apply',
        '/verbose on',
        '/verbose off',
        '/skills',
        '/skills log-format',
        '/skills nope',
        '/search clamp',
        '/search zzzqqq',
        '/search',
        '/map clamp',
        '!node -e "console.log(40+2)"',
        '!',
        '/frobnicate',
        ...(process.platform === 'win32' ? [] : [proj]),
        '/status',
        '/index',
        '/workspace',
        '/clear',
        '/help',
        '/exit',
      ],
      { cwd },
    );
    assert.equal(code, 0, out);
    // startup: banner + LLM panel
    assert.match(out, /v9\.9\.9/);
    assert.match(out, /LLM settings\s+1 endpoint \(1 reachable\) · 2 models/);
    assert.match(out, /mock-coder-strong@mock/);
    // workspace is mandatory
    assert.match(out, /Select a workspace \(required/);
    assert.match(out, /❯ \/run too early\nSelect a workspace first\./);
    assert.match(out, /❯ clamp nedir\?\nFolder not found/);
    assert.match(out, /Folder not found: .*nope/);
    // automatic preparation
    assert.match(out, /✓ index: 3 files/);
    assert.match(out, /capability probe for 2 new models/);
    assert.match(out, /✓ capability probe: 2\/2 models reachable/);
    assert.match(out, /architecture analysis: \d+ files to summarise/);
    assert.ok(existsSync(join(proj, '.kurultay', 'ARCHITECTURE.md')));
    assert.ok(existsSync(join(h, 'capabilities.json')), 'probe results are cached for every workspace');
    assert.match(out, /1 skill: log-format/);
    // question → council, follow-up keeps history
    assert.match(out, /→ question: the models answer as a council/);
    assert.match(out, /– council: .*mock-coder/);
    // task → orchestrator with confirmation
    assert.match(out, /→ task: planned and spread over the models/);
    assert.match(out, /Apply to the project\? \[y\/N\] y/);
    assert.match(out, /Result: completed · 1 file/);
    assert.match(readFileSync(join(proj, 'src/mathutil.js'), 'utf8'), /Math\.min\(Math\.max/);
    assert.match(out, /\+ {2}return Math\.min/);
    assert.match(out, /Kurultay Run Report\n═+/, 'report rendered as markdown');
    assert.match(out, /undo: \/rewind/);
    assert.match(out, / 1\) clamp fonksiyonu nerede\?\s+3 turns/, 'conversation saved with its turns');
    assert.match(out, /\d{4}-\d\d-\d\dT\S+\s+completed\s+Implement clamp in src\/mathutil\.js\n/);
    // settings
    assert.match(out, /Mode: race/);
    assert.match(out, /Invalid mode: bogus/);
    assert.match(out, /split\s+subtasks run in parallel on different models/);
    assert.match(out, /Input is treated as: ask/);
    assert.match(out, /auto, ask or run/);
    assert.match(out, /dry-run: on/);
    assert.match(out, /auto-apply: on/);
    assert.match(out, /verbose log: on/);
    assert.match(out, /log-format\s+Log satırı biçimi/);
    assert.match(out, /Preloaded skills: log-format/);
    assert.match(out, /Skill not found: nope/);
    assert.match(out, /src\/mathutil\.js:1-/);
    assert.match(out, /No results\./);
    assert.match(out, /Usage: \/search/);
    assert.match(out, /42\n\(exit code 0\)/);
    assert.match(out, /Type a command/);
    assert.match(out, /Unknown command: \/frobnicate/);
    if (process.platform !== 'win32') assert.match(out, /That is a folder path\. To switch the workspace: \/workspace/);
    assert.match(out, /Settings: mode race · input ask · dry-run on · auto-apply on · skills log-format/);
    assert.match(out, /Workspace: .*\n/);
    assert.match(out, /New session started/);
    assert.match(out, /\/run <task>\s+plan the task/);
    // the workspace is remembered
    const state = JSON.parse(readFileSync(join(h, 'console.json'), 'utf8'));
    assert.equal(state.recent[0].path, proj);
    assert.ok(state.history.includes('/mode race'));
  });

  it('offers recent workspaces by number and opens a workspace given on the command line', async () => {
    home();
    const a = tmpProject({ 'a.c': 'int a;', Makefile: 'all:' });
    const b = tmpProject({ 'b.c': 'int b;' });
    const opts = { autoProbe: false, autoAnalyze: false };
    await session(['/exit'], { cwd: a, workspace: b, ...opts });
    const r = await session(['9', '2', '/workspace', `/workspace ${b}/missing`, '/exit'], { cwd: a, ...opts });
    assert.match(r.out, /1\) .*\s+current folder/);
    assert.match(r.out, /2\) .*\s+last used/);
    assert.match(r.out, /There is no option 9 in the list/);
    assert.match(r.out, /Workspace: .*\n/);
    assert.match(r.out, /Folder not found: .*missing/);
    assert.ok(r.out.includes(`b.c`) || /index: 1 file/.test(r.out));
    const bad = await session(['/exit'], { cwd: a, workspace: '/definitely/not/here', ...opts });
    assert.match(bad.out, /Folder not found: .*definitely.not.here/);
    assert.equal(bad.code, 0, '/exit at the workspace prompt quits cleanly');
    const eof = await session([], { cwd: a, ...opts });
    assert.equal(eof.code, 0);
  });

  it('first run without configuration: setup wizard writes ~/.kurultay/config.json', async () => {
    const h = home(false);
    const proj = tmpProject({ 'main.c': 'int main(void){return 0;}' });
    const r = await session(['', 'not a url', '', '', mock.url, 'main-key', 'mock-coder-strong', 'mock-coder-weak own-key', '', '/models', proj, '/exit'], { cwd: proj, autoProbe: false, autoAnalyze: false });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /No LLM configuration found/);
    assert.match(r.out, /Invalid baseUrl/);
    const cfg = JSON.parse(readFileSync(join(h, 'config.json'), 'utf8'));
    assert.deepEqual(cfg, { baseUrl: mock.url, apiKey: 'main-key', models: ['mock-coder-strong', { id: 'mock-coder-weak', apiKey: 'own-key' }] });
    assert.match(r.out, /LLM settings\s+1 endpoint \(1 reachable\)/);
    const quit = await session(['/exit'], { cwd: proj, config: join(proj, 'missing.json') });
    assert.equal(quit.code, 1, 'leaving the wizard without an endpoint exits with 1');
  });

  it('edits LLM settings and endpoints from the console and reports unreachable ones', async () => {
    const h = home();
    const proj = tmpProject({ 'a.c': 'int a;' });
    const r = await session(
      [
        proj,
        '/llm',
        '/llm set firstTokenTimeoutMs 120000',
        '/llm set stickyFailover off',
        '/llm set nonsense 1',
        '/llm set idleTimeoutMs -5',
        '/endpoint add dead http://127.0.0.1:9/v1',
        '/endpoint add bad not-a-url',
        '/endpoint',
        '/endpoint remove ghost',
        '/endpoint remove dead',
        '/exit',
      ],
      { cwd: proj, autoProbe: false, autoAnalyze: false },
    );
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /firstTokenTimeoutMs\s+180000/);
    assert.match(r.out, /Unknown setting: nonsense/);
    assert.match(r.out, /llm\.idleTimeoutMs must be zero or a positive/);
    assert.match(r.out, /dead\s+http:\/\/127\.0\.0\.1:9\/v1\s+0 models\s+● /, 'unreachable endpoint shown with its error');
    assert.match(r.out, /Invalid baseUrl/);
    assert.match(r.out, /Usage: \/endpoint add/);
    assert.match(r.out, /No endpoint named ghost/);
    const cfg = JSON.parse(readFileSync(join(h, 'config.json'), 'utf8'));
    assert.equal(cfg.llm.firstTokenTimeoutMs, 120000);
    assert.equal(cfg.llm.stickyFailover, false);
    assert.deepEqual(cfg.endpoints.map((e: { name: string }) => e.name), ['mock']);
  });

  it('completes commands, arguments, @files, $skills and paths', async () => {
    home();
    const proj = tmpProject({ ...CLAMP_PROJECT, 'docs/guide.md': '# g', '.agents/skills/c-style/SKILL.md': '---\nname: c-style\ndescription: C stili\n---\nx' });
    const input = new PassThrough();
    const c = new KurultayConsole({ input, output: new PassThrough() }, { version: 't', cwd: proj, autoProbe: false, autoAnalyze: false });
    const len = (s: string) => Array.from(s).length;
    const comp = (s: string) => c.complete(s, len(s));
    assert.ok(comp('/')!.items.length > 20);
    assert.match(comp('/')!.items.find((i) => i.value === '/run ')!.description!, /needs a workspace/);
    assert.deepEqual(comp('/mo')!.items.map((i) => i.value), ['/models', '/model ', '/mode ']);
    assert.equal(comp('/mo')!.autoAccept, true);
    assert.equal(comp('/mode')!.autoAccept, true, 'a command that takes arguments moves on to them');
    assert.equal(comp('/mode')!.items[0].value, '/mode ', 'exact match is highlighted before longer names');
    assert.equal(comp('/q')!.items[0].value, '/exit', 'aliases match exactly too');
    assert.equal(comp('/help')!.autoAccept, false, 'an exact command without arguments just runs');
    assert.deepEqual(comp('/ana')!.items.map((i) => i.value), ['/analyze ']);
    assert.deepEqual(comp('/lyz')!.items.map((i) => i.value), ['/analyze '], 'substring match');
    assert.equal(comp('/zzz'), undefined);
    assert.deepEqual(comp('/mode r')!.items.map((i) => i.value), ['race']);
    assert.deepEqual(comp('/intent ')!.items.map((i) => i.value), ['auto', 'ask', 'run']);
    assert.deepEqual(comp('/probe --d')!.items.map((i) => i.value), ['--deep']);
    assert.deepEqual(comp('/dry-run o')!.items.map((i) => i.value), ['on', 'off']);
    assert.deepEqual(comp('/llm s')!.items.map((i) => i.value), ['set ']);
    assert.ok(comp('/llm set first')!.items.some((i) => i.value === 'set firstTokenTimeoutMs '));
    assert.deepEqual(comp('/endpoint r')!.items.map((i) => i.value), ['remove ']);
    assert.equal(comp('/endpoint remove m'), undefined, 'no config loaded yet');
    assert.equal(comp('/status x'), undefined, 'command without argument completion');
    assert.equal(comp('/nosuch x'), undefined);
    assert.ok(comp(`/workspace ${proj}/d`)!.items.some((i) => i.value.endsWith('docs/')));
    assert.equal(comp('@src'), undefined, 'no index before a workspace is open');
    await c.openWorkspace(proj);
    assert.deepEqual(comp('fix @src/ma')!.items.map((i) => i.value), ['@src/mathutil.js ']);
    assert.ok(comp('@util')!.items.some((i) => i.value === '@src/mathutil.js '), 'substring file match');
    assert.equal(comp('@zzz'), undefined);
    assert.deepEqual(comp('use $c-')!.items.map((i) => i.value), ['$c-style ']);
    assert.equal(comp('$zz'), undefined);
    assert.deepEqual(comp('/skills c')!.items.map((i) => i.value), ['c-style']);
    assert.ok(comp('/workspace ')!.items.some((i) => i.description === 'recent'));
    assert.equal(comp('plain text'), undefined);
    input.end();
  });

  it('sessions: every turn is saved; resume, branch, history and rewind (code + conversation)', async () => {
    home();
    const proj = tmpProject({ ...CLAMP_PROJECT });
    const opts = { cwd: proj, workspace: proj, autoProbe: false, autoAnalyze: false };
    const read = () => readFileSync(join(proj, 'src/mathutil.js'), 'utf8');
    const first = await session(['/history', '/rewind', '/branch', 'clamp nerede?', 'Implement clamp in src/mathutil.js', 'y', '/history', '/branch deneme dalı', '/sessions', '/rewind 9', '/rewind', '', '/rewind 2', 'n', '/rewind 2', 'y', '/history', '/exit'], opts);
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /No turns in this session yet/);
    assert.match(first.out, /No turn to undo/);
    assert.match(first.out, /Nothing to branch/);
    assert.match(first.out, /#1 ask {2}clamp nerede\?\n\s+#2 task Implement clamp in src\/mathutil\.js \[1 file applied\]/);
    assert.match(first.out, /✓ branch created: deneme dalı/);
    assert.match(first.out, /● {2}1\) deneme dalı\s+2 turns .*⑂/, 'branch is current and points to its parent');
    assert.match(first.out, /2\) clamp nerede\?\s+2 turns/);
    assert.match(first.out, /Invalid turn: 9/);
    assert.match(first.out, /Go back to before which turn\? \[1-2, empty = cancel\] ❯ \nCancelled\./);
    assert.match(first.out, /1 file applied by 1 task will be restored: src\/mathutil\.js/);
    assert.match(first.out, /Undo\? \[y\/N\] n\nCancelled\./);
    assert.match(first.out, /↶ #2: 1 file restored/);
    assert.match(first.out, /back to before #2 \(1 turn removed from the conversation, code restored\)/);
    assert.match(read(), /TODO/, 'rewind restored the original file');

    // a new console continues the latest conversation (the branch, now 1 turn)
    const second = await session(['/resume 2', '/rewind 2', '/resume 7', '/sessions', '/exit'], { ...opts, resume: true });
    assert.match(second.out, /✓ continuing: deneme dalı \(1 turn/);
    assert.match(second.out, /#1 question: clamp nerede\?/);
    assert.match(second.out, /✓ continuing: clamp nerede\? \(2 turns/);
    assert.match(second.out, /back to before #2 \(1 turn removed from the conversation\)/, 'already rewound code is not touched again');
    assert.match(second.out, /Session not found: 7/);
    const third = await session(['/exit'], opts);
    assert.match(third.out, /last session: ".*" \(1 turn, just now\) – \/resume to continue/);
  });

  it('worktrees: work on a separate branch, see the diff, merge and remove', async (t) => {
    home();
    const proj = tmpProject({ ...CLAMP_PROJECT }, { git: true });
    const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: proj, stdio: 'pipe' }).toString();
    try {
      g('add', '-A');
      g('commit', '-q', '-m', 'init');
    } catch {
      t.skip('git yok');
      return;
    }
    const plain = tmpProject({ 'a.c': 'int a;' });
    const noGit = await session(['/worktree new x', '/exit'], { cwd: plain, workspace: plain, autoProbe: false, autoAnalyze: false });
    assert.match(noGit.out, /not a git repository/);
    const main = () => readFileSync(join(proj, 'src/mathutil.js'), 'utf8');
    const r = await session(
      ['/worktree', '/worktree diff', '/worktree new Özellik 1', '/worktree list', 'Implement clamp in src/mathutil.js', 'y', '/worktree diff', '/worktree exit', '/worktree exit', '/worktree merge nope', '/worktree merge ozellik-1', 'y', '/worktree remove ozellik-1', 'y', '/worktree list', '/worktree bogus', '/exit'],
      { cwd: proj, workspace: proj, autoProbe: false, autoAnalyze: false },
    );
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /no worktrees – \/worktree new <name>/);
    assert.match(r.out, /Which worktree\? \/worktree diff <name>/);
    assert.match(r.out, /✓ worktree: .*ozellik-1 \(branch kurultay\/ozellik-1\)/);
    assert.match(r.out, /● ozellik-1\s+kurultay\/ozellik-1/);
    assert.match(r.out, /Result: completed/);
    assert.match(r.out, /\+\s*return Math\.min/, 'worktree diff shows the change');
    assert.match(r.out, /the worktree is kept/);
    assert.match(r.out, /You are already in the main repo/);
    assert.match(r.out, /No worktree named nope/);
    assert.match(r.out, /✓ kurultay\/ozellik-1 merged/);
    assert.match(main(), /Math\.min\(Math\.max/, 'merged into the main branch');
    assert.match(r.out, /✓ ozellik-1 removed/);
    assert.match(r.out, /Usage: \/worktree new <name>/);
    assert.ok(!existsSync(join(proj, '.kurultay', 'worktrees', 'ozellik-1')));
    assert.doesNotMatch(g('log', '--name-only', '--format=%s'), /\.kurultay\//, 'Kurultay state never gets committed');
  });

  it('a running task can be cancelled with Ctrl+C', async () => {
    const slow = await startMockServer(DEFAULT_MOCK_MODELS.map((m) => ({ ...m, latencyMs: 400 })));
    home(true, slow.url);
    const proj = tmpProject({ ...CLAMP_PROJECT });
    mkdirSync(join(proj, '.kurultay'), { recursive: true });
    const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (b: boolean) => void };
    const output = new PassThrough() as PassThrough & { isTTY?: boolean; columns?: number };
    input.isTTY = true;
    output.isTTY = true;
    output.columns = 120;
    input.setRawMode = () => undefined;
    let text = '';
    output.on('data', (d) => (text += String(d)));
    const c = new KurultayConsole({ input, output }, { version: 't', cwd: proj, workspace: proj, autoProbe: false, autoAnalyze: false });
    const done = c.run();
    const waitFor = async (re: RegExp) => {
      for (let i = 0; i < 200 && !re.test(stripAnsi(text)); i++) await new Promise((r) => setTimeout(r, 20));
      assert.match(stripAnsi(text), re);
    };
    await waitFor(/❯ $/m);
    input.write('/run Implement clamp in src/mathutil.js\r');
    await waitFor(/Kurultay – \d+ models/);
    input.write('\x03');
    // typed while the task is still stopping: replayed at the next prompt
    input.write('/exit\r');
    await waitFor(/Task cancelled\./);
    assert.equal(await done, 0);
    assert.match(readFileSync(join(proj, 'src/mathutil.js'), 'utf8'), /TODO/, 'project untouched after cancel');
    await slow.close();
  });

  it('plan mode asks before writing code; /stats and /continue-run', async () => {
    home();
    const proj = tmpProject({ ...CLAMP_PROJECT });
    const { code, out } = await session(
      [proj, '/stats', '/continue-run', '/plan on', 'Implement clamp in src/mathutil.js', 'kenar durumlarını da test et', '', 'y', '/stats', '/plan off', '/exit'],
      { cwd: proj },
    );
    assert.equal(code, 0, out);
    assert.match(out, /This session: \d+ requests · [\d.K]+ in \/ [\d.K]+ out tokens/, 'workspace analysis already used the models');
    assert.match(out, /No unfinished task to continue/);
    assert.match(out, /plan approval: on/);
    assert.match(out, /Plan \(\w+ mode[\s\S]*Approve the plan\?[\s\S]*kenar durumlarını da test et\n\nRevising the plan with your feedback[\s\S]*Approve the plan\?/);
    assert.match(out, /Result: completed/);
    assert.match(out, /⟡ \d+ requests · [\d.K]+ in \/ [\d.K]+ out tokens · peak context \d+% \([\d.K]+\/[\d.K]+\) \(mock-/);
    assert.match(out, /Context of the last answer: [▰▱]{10} \d+% /);
    assert.match(out, /Model[│\s]+Requests[│\s]+In[│\s]+Out[│\s]+Avg\. response[│\s]+Peak context[\s\S]*mock-coder-\S+[│\s]+\d+[\s\S]*\d+% \/ 66K/);
    assert.match(out, /Last task: .* \d+ requests/);
    assert.match(out, /plan approval: off/);
  });

  it('a run stopped by its budget is continued with /continue-run', async () => {
    const h = home();
    writeFileSync(join(h, 'config.json'), JSON.stringify({ endpoints: [{ name: 'mock', baseUrl: mock.url }], verify: { test: 'node test.js' }, skills: { includeUser: false }, orchestrator: { maxTokens: 1 } }));
    const proj = tmpProject({ ...CLAMP_PROJECT });
    const { code, out } = await session([proj, '/auto-apply on', 'Implement clamp in src/mathutil.js', '/continue-run', '/continue-run 1', '/continue-run bogus-id', '/exit'], { cwd: proj });
    assert.equal(code, 0, out);
    assert.match(out, /Stopped: token budget used up.*\/continue-run/);
    assert.ok((out.match(/Result: incomplete/g) ?? []).length >= 3, out);
    assert.match(out, /Session not found: bogus-id/);
    assert.match(readFileSync(join(proj, 'src/mathutil.js'), 'utf8'), /TODO/, 'stopped runs never touch the project');
  });

  it('/mcp lists the tools of the configured MCP servers', async () => {
    const h = home();
    writeFileSync(join(h, 'config.json'), JSON.stringify({ endpoints: [{ name: 'mock', baseUrl: mock.url }], skills: { includeUser: false }, mcp: { servers: { tracker: { command: process.execPath, args: [script(FAKE_MCP)] } } } }));
    const proj = tmpProject({ ...CLAMP_PROJECT });
    const { code, out } = await session([proj, '/mcp', '/mcp restart', '/exit'], { cwd: proj });
    assert.equal(code, 0, out);
    assert.match(out, /✓ MCP: 3 tools \(tracker\)/);
    assert.match(out, /mcp__tracker__lookup_ticket \(read-only\)\s+\[MCP tracker\] Read a ticket/);
    assert.match(out, /mcp__tracker__create_ticket\s+\[MCP tracker\]/);
  });
});
