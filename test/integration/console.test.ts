import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { DEFAULT_MOCK_MODELS, startMockServer, type MockServerHandle } from '../../src/mock/server.js';
import { KurultayConsole, type ConsoleOptions } from '../../src/tui/console.js';
import { stripAnsi } from '../../src/tui/keys.js';
import { CLAMP_PROJECT, tmpProject } from '../helpers.js';

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
    assert.match(out, /\+  return Math\.min/);
    assert.match(out, /# Kurultay Raporu|## Görev/);
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
    assert.match(out, /Konuşma geçmişi temizlendi/);
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
});
