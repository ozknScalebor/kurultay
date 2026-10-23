import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { LineEditor, type Completer } from '../../src/tui/editor.js';
import { KeyParser, displayWidth, fitWidth, stripAnsi, type Key } from '../../src/tui/keys.js';
import { banner, helpText, llmPanel, table } from '../../src/tui/panels.js';
import { Screen } from '../../src/tui/screen.js';
import { checkWorkspace, completePath, expandHome, loadState, looksLikeProject, rememberWorkspace, saveState, shortPath } from '../../src/tui/state.js';
import { classifyIntent, expandMentions } from '../../src/tui/console.js';
import { saveProfile } from '../../src/probe/profile.js';
import { readCapabilitiesFile } from '../../src/llm/models.js';
import { caps, config, routerFor, tmpProject } from '../helpers.js';

const k = (name: Key['name'], text?: string): Key => ({ name, text });
const type = (e: LineEditor, s: string) => e.handle(k('char', s));

describe('key parser', () => {
  it('parses text, control keys and escape sequences', () => {
    const p = new KeyParser();
    assert.deepEqual(p.feed('abç'), [k('char', 'abç')]);
    assert.deepEqual(
      p.feed('\x1b[A\x1b[B\x1b[C\x1b[D\x1b[H\x1b[F\x1b[3~\x1b[1~\x1b[4~\x1b[5~\x1b[6~\x1b[Z\x1b[1;5C\x1b[1;5D\x1bOH\x1b[99~').map((x) => x.name),
      ['up', 'down', 'right', 'left', 'home', 'end', 'delete', 'home', 'end', 'pageup', 'pagedown', 'shift-tab', 'word-right', 'word-left', 'home', 'unknown'],
    );
    assert.deepEqual(p.feed('\x7f\b\t\x03\x04\x01\x05\x0b\x0c\x15\x17\x02\x06\x10\x0e\x1f').map((x) => x.name), [
      'backspace', 'backspace', 'tab', 'ctrl-c', 'ctrl-d', 'ctrl-a', 'ctrl-e', 'ctrl-k', 'ctrl-l', 'ctrl-u', 'ctrl-w', 'left', 'right', 'up', 'down', 'unknown',
    ]);
    assert.deepEqual(p.feed('x\r\ny\nz\r').map((x) => x.name), ['char', 'enter', 'char', 'enter', 'char', 'enter']);
    assert.deepEqual(p.feed('\x1bb\x1bf\x1b\x7f\x1b').map((x) => x.name), ['word-left', 'word-right', 'ctrl-w', 'escape']);
  });

  it('collects bracketed paste across chunks', () => {
    const p = new KeyParser();
    assert.deepEqual(p.feed('a\x1b[200~line1\r\nli'), [k('char', 'a')]);
    assert.deepEqual(p.feed('ne2\x1b[201~b'), [k('paste', 'line1\nline2'), k('char', 'b')]);
  });

  it('measures display width', () => {
    assert.equal(displayWidth('abc'), 3);
    assert.equal(displayWidth('\x1b[31mçığ\x1b[0m'), 3);
    assert.equal(displayWidth('漢字'), 4);
    assert.equal(displayWidth('✅ ❯ ●'), 6);
    assert.equal(displayWidth('é'), 1);
    assert.equal(stripAnsi('\x1b[1;32mx\x1b[0m'), 'x');
    assert.equal(fitWidth('abcdef', 4), 'abc…');
    assert.equal(fitWidth('ab', 4), 'ab');
  });
});

describe('line editor', () => {
  it('edits text with cursor movement and word/line deletion', () => {
    const e = new LineEditor();
    type(e, 'hello world');
    e.handle(k('word-left'));
    type(e, 'big ');
    assert.equal(e.text, 'hello big world');
    e.handle(k('home'));
    e.handle(k('delete'));
    assert.equal(e.text, 'ello big world');
    e.handle(k('end'));
    e.handle(k('backspace'));
    e.handle(k('ctrl-w'));
    assert.equal(e.text, 'ello big ');
    e.handle(k('ctrl-a'));
    e.handle(k('word-right'));
    e.handle(k('ctrl-k'));
    assert.equal(e.text, 'ello');
    e.handle(k('left'));
    e.handle(k('ctrl-u'));
    assert.equal(e.text, 'o');
    e.handle(k('ctrl-e'));
    e.handle(k('right'));
    assert.equal(e.cursorPos, 1);
    e.handle(k('ctrl-a'));
    assert.equal(e.handle(k('ctrl-d')), undefined);
    assert.equal(e.text, '');
    assert.deepEqual(e.handle(k('ctrl-d')), { type: 'eof' });
    assert.deepEqual(e.handle(k('ctrl-l')), { type: 'clear-screen' });
    type(e, 'x');
    assert.equal(e.handle(k('ctrl-c')), undefined, 'first Ctrl+C clears the line');
    assert.deepEqual(e.handle(k('ctrl-c')), { type: 'interrupt' });
    type(e, 'abc');
    e.handle(k('escape'));
    assert.equal(e.text, '', 'Esc clears when no menu is open');
    e.handle(k('unknown'));
  });

  it('keeps history with the unsent draft', () => {
    const e = new LineEditor(undefined, ['one', 'two']);
    e.handle(k('down'));
    type(e, 'draft');
    e.handle(k('up'));
    assert.equal(e.text, 'two');
    e.handle(k('up'));
    e.handle(k('up'));
    assert.equal(e.text, 'one');
    e.handle(k('down'));
    e.handle(k('down'));
    assert.equal(e.text, 'draft');
    assert.deepEqual(e.handle(k('enter')), { type: 'submit', text: 'draft' });
    assert.deepEqual(e.history, ['one', 'two', 'draft']);
    e.handle(k('enter'));
    assert.equal(e.history.length, 3, 'empty lines are not stored');
    new LineEditor().handle(k('up'));
  });

  it('supports multi-line input via backslash-enter and paste, with vertical moves', () => {
    const e = new LineEditor();
    type(e, 'first\\');
    assert.equal(e.handle(k('enter')), undefined);
    type(e, 'second');
    e.handle(k('paste', '\r\nthird\tx'));
    assert.equal(e.text, 'first\nsecond\nthird  x');
    e.handle(k('up'));
    e.handle(k('up'));
    assert.equal(e.cursorPos, 5, 'column clamped to the shorter line');
    e.handle(k('down'));
    type(e, '!');
    assert.equal(e.text.split('\n')[1], 'secon!d');
    const v = e.view('> ', 20);
    assert.deepEqual(v.rows, ['> first', '  secon!d', '  third  x']);
    assert.equal(v.cursorRow, 1);
    assert.equal(v.cursorCol, 8);
  });

  it('wraps long lines and keeps the cursor position', () => {
    const e = new LineEditor();
    type(e, 'abcdefghijklmnop');
    const v = e.view('> ', 10);
    assert.deepEqual(v.rows, ['> abcdefgh', '  ijklmnop', '  ']);
    assert.equal(v.cursorRow, 2, 'cursor after a full row moves to the next one');
    assert.equal(v.cursorCol, 2);
    e.set('漢字漢字漢', 1);
    const w = e.view('> ', 10);
    assert.deepEqual(w.rows, ['> 漢字漢字', '  漢']);
    assert.equal(w.cursorCol, 4);
  });

  it('suggestion menu: palette auto-accepts, paths need navigation, Tab completes', () => {
    const cmds = ['help', 'mode', 'models'];
    const completer: Completer = (text, cursor) => {
      if (text.startsWith('/') && !text.includes(' ')) {
        const items = cmds.filter((c) => c.startsWith(text.slice(1))).map((c) => ({ value: `/${c}${c === 'mode' ? ' ' : ''}`, submit: c !== 'mode' }));
        return { items, from: 0, to: cursor, autoAccept: true };
      }
      if (text.startsWith('/mode ')) return { items: ['auto', 'race'].filter((m) => m.startsWith(text.slice(6))).map((m) => ({ value: m, description: 'x' })), from: 6, to: cursor, submitOnEnter: true };
      if (text.startsWith('cd ')) return { items: [{ value: 'cd src/' }, { value: 'cd src/' }].slice(0, text === 'cd ' ? 2 : 1), from: 0, to: cursor };
      return undefined;
    };
    const e = new LineEditor(completer);
    type(e, '/');
    assert.equal(e.menu?.items.length, 3);
    type(e, 'he');
    assert.deepEqual(e.handle(k('enter')), { type: 'submit', text: '/help' }, 'Enter runs the highlighted command');
    type(e, '/mo');
    e.handle(k('enter'));
    assert.equal(e.text, '/mode ', 'commands with arguments stop for the argument');
    assert.deepEqual(e.menu?.items.map((i) => i.value), ['auto', 'race'], 'argument menu opens right away');
    assert.deepEqual(e.handle(k('enter')), { type: 'submit', text: '/mode ' }, 'argument menus do not auto-accept');
    type(e, '/mode ');
    e.handle(k('down'));
    e.handle(k('shift-tab'));
    e.handle(k('down'));
    assert.deepEqual(e.handle(k('enter')), { type: 'submit', text: '/mode race' }, 'after navigating, Enter accepts and submits');
    type(e, '/mode r');
    e.handle(k('tab'));
    assert.equal(e.text, '/mode race');
    e.set('/');
    e.handle(k('escape'));
    assert.equal(e.menu, undefined);
    e.handle(k('right'));
    assert.equal(e.menu, undefined, 'dismissed menu stays closed while the text is unchanged');
    e.handle(k('tab'));
    assert.ok(e.menu, 'Tab reopens it');
    e.handle(k('up'));
    e.handle(k('escape'));
    e.set('/mode ');
    e.handle(k('escape'));
    e.handle(k('tab'));
    e.set('/m');
    const v = e.view('> ', 40, 1);
    assert.equal(v.menuRows, 2, 'one item plus "more" row');
    assert.match(v.rows[1], /\/mode|\/models/);
    assert.match(v.rows[2], /1 more/);
    const plain = new LineEditor();
    plain.handle(k('tab'));
    assert.equal(plain.menu, undefined);
  });
});

function fakeTerm(interactive: boolean) {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (on: boolean) => void };
  const output = new PassThrough() as PassThrough & { isTTY?: boolean; columns?: number };
  let text = '';
  output.on('data', (d) => (text += String(d)));
  let raw: boolean | undefined;
  if (interactive) {
    input.isTTY = true;
    output.isTTY = true;
    output.columns = 60;
    input.setRawMode = (on) => {
      raw = on;
    };
  }
  return { io: { input, output }, input, text: () => text, raw: () => raw };
}

describe('screen', () => {
  it('line mode: reads queued lines, echoes them and returns null at EOF', async () => {
    const t = fakeTerm(false);
    const s = new Screen(t.io);
    assert.equal(s.interactive, false);
    t.input.write('first\nsec');
    assert.equal(await s.readLine('> '), 'first');
    t.input.write('ond\r\n');
    assert.equal(await s.readLine('> '), 'second');
    t.input.write('y\n');
    assert.equal(await s.confirm('ok?'), true);
    s.print('hello');
    t.input.end('tail');
    assert.equal(await s.readLine('> '), 'tail');
    assert.equal(await s.readLine('> '), null);
    assert.match(t.text(), /> first\n> second\nok\? \[y\/N\] y\nhello\n> tail\n> \n/);
    s.close();
  });

  it('interactive: raw mode, rendering, printing above the prompt, busy Ctrl+C and double Ctrl+C exit', async () => {
    const t = fakeTerm(true);
    const s = new Screen(t.io, { history: ['old'] });
    assert.equal(s.interactive, true);
    assert.equal(t.raw(), true);
    let exits = 0;
    s.onExitRequest = () => exits++;
    t.input.write('\x03');
    assert.equal(exits, 1, 'Ctrl+C with no prompt and no busy task asks to exit');
    let aborted = 0;
    const release = s.busy(() => aborted++);
    t.input.write('\x03');
    assert.equal(aborted, 1);
    release();
    const p = s.readLine('❯ ', (text) => (text === '/' ? { items: [{ value: '/help', description: 'yardım', submit: true }], from: 0, to: 1, autoAccept: true } : undefined));
    t.input.write('/');
    await new Promise((r) => setImmediate(r));
    assert.match(t.text(), /› \/help/);
    s.print('log line');
    t.input.write('\r');
    assert.equal(await p, '/help');
    assert.match(t.text(), /log line\r\n/);
    const q = s.readLine('❯ ');
    t.input.write('\x1b[A');
    t.input.write('\x0c');
    t.input.write('\r');
    assert.equal(await q, '/help', 'history recall');
    const r = s.readLine('❯ ');
    t.input.write('\x03');
    await new Promise((res) => setImmediate(res));
    assert.match(t.text(), /press Ctrl\+C again/);
    t.input.write('\x03');
    assert.equal(await r, null);
    const d = s.readLine('❯ ');
    t.input.write('\x04');
    assert.equal(await d, null);
    s.close();
    assert.equal(t.raw(), false);
    assert.match(t.text(), /\x1b\[\?2004h/);
    assert.match(t.text(), /\x1b\[\?2004l/);
  });
});

describe('console helpers', () => {
  it('classifies questions and tasks', () => {
    for (const q of ['clamp nerede?', 'nasıl çalışıyor bu modül', 'açıkla: uart sürücüsü', 'What does main do', 'bu fonksiyon ne yapar', 'build sistemi nedir', 'uart kullanılıyor mu', 'explain the router', '']) assert.equal(classifyIntent(q), 'ask', q);
    for (const t of ['clamp fonksiyonunu yaz', 'Implement clamp in src/mathutil.js', 'uart sürücüsüne timeout ekle', 'refactor the parser', 'testleri düzelt']) assert.equal(classifyIntent(t), 'run', t);
  });

  it('expands @mentions of existing files only', () => {
    const r = expandMentions('fix @src/a.c and @missing.c, see @src/b.h.', (p) => p === 'src/a.c' || p === 'src/b.h');
    assert.equal(r.text, 'fix src/a.c and @missing.c, see src/b.h.');
    assert.deepEqual(r.files, ['src/a.c', 'src/b.h']);
    assert.deepEqual(expandMentions('mail me@host.com', () => true).files, []);
  });

  it('workspace checks, path completion and recent list', () => {
    const root = tmpProject({ 'proj/src/a.c': 'int a;', 'proj/Makefile': 'all:', 'plain/readme.txt': 'x', 'file.txt': 'x' });
    assert.equal(checkWorkspace('proj', root).path, join(root, 'proj'));
    assert.match(checkWorkspace('nope', root).error!, /not found/);
    assert.match(checkWorkspace('file.txt', root).error!, /Not a folder/);
    assert.match(checkWorkspace('', root).error!, /Enter a folder path/);
    assert.match(checkWorkspace('/', root).error!, /root/);
    assert.match(checkWorkspace('~', root).error!, /home folder/);
    assert.equal(looksLikeProject(join(root, 'proj')), true);
    assert.equal(looksLikeProject(join(root, 'plain')), false);
    assert.equal(looksLikeProject(join(root, 'missing')), false);
    assert.deepEqual(completePath('pr', root).map((s) => s.value), ['proj/']);
    assert.deepEqual(completePath('proj/', root).map((s) => s.value), ['proj/src/']);
    assert.deepEqual(completePath('proj/', root, false).map((s) => s.label), ['Makefile', 'src/']);
    assert.deepEqual(completePath('zzz/', root), []);
    assert.equal(expandHome('~/x'), join(homedir(), 'x'));
    assert.equal(shortPath(join(homedir(), 'p')), `~${sep}p`);
    if (!join(root, 'x').startsWith(homedir())) assert.equal(shortPath(join(root, 'x')), join(root, 'x'));
    const prev = process.env.KURULTAY_HOME;
    process.env.KURULTAY_HOME = join(root, 'home');
    try {
      assert.deepEqual(loadState(), { recent: [], history: [] });
      const st = loadState();
      rememberWorkspace(st, '/a');
      rememberWorkspace(st, '/b');
      rememberWorkspace(st, '/a');
      st.history.push('x');
      saveState(st);
      const back = loadState();
      assert.deepEqual(back.recent.map((r) => r.path), ['/a', '/b']);
      assert.deepEqual(back.history, ['x']);
      writeFileSync(join(root, 'home', 'console.json'), '{"recent": 5, "history": [1, "y"]}');
      assert.deepEqual(loadState(), { recent: [], history: ['y'] });
      writeFileSync(join(root, 'home', 'console.json'), 'not json');
      assert.deepEqual(loadState(), { recent: [], history: [] });
      // the saved capability profile merges per model
      const m = (id: string, ep: string) => caps(id, ep);
      saveProfile({ version: 1, generatedAt: 'a', models: [m('x', 'e1'), m('y', 'e2')] });
      saveProfile({ version: 1, generatedAt: 'b', models: [m('z', 'e1'), { ...m('x', 'e1'), notes: ['again'] }] });
      const saved = readCapabilitiesFile(join(root, 'home', 'capabilities.json'))!.models;
      assert.deepEqual(saved.map((c) => c.key).sort(), ['x@e1', 'y@e2', 'z@e1']);
      assert.deepEqual(saved.find((c) => c.key === 'x@e1')!.notes, ['again']);
    } finally {
      if (prev === undefined) delete process.env.KURULTAY_HOME;
      else process.env.KURULTAY_HOME = prev;
    }
  });

  it('renders banner, tables, the LLM panel and help', () => {
    assert.match(stripAnsi(banner('1.2.3', 80)), /v1\.2\.3/);
    assert.match(stripAnsi(banner('1.2.3', 30)), /^KURULTAY {2}v1\.2\.3/);
    assert.deepEqual(table([['a', 'bb', 'c'], ['long-cell', 'x', 'y']], [4, 3]), ['a     bb   c', 'lon…  x    y']);
    const cfg = config({ endpoints: [{ name: 'gpu', baseUrl: 'http://h/v1' }, { name: 'dead', baseUrl: 'http://d/v1' }] });
    const router = routerFor(cfg, [caps('m1', 'gpu', { tokensPerSec: 55, contextWindow: 32768 }), caps('m2', 'gpu', { nativeTools: false })]);
    const panel = stripAnsi(
      llmPanel({ config: cfg, configPath: '/x/config.json', router, probed: false, width: 100, health: [{ name: 'gpu', baseUrl: 'http://h/v1', ok: true, ms: 12, models: ['m1', 'm2'] }, { name: 'dead', baseUrl: 'http://d/v1', ok: false, ms: 5000, models: [], error: 'no answer within 5 s' }] }),
    );
    assert.match(panel, /2 endpoints \(1 reachable\) · 2 models/);
    assert.match(panel, /capability profile: none \(\/probe\)/);
    assert.match(panel, /gpu\s+http:\/\/h\/v1\s+2 models\s+● 12 ms/);
    assert.match(panel, /dead.*no answer within 5 s/);
    assert.match(panel, /m1@gpu\s+32K\s+native\s+55/);
    assert.match(panel, /m2@gpu\s+\d+K\s+prompt/);
    assert.match(panel, /first token 3 min · silence 90 s · total 10 min/);
    const empty = stripAnsi(llmPanel({ config: cfg, router: routerFor(cfg, []), probed: true, width: 80 }));
    assert.match(empty, /No usable model/);
    assert.match(empty, /gpu\s+http:\/\/h\/v1\s+0 models\s+\?/);
    const h = stripAnsi(helpText([{ name: 'run', args: '<görev>', description: 'yap' }, { name: 'exit', description: 'çık' }]));
    assert.match(h, /\/run <görev>\s+yap/);
    assert.match(h, /@file/);
  });
});
