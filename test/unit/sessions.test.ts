import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { CheckpointRecorder, hashText, modifiedSince, readCheckpoint, rewindCheckpoint } from '../../src/agent/checkpoint.js';
import { Materializer, Overlay } from '../../src/agent/workspace.js';
import { branchConversation, findConversation, listConversations, loadConversation, newConversation, newConversationId, relativeTime, saveConversation } from '../../src/tui/conversation.js';
import { stripAnsi } from '../../src/tui/keys.js';
import { highlight, renderInline, renderMarkdown, wrap } from '../../src/tui/markdown.js';
import { Screen } from '../../src/tui/screen.js';
import { currentBranch, ignoreStateDir, listWorktrees, realPath, repoRoot, slugify } from '../../src/tui/worktree.js';
import { tmpProject } from '../helpers.js';

const settings = { intent: 'auto' as const, dryRun: false, autoApply: false, skills: ['a'] };

describe('checkpoints', () => {
  it('records before/after through Materializer.merge and rewinds it', async () => {
    const root = tmpProject({ 'a.txt': 'A', 'gone.txt': 'G', 'keep.txt': 'K' });
    const o = new Overlay('w', root);
    o.write('a.txt', 'A2');
    o.write('new/b.txt', 'B');
    o.delete('gone.txt');
    const rec = new CheckpointRecorder(root);
    await new Materializer(root, join(root, '.kurultay')).merge(o, undefined, rec);
    assert.equal(rec.size, 3);
    const file = join(root, '.kurultay', 'cp.json');
    rec.save(file, 'test');
    const cp = readCheckpoint(file)!;
    assert.equal(cp.label, 'test');
    assert.deepEqual(cp.files['a.txt'], { before: 'A', afterHash: hashText('A2') });
    assert.deepEqual(cp.files['new/b.txt'], { before: null, afterHash: hashText('B') });
    assert.deepEqual(cp.files['gone.txt'], { before: 'G', afterHash: null });
    assert.deepEqual(modifiedSince(root, cp), []);
    // the user edits a file afterwards: skipped unless forced
    writeFileSync(join(root, 'a.txt'), 'USER');
    assert.deepEqual(modifiedSince(root, cp), ['a.txt']);
    const r1 = rewindCheckpoint(root, file);
    assert.deepEqual(r1.skipped, ['a.txt']);
    assert.deepEqual(r1.restored.sort(), ['gone.txt', 'new/b.txt']);
    assert.equal(readFileSync(join(root, 'gone.txt'), 'utf8'), 'G');
    assert.ok(!existsSync(join(root, 'new/b.txt')));
    assert.equal(readCheckpoint(file)!.rewoundAt, undefined, 'partial rewind is not final');
    const r2 = rewindCheckpoint(root, file, { force: true });
    assert.ok(r2.restored.includes('a.txt'));
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'A');
    assert.ok(readCheckpoint(file)!.rewoundAt);
    assert.throws(() => rewindCheckpoint(root, file), /already undone/);
    assert.throws(() => rewindCheckpoint(root, join(root, 'missing.json')), /could not read/);
    writeFileSync(join(root, 'bad.json'), '{"version":2}');
    assert.equal(readCheckpoint(join(root, 'bad.json')), undefined);
    const empty = new CheckpointRecorder(root);
    empty.after('x');
    empty.before('keep.txt');
    empty.before('keep.txt');
    assert.equal(empty.size, 1);
    unlinkSync(join(root, 'keep.txt'));
    empty.after('keep.txt');
    assert.deepEqual(empty.save(join(root, 'e.json'), 'e').files['keep.txt'], { before: 'K', afterHash: null });
  });
});

describe('conversations', () => {
  it('save, list, find, branch', () => {
    const root = tmpProject({});
    const state = join(root, '.kurultay');
    assert.deepEqual(listConversations(state), []);
    const a = newConversation(root, settings);
    assert.match(a.id, /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-[a-z0-9]{1,4}$/);
    a.turns.push({ n: 1, at: 'x', kind: 'ask', input: 'ilk soru\nikinci satır', output: 'cevap' });
    saveConversation(state, a);
    assert.equal(a.title, 'ilk soru');
    const b = branchConversation(a, 1, ' ');
    assert.equal(b.title, 'ilk soru (branch)');
    assert.deepEqual(b.parent, { id: a.id, turn: 1 });
    b.turns.push({ n: 2, at: 'y', kind: 'run', input: 'yap', output: 'ok' });
    assert.equal(a.turns.length, 1, 'branch does not change the original');
    saveConversation(state, b);
    const empty = newConversation(root, settings);
    saveConversation(state, empty);
    writeFileSync(join(state, 'conversations', 'junk.json'), 'nope');
    const list = listConversations(state);
    assert.deepEqual(list.map((c) => c.id), [b.id, a.id], 'newest first, empty and broken ones skipped');
    assert.equal(findConversation(list, '1')?.id, b.id);
    assert.equal(findConversation(list, '3'), undefined);
    assert.equal(findConversation(list, a.id)?.id, a.id);
    assert.equal(findConversation(list, a.id.slice(0, a.id.length - 2))?.id, a.id.startsWith(b.id.slice(0, a.id.length - 2)) ? undefined : a.id);
    assert.equal(findConversation(list, 'zzz'), undefined);
    assert.equal(loadConversation(state, 'missing'), undefined);
    assert.equal(branchConversation(a, 0, 'x').turns.length, 0);
    assert.notEqual(newConversationId(), newConversationId());
    const now = Date.parse('2026-01-02T00:00:00Z');
    assert.equal(relativeTime('2026-01-01T23:59:30Z', now), 'just now');
    assert.equal(relativeTime('2026-01-01T23:30:00Z', now), '30 min ago');
    assert.equal(relativeTime('2026-01-01T20:00:00Z', now), '4 h ago');
    assert.equal(relativeTime('2025-12-30T00:00:00Z', now), '3 days ago');
  });
});

describe('markdown renderer', () => {
  const plain = (md: string, width = 60) => renderMarkdown(md, { width, ansi: false });

  it('renders block elements as readable text', () => {
    const out = plain(
      [
        '# Başlık',
        '## Alt',
        '### Küçük',
        '',
        'Paragraf **kalın** ve *italik* ve _alt_ ve ~~silik~~ ve `kod` ve [link](http://a.b) ve http-ish [http://x](http://x) ve ![resim](i.png).',
        '',
        '- bir',
        '  devamı',
        '  - iki',
        '- [ ] yapılacak',
        '- [x] bitti',
        '3. üç',
        '> alıntı',
        '***',
        '<details>',
        '<summary>Kaynak</summary>',
        '</details>',
        '',
        '| Sol | Orta | Sağ |',
        '|:----|:----:|----:|',
        '| a \\| b | c | 1 |',
        '| uzun hücre | d |',
        '',
        '```ts',
        'const x = 1; // yorum',
        '```',
        '```mermaid',
        'graph TD',
        '```',
      ].join('\n'),
    );
    assert.match(out, /^Başlık\n══════\nAlt\n───\nKüçük/);
    assert.match(out, /Paragraf kalın ve italik ve alt ve silik ve `kod` ve link\n?\s*\(http:\/\/a\.b\)/);
    assert.match(out, /\[resim: i\.png\]/);
    assert.match(out, /• bir devamı\n {2}◦ iki\n• ☐ yapılacak\n• ☑ bitti\n3\. üç/);
    assert.match(out, /│ alıntı/);
    assert.match(out, /─{20}/);
    assert.doesNotMatch(out, /details|summary/);
    assert.match(out, /│ Sol\s+│\s+Orta\s+│\s+Sağ │/);
    assert.match(out, /│ a \| b\s+│\s+c\s+│\s+1 │/);
    assert.match(out, /│ uzun hücre │\s+d\s+│\s+│/);
    assert.match(out, /┌ ts ─+\n {2}│ const x = 1; \/\/ yorum\n {2}└/);
    assert.match(out, /\[mermaid diagram\]/);
  });

  it('wraps, fits tables and colours with ansi on', () => {
    assert.deepEqual(wrap('aa bb cc dd', 5), ['aa bb', 'cc dd']);
    assert.deepEqual(wrap('çokuzunkelime x', 4, '  ', '- '), ['- çokuzunkelime', '  x']);
    const wide = plain(`| a | b |\n|---|---|\n| ${'x'.repeat(80)} | ${'y'.repeat(80)} |`, 40);
    assert.ok(wide.split('\n').every((l) => l.length <= 40), wide);
    const colored = renderMarkdown('# T\n**b** `c`\n```py\nif x: # c\n  s = "q" + 2\n```\n```diff\n+a\n-b\n@@ x\n ctx\n```', { width: 60, ansi: true });
    assert.match(colored, /\x1b\[1m/);
    assert.match(colored, /\x1b\[36mc\x1b\[39m/);
    assert.match(colored, /\x1b\[35mif\x1b\[39m/);
    assert.match(colored, /\x1b\[90m# c\x1b\[39m/);
    assert.match(colored, /\x1b\[32m"q"\x1b\[39m/);
    assert.match(colored, /\x1b\[33m2\x1b\[39m/);
    assert.match(colored, /\x1b\[32m\+a\x1b\[39m/);
    assert.match(colored, /\x1b\[35m-b\x1b\[39m/);
    assert.equal(stripAnsi(colored).includes('**'), false);
    assert.equal(highlight('int x;', 'c', { width: 10, ansi: false }), 'int x;');
    assert.equal(renderInline('***both***', { width: 10, ansi: false }), 'both');
    assert.equal(plain(''), '');
  });
});

describe('screen: status line and activity indicator', () => {
  it('draws the footer under the prompt and a spinner during work', async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (b: boolean) => void };
    const output = new PassThrough() as PassThrough & { isTTY?: boolean; columns?: number };
    input.isTTY = true;
    output.isTTY = true;
    output.columns = 80;
    input.setRawMode = () => undefined;
    let text = '';
    output.on('data', (d) => (text += String(d)));
    const s = new Screen({ input, output });
    const stop = s.activity('Görev', () => '2 LLM isteği sürüyor');
    s.print('log satırı');
    await new Promise((r) => setTimeout(r, 300));
    stop();
    assert.match(stripAnsi(text), /⠋ Görev · 0s · 2 LLM isteği sürüyor · Ctrl\+C to cancel/);
    assert.match(stripAnsi(text), /log satırı/);
    assert.match(text, /\x1b\[2K/, 'spinner line is cleared before printing');
    const p = s.readLine('❯ ', undefined, () => '~/proje · ⎇ main');
    input.write('x\r');
    assert.equal(await p, 'x');
    assert.match(stripAnsi(text), /~\/proje · ⎇ main/);
    const line = new Screen({ input: new PassThrough(), output: new PassThrough() });
    line.activity('x')();
    s.close();
  });
});

describe('git helpers', () => {
  it('slugs, branch names and worktree listing', (t) => {
    assert.equal(slugify('Özellik 1: UART DMA!'), 'ozellik-1-uart-dma');
    assert.equal(slugify('ığüşöç'), 'iguso' + 'c');
    assert.match(slugify('!!!'), /^wt-/);
    const plain = tmpProject({ 'a.c': '' });
    assert.equal(currentBranch(plain), undefined);
    assert.equal(repoRoot(plain), undefined);
    assert.deepEqual(listWorktrees(plain), []);
    ignoreStateDir(plain);
    // a worktree-style .git file pointing to a gitdir
    const fake = tmpProject({ '.git': 'gitdir: real-git\n', 'real-git/HEAD': 'ref: refs/heads/feature/x\n' });
    assert.equal(currentBranch(fake), 'feature/x');
    const detached = tmpProject({ '.git/HEAD': '0123456789abcdef\n' });
    assert.equal(currentBranch(detached), '0123456');
    const broken = tmpProject({ '.git': 'nonsense' });
    assert.equal(currentBranch(broken), undefined);
    const repo = tmpProject({ 'a.c': 'int a;' }, { git: true });
    try {
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'i'], { cwd: repo, stdio: 'ignore' });
    } catch {
      t.skip('git yok');
      return;
    }
    assert.equal(repoRoot(repo), realPath(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo }).toString().trim()));
    assert.ok(currentBranch(repo));
    ignoreStateDir(repo);
    ignoreStateDir(repo);
    const ex = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    assert.equal(ex.match(/\.kurultay\//g)?.length, 1, 'added once');
    mkdirSync(join(repo, '.kurultay'), { recursive: true });
  });
});
