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
        'e',
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
    assert.match(out, /LLM ayarları\s+1 endpoint \(1 erişilebilir\) · 2 model/);
    assert.match(out, /mock-coder-strong@mock/);
    // workspace is mandatory
    assert.match(out, /Çalışma alanı seçin \(zorunlu/);
    assert.match(out, /❯ \/run too early\nÖnce çalışma alanı seçilmeli\./);
    assert.match(out, /❯ clamp nedir\?\nKlasör bulunamadı/);
    assert.match(out, /Klasör bulunamadı: .*nope/);
    // automatic preparation
    assert.match(out, /✓ indeks: 3 dosya/);
    assert.match(out, /hızlı yetenek analizi/);
    assert.match(out, /✓ yetenek analizi: 2\/2 model erişilebilir/);
    assert.match(out, /mimari analiz: \d+ dosya özetlenecek/);
    assert.ok(existsSync(join(proj, '.kurultay', 'ARCHITECTURE.md')));
    assert.ok(existsSync(join(h, 'capabilities.json')), 'probe results are cached for every workspace');
    assert.match(out, /1 skill: log-format/);
    // question → council, follow-up keeps history
    assert.match(out, /→ soru: modeller konsey olarak cevaplayacak/);
    assert.match(out, /— konsey: .*mock-coder/);
    // task → orchestrator with confirmation
    assert.match(out, /→ görev: planlanıp modellere dağıtılacak/);
    assert.match(out, /Projeye uygulansın mı\? \[e\/H\] e/);
    assert.match(out, /Sonuç: completed · 1 dosya/);
    assert.match(readFileSync(join(proj, 'src/mathutil.js'), 'utf8'), /Math\.min\(Math\.max/);
    assert.match(out, /\+ {2}return Math\.min/);
    assert.match(out, /Kurultay Çalışma Raporu\n═+/, 'report rendered as markdown');
    assert.match(out, /Geri almak için: \/rewind/);
    assert.match(out, / 1\) clamp fonksiyonu nerede\?\s+3 tur/, 'conversation saved with its turns');
    assert.match(out, /\d{4}-\d\d-\d\dT\S+\s+completed\s+Implement clamp in src\/mathutil\.js\n/);
    // settings
    assert.match(out, /Mod: race/);
    assert.match(out, /Geçersiz mod: bogus/);
    assert.match(out, /split\s+alt görevler farklı modellerde paralel/);
    assert.match(out, /Girdi yorumu: ask/);
    assert.match(out, /auto, ask veya run/);
    assert.match(out, /dry-run: açık/);
    assert.match(out, /onaysız uygula: açık/);
    assert.match(out, /ayrıntılı günlük: açık/);
    assert.match(out, /log-format\s+Log satırı biçimi/);
    assert.match(out, /Baştan yüklenecek skill'ler: log-format/);
    assert.match(out, /Skill bulunamadı: nope/);
    assert.match(out, /src\/mathutil\.js:1-/);
    assert.match(out, /Sonuç yok\./);
    assert.match(out, /Kullanım: \/search/);
    assert.match(out, /42\n\(çıkış kodu 0\)/);
    assert.match(out, /Komut yazın/);
    assert.match(out, /Bilinmeyen komut: \/frobnicate/);
    if (process.platform !== 'win32') assert.match(out, /Bu bir klasör yolu\. Çalışma alanını değiştirmek için: \/workspace/);
    assert.match(out, /Ayarlar: mod race · girdi ask · dry-run açık · onaysız uygula açık · skill log-format/);
    assert.match(out, /Çalışma alanı: .*\n/);
    assert.match(out, /Yeni oturum başladı/);
    assert.match(out, /\/run <görev>\s+görevi planla/);
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
    assert.match(r.out, /1\) .*\s+şu anki klasör/);
    assert.match(r.out, /2\) .*\s+son kullanım/);
    assert.match(r.out, /Listede 9 numaralı seçenek yok/);
    assert.match(r.out, /Çalışma alanı: .*\n/);
    assert.match(r.out, /Klasör bulunamadı: .*missing/);
    assert.ok(r.out.includes(`b.c`) || /indeks: 1 dosya/.test(r.out));
    const bad = await session(['/exit'], { cwd: a, workspace: '/definitely/not/here', ...opts });
    assert.match(bad.out, /Klasör bulunamadı: .*definitely.not.here/);
    assert.equal(bad.code, 0, '/exit at the workspace prompt quits cleanly');
    const eof = await session([], { cwd: a, ...opts });
    assert.equal(eof.code, 0);
  });

  it('first run without configuration: setup wizard writes ~/.kurultay/config.json', async () => {
    const h = home(false);
    const proj = tmpProject({ 'main.c': 'int main(void){return 0;}' });
    const r = await session(['', 'not a url', 'x', '', mock.url, 'yerel', '', '/models', proj, '/exit'], { cwd: proj, autoProbe: false, autoAnalyze: false });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /LLM yapılandırması bulunamadı/);
    assert.match(r.out, /geçersiz baseUrl/);
    const cfg = JSON.parse(readFileSync(join(h, 'config.json'), 'utf8'));
    assert.deepEqual(cfg.endpoints, [{ name: 'yerel', baseUrl: mock.url, apiKey: 'none' }]);
    assert.match(r.out, /LLM ayarları\s+1 endpoint \(1 erişilebilir\)/);
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
    assert.match(r.out, /Bilinmeyen ayar: nonsense/);
    assert.match(r.out, /llm\.idleTimeoutMs sıfır veya pozitif/);
    assert.match(r.out, /dead\s+http:\/\/127\.0\.0\.1:9\/v1\s+0 model\s+● /, 'unreachable endpoint shown with its error');
    assert.match(r.out, /geçersiz baseUrl/);
    assert.match(r.out, /Kullanım: \/endpoint add/);
    assert.match(r.out, /Endpoint yok: ghost/);
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
    assert.match(comp('/')!.items.find((i) => i.value === '/run ')!.description!, /çalışma alanı gerekir/);
    assert.deepEqual(comp('/mo')!.items.map((i) => i.value), ['/models', '/mode ']);
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
    assert.ok(comp('/workspace ')!.items.some((i) => i.description === 'son kullanılan'));
    assert.equal(comp('plain text'), undefined);
    input.end();
  });

  it('sessions: every turn is saved; resume, branch, history and rewind (code + conversation)', async () => {
    home();
    const proj = tmpProject({ ...CLAMP_PROJECT });
    const opts = { cwd: proj, workspace: proj, autoProbe: false, autoAnalyze: false };
    const read = () => readFileSync(join(proj, 'src/mathutil.js'), 'utf8');
    const first = await session(['/history', '/rewind', '/branch', 'clamp nerede?', 'Implement clamp in src/mathutil.js', 'e', '/history', '/branch deneme dalı', '/sessions', '/rewind 9', '/rewind', '', '/rewind 2', 'h', '/rewind 2', 'e', '/history', '/exit'], opts);
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /Bu oturumda henüz tur yok/);
    assert.match(first.out, /Geri alınacak tur yok/);
    assert.match(first.out, /Dallandırılacak bir konuşma yok/);
    assert.match(first.out, /#1 soru {2}clamp nerede\?\n\s+#2 görev Implement clamp in src\/mathutil\.js \[1 dosya uygulandı\]/);
    assert.match(first.out, /✓ dal oluşturuldu: deneme dalı/);
    assert.match(first.out, /● {2}1\) deneme dalı\s+2 tur .*⑂/, 'branch is current and points to its parent');
    assert.match(first.out, /2\) clamp nerede\?\s+2 tur/);
    assert.match(first.out, /Geçersiz tur: 9/);
    assert.match(first.out, /Hangi turun öncesine dönülsün\? \[1-2, boş = vazgeç\] ❯ \nVazgeçildi\./);
    assert.match(first.out, /1 görevin uyguladığı 1 dosya eski hâline dönecek: src\/mathutil\.js/);
    assert.match(first.out, /Geri alınsın mı\? \[e\/H\] h\nVazgeçildi\./);
    assert.match(first.out, /↶ #2: 1 dosya geri yüklendi/);
    assert.match(first.out, /#2 öncesine dönüldü \(1 tur konuşmadan çıkarıldı, kod geri alındı\)/);
    assert.match(read(), /TODO/, 'rewind restored the original file');

    // a new console continues the latest conversation (the branch, now 1 turn)
    const second = await session(['/resume 2', '/rewind 2', '/resume 7', '/sessions', '/exit'], { ...opts, resume: true });
    assert.match(second.out, /✓ oturuma devam: deneme dalı \(1 tur/);
    assert.match(second.out, /#1 soru: clamp nerede\?/);
    assert.match(second.out, /✓ oturuma devam: clamp nerede\? \(2 tur/);
    assert.match(second.out, /#2 öncesine dönüldü \(1 tur konuşmadan çıkarıldı\)/, 'already rewound code is not touched again');
    assert.match(second.out, /Oturum bulunamadı: 7/);
    const third = await session(['/exit'], opts);
    assert.match(third.out, /son oturum: ".*" \(1 tur, az önce\) — devam etmek için \/resume/);
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
    assert.match(noGit.out, /git deposu değil/);
    const main = () => readFileSync(join(proj, 'src/mathutil.js'), 'utf8');
    const r = await session(
      ['/worktree', '/worktree diff', '/worktree new Özellik 1', '/worktree list', 'Implement clamp in src/mathutil.js', 'e', '/worktree diff', '/worktree exit', '/worktree exit', '/worktree merge nope', '/worktree merge ozellik-1', 'e', '/worktree remove ozellik-1', 'e', '/worktree list', '/worktree bogus', '/exit'],
      { cwd: proj, workspace: proj, autoProbe: false, autoAnalyze: false },
    );
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /worktree yok — \/worktree new <ad>/);
    assert.match(r.out, /Hangi worktree\? \/worktree diff <ad>/);
    assert.match(r.out, /✓ worktree: .*ozellik-1 \(dal kurultay\/ozellik-1\)/);
    assert.match(r.out, /● ozellik-1\s+kurultay\/ozellik-1/);
    assert.match(r.out, /Sonuç: completed/);
    assert.match(r.out, /\+\s*return Math\.min/, 'worktree diff shows the change');
    assert.match(r.out, /worktree korunuyor/);
    assert.match(r.out, /Zaten ana depodasınız/);
    assert.match(r.out, /Worktree yok: nope/);
    assert.match(r.out, /✓ kurultay\/ozellik-1 birleştirildi/);
    assert.match(main(), /Math\.min\(Math\.max/, 'merged into the main branch');
    assert.match(r.out, /✓ ozellik-1 silindi/);
    assert.match(r.out, /Kullanım: \/worktree new <ad>/);
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
    await waitFor(/Kurultay toplandı/);
    input.write('\x03');
    // typed while the task is still stopping: replayed at the next prompt
    input.write('/exit\r');
    await waitFor(/Görev iptal edildi\./);
    assert.equal(await done, 0);
    assert.match(readFileSync(join(proj, 'src/mathutil.js'), 'utf8'), /TODO/, 'project untouched after cancel');
    await slow.close();
  });

  it('plan mode asks before writing code; /stats and /continue-run', async () => {
    home();
    const proj = tmpProject({ ...CLAMP_PROJECT });
    const { code, out } = await session(
      [proj, '/stats', '/continue-run', '/plan on', 'Implement clamp in src/mathutil.js', 'kenar durumlarını da test et', '', 'e', '/stats', '/plan off', '/exit'],
      { cwd: proj },
    );
    assert.equal(code, 0, out);
    assert.match(out, /henüz görev çalıştırılmadı/);
    assert.match(out, /Sürdürülecek yarım kalmış görev yok/);
    assert.match(out, /plan onayı: açık/);
    assert.match(out, /Plan \(\w+ modu[\s\S]*Plan onaylansın mı\?[\s\S]*kenar durumlarını da test et\nPlan geri bildirimle yeniden hazırlanıyor[\s\S]*Plan onaylansın mı\?/);
    assert.match(out, /Sonuç: completed/);
    assert.match(out, /Tüketim: \d+ istek/);
    assert.match(out, /Son görev: .* \d+ istek[\s\S]*Model[\s\S]*mock-coder/);
    assert.match(out, /plan onayı: kapalı/);
  });

  it('a run stopped by its budget is continued with /continue-run', async () => {
    const h = home();
    writeFileSync(join(h, 'config.json'), JSON.stringify({ endpoints: [{ name: 'mock', baseUrl: mock.url }], verify: { test: 'node test.js' }, skills: { includeUser: false }, orchestrator: { maxTokens: 1 } }));
    const proj = tmpProject({ ...CLAMP_PROJECT });
    const { code, out } = await session([proj, '/auto-apply on', 'Implement clamp in src/mathutil.js', '/continue-run', '/continue-run 1', '/continue-run bogus-id', '/exit'], { cwd: proj });
    assert.equal(code, 0, out);
    assert.match(out, /Durduruldu: token bütçesi doldu.*\/continue-run/);
    assert.ok((out.match(/Sonuç: incomplete/g) ?? []).length >= 3, out);
    assert.match(out, /Oturum bulunamadı: bogus-id/);
    assert.match(readFileSync(join(proj, 'src/mathutil.js'), 'utf8'), /TODO/, 'stopped runs never touch the project');
  });

  it('/mcp lists the tools of the configured MCP servers', async () => {
    const h = home();
    writeFileSync(join(h, 'config.json'), JSON.stringify({ endpoints: [{ name: 'mock', baseUrl: mock.url }], skills: { includeUser: false }, mcp: { servers: { tracker: { command: process.execPath, args: [script(FAKE_MCP)] } } } }));
    const proj = tmpProject({ ...CLAMP_PROJECT });
    const { code, out } = await session([proj, '/mcp', '/mcp restart', '/exit'], { cwd: proj });
    assert.equal(code, 0, out);
    assert.match(out, /✓ MCP: 3 araç \(tracker\)/);
    assert.match(out, /mcp__tracker__lookup_ticket \(salt okunur\)\s+\[MCP tracker\] Read a ticket/);
    assert.match(out, /mcp__tracker__create_ticket\s+\[MCP tracker\]/);
  });
});
