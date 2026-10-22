import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SandboxPool } from '../../src/agent/sandbox.js';
import { runShell } from '../../src/agent/tools.js';
import { Materializer, Overlay } from '../../src/agent/workspace.js';
import { tmpProject } from '../helpers.js';

const node = (code: string) => `node -e "${code.replace(/"/g, '\\"')}"`;

describe('sandboxes (isolated parallel builds)', () => {
  it('runs commands of different workers in parallel without touching the project', async () => {
    const root = tmpProject({ 'a.txt': 'orig', 'src/x.c': 'int x;', 'build/CMakeCache.txt': 'abs path', 'node_modules/m/index.js': 'x' });
    const m = new Materializer(root, join(root, '.kurultay'), { isolation: 'sandbox', sandbox: { size: 3 } });
    const o1 = new Overlay('w1', root);
    o1.write('a.txt', 'one');
    const o2 = new Overlay('w2', root);
    o2.write('a.txt', 'two');
    o2.write('new.txt', 'n');
    const seen: string[] = [];
    const spans: Array<[number, number]> = [];
    await Promise.all(
      [o1, o2].map((o) =>
        m.execute(o, async (cwd) => {
          assert.notEqual(cwd, root);
          assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'orig', 'the real project is never modified');
          const start = Date.now();
          const r = await runShell(node("setTimeout(()=>console.log(require('fs').readFileSync('a.txt','utf8')),400)"), cwd, 10_000);
          seen.push(r.output.trim());
          spans.push([start, Date.now()]);
          return r;
        }),
      ),
    );
    assert.deepEqual(seen.sort(), ['one', 'two']);
    const [a, b] = spans.sort((x, y) => x[0] - y[0]);
    assert.ok(b[0] < a[1], `the two commands overlapped in time (${JSON.stringify(spans)})`);
    const sb = join(root, '.kurultay', 'sandboxes', 'sb-1');
    assert.ok(!existsSync(join(sb, 'build')), 'build outputs are not copied');
    assert.ok(lstatSync(join(sb, 'node_modules')).isSymbolicLink(), 'node_modules is linked');
    assert.ok(!existsSync(join(sb, '.kurultay')));
  });

  it('in-place mode is serialised (for comparison)', async () => {
    const root = tmpProject({ 'a.txt': 'orig' });
    const m = new Materializer(root, join(root, '.kurultay'), { isolation: 'inplace' });
    const o1 = new Overlay('w1', root);
    o1.write('a.txt', 'one');
    const o2 = new Overlay('w2', root);
    const t0 = Date.now();
    await Promise.all([o1, o2].map((o) => m.execute(o, (cwd) => runShell(node('setTimeout(()=>{},300)'), cwd, 10_000))));
    assert.ok(Date.now() - t0 >= 590, 'one at a time');
    assert.equal(m.rewriteOutput('x'), 'x');
  });

  it('syncs overlays, keeps build outputs, refreshes project edits and maps paths back', async () => {
    const root = tmpProject({ 'a.txt': 'orig', 'keep.txt': 'k', 'dir/b.txt': 'b' });
    const pool = new SandboxPool(root, join(root, '.kurultay', 'sb'), { size: 1, rescanMs: 0 });
    const o1 = new Overlay('w1', root);
    o1.write('a.txt', 'one');
    o1.write('extra.txt', 'e');
    o1.delete('keep.txt');
    let dir = '';
    await pool.run(o1, async (cwd) => {
      dir = cwd;
      assert.equal(readFileSync(join(cwd, 'a.txt'), 'utf8'), 'one');
      assert.ok(existsSync(join(cwd, 'extra.txt')));
      assert.ok(!existsSync(join(cwd, 'keep.txt')));
      mkdirSync(join(cwd, 'build'), { recursive: true });
      writeFileSync(join(cwd, 'build', 'obj.o'), 'compiled');
    });
    // the same sandbox now serves another worker: the first worker's edits are gone, build outputs stay
    writeFileSync(join(root, 'dir/b.txt'), 'changed in project');
    writeFileSync(join(root, 'added.txt'), 'new in project');
    const o2 = new Overlay('w2', root);
    await pool.run(o2, async (cwd) => {
      assert.equal(cwd, dir);
      assert.equal(readFileSync(join(cwd, 'a.txt'), 'utf8'), 'orig');
      assert.ok(!existsSync(join(cwd, 'extra.txt')));
      assert.equal(readFileSync(join(cwd, 'keep.txt'), 'utf8'), 'k');
      assert.equal(readFileSync(join(cwd, 'build', 'obj.o'), 'utf8'), 'compiled', 'incremental builds');
      assert.equal(readFileSync(join(cwd, 'dir/b.txt'), 'utf8'), 'changed in project');
      assert.ok(existsSync(join(cwd, 'added.txt')));
    });
    // a file removed from the project disappears from the sandbox too
    writeFileSync(join(root, 'added.txt'), '');
    const { unlinkSync } = await import('node:fs');
    unlinkSync(join(root, 'added.txt'));
    await pool.run(o2, async (cwd) => assert.ok(!existsSync(join(cwd, 'added.txt'))));
    assert.equal(pool.rewriteOutput(`error at ${dir}/a.txt:3`), `error at ${root}/a.txt:3`);
    // a broken manifest forces a full re-copy
    writeFileSync(join(dir, '.kurultay-sandbox.json'), 'junk');
    await pool.run(o1, async (cwd) => assert.equal(readFileSync(join(cwd, 'a.txt'), 'utf8'), 'one'));
    pool.destroy();
    assert.ok(!existsSync(join(root, '.kurultay', 'sb')));
    await pool.run(o2, async (cwd) => assert.equal(readFileSync(join(cwd, 'a.txt'), 'utf8'), 'orig'));
  });

  it('respects the pool size and abort signals', async () => {
    const root = tmpProject({ 'a.txt': 'x' });
    const pool = new SandboxPool(root, join(root, '.kurultay', 'sb'), { size: 1 });
    const o = new Overlay('w', root);
    let release!: () => void;
    const first = pool.run(o, () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 20));
    const ctrl = new AbortController();
    const second = pool.run(o, async () => 'ran', ctrl.signal);
    ctrl.abort(new Error('stop'));
    await assert.rejects(second, /stop/);
    release();
    await first;
  });
});
