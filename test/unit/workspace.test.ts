import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { unifiedDiff, diffStat } from '../../src/agent/diff.js';
import { applyBlocks, applyReplacement, closestSnippet, parseSearchReplace, EditError } from '../../src/agent/edits.js';
import { merge3 } from '../../src/agent/merge3.js';
import { Materializer, Overlay, readProjectFile } from '../../src/agent/workspace.js';
import { tmpProject } from '../helpers.js';

describe('Overlay', () => {
  it('reads through parent chains and tracks own changes separately', () => {
    const root = tmpProject({ 'a.txt': 'base', 'b.txt': 'b' });
    const p = new Overlay('p', root);
    p.write('a.txt', 'parent');
    const c = p.fork('c');
    assert.equal(c.read('a.txt'), 'parent');
    assert.deepEqual(c.ownChanges(), []);
    assert.deepEqual(c.changedFiles(), ['a.txt'], 'changedFiles includes inherited changes');
    c.write('a.txt', 'parent'); // no-op write
    assert.deepEqual(c.ownChanges(), []);
    c.delete('b.txt');
    assert.equal(c.read('b.txt'), undefined);
    assert.equal(c.exists('b.txt'), false);
    assert.equal(p.read('b.txt'), 'b', 'parent unaffected by child');
    assert.match(c.diffAgainstParent(), /^--- a\/b\.txt\n\+\+\+ \/dev\/null/);
  });

  it('absorb() 3-way merges concurrent edits and reports real conflicts', () => {
    const root = tmpProject({ 'f.c': 'one\ntwo\nthree\nfour\nfive' });
    const integ = new Overlay('i', root);
    const w1 = integ.fork('w1');
    const w2 = integ.fork('w2');
    w1.write('f.c', 'ONE\ntwo\nthree\nfour\nfive');
    w2.write('f.c', 'one\ntwo\nthree\nfour\nFIVE');
    integ.absorb(w1);
    assert.deepEqual(integ.absorb(w2).conflicts, []);
    assert.equal(integ.read('f.c'), 'ONE\ntwo\nthree\nfour\nFIVE');
    const w3 = integ.fork('w3');
    const w4 = integ.fork('w4');
    w3.write('f.c', 'ONE\nTWO-a\nthree\nfour\nFIVE');
    w4.write('f.c', 'ONE\nTWO-b\nthree\nfour\nFIVE');
    integ.absorb(w3);
    const r = integ.absorb(w4);
    assert.deepEqual(r.conflicts, ['f.c']);
    assert.match(integ.read('f.c')!, /<<<<<<< kurultay[\s\S]*TWO-b[\s\S]*=======[\s\S]*TWO-a[\s\S]*>>>>>>> current/);
  });

  it('absorb() handles deletions and delete/modify conflicts', () => {
    const root = tmpProject({ 'x.txt': 'x', 'y.txt': 'y' });
    const integ = new Overlay('i', root);
    const a = integ.fork('a');
    a.delete('x.txt');
    integ.absorb(a);
    assert.equal(integ.read('x.txt'), undefined);
    const b = integ.fork('b');
    const c = integ.fork('c');
    b.delete('y.txt');
    c.write('y.txt', 'changed');
    integ.absorb(c);
    assert.deepEqual(integ.absorb(b).conflicts, ['y.txt']);
  });

  it('serialises and restores state', () => {
    const root = tmpProject({ 'a.txt': 'a' });
    const o = new Overlay('s', root);
    o.write('a.txt', 'A');
    o.write('n.txt', 'new');
    o.delete('a.txt');
    const back = Overlay.fromJSON(root, JSON.parse(JSON.stringify(o.toJSON())));
    assert.equal(back.read('a.txt'), undefined);
    assert.equal(back.read('n.txt'), 'new');
    assert.deepEqual(back.changedFiles(), o.changedFiles());
  });

  it('lists directories including overlay-only folders', () => {
    const root = tmpProject({ 'src/a.c': '' });
    const o = new Overlay('l', root);
    o.write('src/sub/deep.c', 'x');
    o.write('newdir/f.txt', 'x');
    assert.deepEqual(o.list('src').map((e) => (e.dir ? e.name + '/' : e.name)), ['sub/', 'a.c']);
    assert.ok(o.list('').some((e) => e.name === 'newdir' && e.dir));
    assert.equal(o.isDir('newdir'), true);
    assert.deepEqual(o.list('newdir').map((e) => e.name), ['f.txt']);
  });
});

describe('Materializer', () => {
  it('recovers originals from a crash journal', () => {
    const root = tmpProject({ 'keep.txt': 'candidate-version', 'created.txt': 'temporary' });
    const state = join(root, '.kurultay');
    const m = new Materializer(root, state);
    writeFileSync(join(root, 'keep.txt'), 'candidate-version');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'journal.json'), JSON.stringify({ overlay: 'x', originals: { 'keep.txt': 'original', 'created.txt': null } }));
    const restored = m.recover().sort();
    assert.deepEqual(restored, ['created.txt', 'keep.txt']);
    assert.equal(readFileSync(join(root, 'keep.txt'), 'utf8'), 'original');
    assert.equal(existsSync(join(root, 'created.txt')), false);
    assert.equal(existsSync(join(state, 'journal.json')), false);
    assert.deepEqual(m.recover(), [], 'idempotent');
  });

  it('restores files even when the callback throws, and serialises applications', async () => {
    const root = tmpProject({ 'a.txt': 'orig' });
    const m = new Materializer(root, join(root, '.k'));
    const o1 = new Overlay('1', root);
    o1.write('a.txt', 'one');
    const o2 = new Overlay('2', root);
    o2.write('a.txt', 'two');
    await assert.rejects(m.withApplied(o1, async () => {
      throw new Error('build crashed');
    }));
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'orig');
    const seen: string[] = [];
    await Promise.all([
      m.withApplied(o1, async () => {
        await new Promise((r) => setTimeout(r, 30));
        seen.push(readFileSync(join(root, 'a.txt'), 'utf8'));
      }),
      m.withApplied(o2, async () => {
        seen.push(readFileSync(join(root, 'a.txt'), 'utf8'));
      }),
    ]);
    assert.deepEqual(seen, ['one', 'two'], 'never interleaved');
    assert.equal(readProjectFile(root, 'a.txt'), 'orig');
  });

  it('merge() writes, deletes, 3-way merges and flags conflicts', async () => {
    const root = tmpProject({ 'w.txt': 'w', 'd.txt': 'd', 'm.txt': 'l1\nl2\nl3\nl4', 'c.txt': 'same\nline', 'gone.txt': 'g' });
    const o = new Overlay('o', root);
    o.write('w.txt', 'W');
    o.delete('d.txt');
    o.write('m.txt', 'L1\nl2\nl3\nl4');
    o.write('c.txt', 'mine\nline');
    o.write('gone.txt', 'edited');
    o.write('brand/new.txt', 'n');
    // user edits on disk while the agent works
    writeFileSync(join(root, 'm.txt'), 'l1\nl2\nl3\nL4');
    writeFileSync(join(root, 'c.txt'), 'theirs\nline');
    unlinkSync(join(root, 'gone.txt'));
    const rep = await new Materializer(root, join(root, '.k')).merge(o);
    assert.deepEqual(rep.written.sort(), ['brand/new.txt', 'w.txt']);
    assert.deepEqual(rep.deleted, ['d.txt']);
    assert.deepEqual(rep.merged3way, ['m.txt']);
    assert.deepEqual(rep.conflicts.sort(), ['c.txt', 'gone.txt']);
    assert.equal(readFileSync(join(root, 'm.txt'), 'utf8'), 'L1\nl2\nl3\nL4');
    assert.match(readFileSync(join(root, 'c.txt'), 'utf8'), /<<<<<<<[\s\S]*mine[\s\S]*theirs/);
    assert.equal(readFileSync(join(root, 'brand/new.txt'), 'utf8'), 'n');
  });
});

describe('edits – edge cases', () => {
  it('handles trailing whitespace, CRLF-free appends and replace_all', () => {
    assert.equal(applyReplacement('a  \nb\n', 'a\nb', 'x\ny'), 'x\ny\n');
    assert.equal(applyReplacement('one', '', 'two'), 'one\ntwo');
    assert.equal(applyReplacement('', '', 'new'), 'new');
    assert.equal(applyReplacement('k=1; k=1;', 'k=1;', 'k=2;', { replaceAll: true }), 'k=2; k=2;');
    assert.equal(applyReplacement('  a\n  b\n  a\n  b', 'a\nb', 'c', { replaceAll: true }), '  c\n  c');
    assert.throws(() => applyReplacement('  a\n  b\n  a\n  b', 'a\nb', 'c'), /2 places/);
  });
  it('parse errors and multi-file blocks', () => {
    assert.throws(() => parseSearchReplace('f.c\n<<<<<<< SEARCH\nx\n'), EditError);
    assert.throws(() => parseSearchReplace('f.c\n<<<<<<< SEARCH\nx\n=======\ny\n'), /REPLACE/);
    assert.throws(() => parseSearchReplace('<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE'), /no file path/);
    const blocks = parseSearchReplace('Edit `src/a.c`:\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\nand **src/b.h**\n<<<<<<< SEARCH\n=======\nint b;\n>>>>>>> REPLACE');
    assert.deepEqual(blocks.map((b) => b.path), ['src/a.c', 'src/b.h']);
    const files = new Map([['src/a.c', 'a']]);
    const r = applyBlocks(files, [...blocks, { path: 'missing.c', search: 'q', replace: 'w' }, { path: 'src/a.c', search: 'zzz', replace: '' }]);
    assert.deepEqual(r.changed.sort(), ['src/a.c', 'src/b.h']);
    assert.equal(r.errors.length, 2);
    assert.equal(files.get('src/b.h'), 'int b;');
  });
  it('finds the closest snippet for hints', () => {
    const near = closestSnippet('alpha\nint read_raw(int ch) {\nbeta', 'int read_raw(int channel) {');
    assert.equal(near!.line, 2);
    assert.ok(near!.score > 0.7);
  });
});

describe('diff and merge – edge cases', () => {
  it('diffs new and deleted files and reports no diff for equal content', () => {
    assert.match(unifiedDiff('n.txt', undefined, 'a\nb'), /^--- \/dev\/null\n\+\+\+ b\/n\.txt\n@@ -0,0 \+1,2 @@\n\+a\n\+b/);
    assert.match(unifiedDiff('d.txt', 'a', undefined), /^--- a\/d\.txt\n\+\+\+ \/dev\/null/);
    assert.equal(unifiedDiff('s.txt', 'same', 'same'), '');
  });
  it('keeps separate hunks for distant changes', () => {
    const before = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l2\n', 'L2\n').replace('l35', 'L35');
    const d = unifiedDiff('f', before, after);
    assert.equal((d.match(/^@@/gm) ?? []).length, 2);
    assert.deepEqual(diffStat(d), { added: 2, removed: 2 });
  });
  it('merge3 short-circuits identical and one-sided changes', () => {
    assert.deepEqual(merge3('a', 'b', 'b'), { ok: true, content: 'b', conflicts: 0 });
    assert.equal(merge3('a', 'a', 'c').content, 'c');
    assert.equal(merge3('a', 'm', 'a').content, 'm');
    const ins = merge3('a\nb\nc', 'a\nX\nb\nc', 'a\nb\nc\nY');
    assert.equal(ins.ok, true);
    assert.equal(ins.content, 'a\nX\nb\nc\nY');
  });
});
