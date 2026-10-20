import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { parseArgs } from '../../src/cli.js';
import { startMockServer, type MockServerHandle } from '../../src/mock/server.js';
import { CLAMP_PROJECT, tmpProject } from '../helpers.js';

const BIN = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'bin', 'kurultay.js');

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the real CLI asynchronously (the mock server lives in this process). */
function cli(args: string[], cwd: string, env: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', HOME: cwd, USERPROFILE: cwd, ...env }, timeout: 120_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

describe('argument parsing', () => {
  it('parses commands, positionals, boolean and valued flags', () => {
    assert.deepEqual(parseArgs(['run', 'fix', 'the', 'bug', '--mode', 'race', '--dry-run', '--port=8000', '-y']), {
      cmd: 'run',
      positional: ['fix', 'the', 'bug'],
      flags: { mode: 'race', 'dry-run': true, port: '8000', y: true },
    });
    assert.deepEqual(parseArgs([]), { cmd: 'help', positional: [], flags: {} });
    assert.deepEqual(parseArgs(['probe', '--deep', '--ui']).flags, { deep: true, ui: true });
    assert.equal(parseArgs(['ask', '--members', '2', 'q']).flags.members, '2');
  });
});

describe('kurultay CLI (end-to-end against a mock LLM server)', () => {
  let mock: MockServerHandle;
  let root: string;

  before(async () => {
    mock = await startMockServer([
      { id: 'cli-strong', quality: 'good', tools: true, ctx: 65536 },
      { id: 'cli-weak', quality: 'bad', tools: false, ctx: 16384 },
    ]);
    root = tmpProject(CLAMP_PROJECT, { git: true });
  });
  after(async () => {
    await mock.close();
  });

  it('prints help and version', async () => {
    const help = await cli(['--help'], root);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Komutlar:/);
    for (const c of ['init', 'probe', 'index', 'analyze', 'run', 'ask', 'map', 'search', 'status', 'mock']) assert.match(help.stdout, new RegExp(`\\n  ${c}\\b`));
    const v = await cli(['--version'], root);
    assert.equal(v.code, 0);
    assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  it('fails with a helpful message when there is no configuration', async () => {
    const empty = tmpProject({ 'a.c': 'int a;' });
    const r = await cli(['status'], empty, { HOME: empty, USERPROFILE: empty });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /kurultay init/);
    const unknown = await cli(['frobnicate'], root);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stdout, /Bilinmeyen komut/);
  });

  it('init creates config, rule templates and detects test commands; does not overwrite', async () => {
    const r = await cli(['init'], root);
    assert.equal(r.code, 0, r.stderr);
    const cfgPath = join(root, 'kurultay.config.json');
    assert.ok(existsSync(cfgPath));
    for (const p of ['.kurultay/rules/genel.md', '.kurultay/rules/java.md', '.kurultay/skills/yeni-surucu-ekleme/SKILL.md', '.kurultay/skills/yeni-surucu-ekleme/references/arayuz-kurallari.md', '.kurultay/review_rules.md']) assert.ok(existsSync(join(root, p)), p);
    const again = await cli(['init'], root);
    assert.match(again.stdout, /zaten var/);
    // point the config at the mock server
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.endpoints = [{ name: 'mock', baseUrl: mock.url, apiKey: '${MOCK_KEY:-none}' }];
    cfg.verify = { test: 'node test.js' };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  });

  it('index, map and search work without any model', async () => {
    const idx = await cli(['index'], root);
    assert.equal(idx.code, 0, idx.stderr);
    assert.match(idx.stdout, /indeks: 3 dosya/);
    const map = await cli(['map', '--tokens', '200'], root);
    assert.match(map.stdout, /src\/mathutil\.js/);
    assert.match(map.stdout, /clamp/);
    const search = await cli(['search', 'clamp'], root);
    assert.match(search.stdout, /src\/mathutil\.js:1-/);
  });

  it('probe writes the capability report', async () => {
    const r = await cli(['probe', '--quick'], root);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /cli-strong@mock/);
    assert.ok(existsSync(join(root, '.kurultay', 'capabilities.json')));
    assert.ok(existsSync(join(root, '.kurultay', 'CAPABILITIES.md')));
  });

  it('analyze produces the architecture document', async () => {
    const r = await cli(['analyze', '--drafts', '2'], root);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /dosya özetlendi/);
    assert.ok(existsSync(join(root, '.kurultay', 'ARCHITECTURE.md')));
    assert.ok(existsSync(join(root, '.kurultay', 'PROJECT_NOTES.md')));
    assert.match(r.stdout, /1 akış dokümanı/);
    assert.ok(existsSync(join(root, '.kurultay', 'flows', '01-ana-akis.md')));
    assert.match(readFileSync(join(root, '.kurultay', 'ARCHITECTURE.md'), 'utf8'), /## Akış Dokümanları/);
  });

  it('skills lists, validates and scaffolds skills', async () => {
    const list = await cli(['skills'], root);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /yeni-surucu-ekleme/);
    const made = await cli(['skills', 'new', 'log-format', '--description', 'Log satırı biçimi kuralları'], root);
    assert.equal(made.code, 0, made.stderr);
    assert.ok(existsSync(join(root, '.kurultay', 'skills', 'log-format', 'SKILL.md')));
    const dup = await cli(['skills', 'new', 'log-format'], root);
    assert.equal(dup.code, 1);
    const bad = await cli(['skills', 'new', 'Bad Name'], root);
    assert.equal(bad.code, 1);
    writeFileSync(join(root, '.kurultay', 'skills', 'log-format', 'SKILL.md'), '---\nname: log-format\n---\nno description');
    const broken = await cli(['skills'], root);
    assert.equal(broken.code, 1);
    assert.match(broken.stdout + broken.stderr, /description/);
    writeFileSync(join(root, '.kurultay', 'skills', 'log-format', 'SKILL.md'), '---\nname: log-format\ndescription: Log satırı biçimi\n---\nKULLAN-LOG-777');
  });

  it('status shows models, index and sessions', async () => {
    const r = await cli(['status'], root);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Modeller \(2, probe sonucu\)/);
    assert.match(r.stdout, /İndeks: 3 dosya/);
  });

  it('run requires a task', async () => {
    const r = await cli(['run'], root);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Görev metni gerekli/);
  });

  it('run --dry-run leaves the project untouched; run --yes applies and exits 0', async () => {
    const dry = await cli(['run', 'Implement clamp in src/mathutil.js', '--dry-run', '--mode', 'single'], root);
    assert.equal(dry.code, 2, 'dry-run is not "completed"');
    assert.match(dry.stdout, /Sonuç: dry-run/);
    assert.match(readFileSync(join(root, 'src/mathutil.js'), 'utf8'), /TODO/);
    const real = await cli(['run', 'Implement clamp in src/mathutil.js', '--yes'], root);
    assert.equal(real.code, 0, real.stdout + real.stderr);
    assert.match(real.stdout, /Sonuç: completed/);
    assert.match(real.stdout, /Rapor: .*REPORT\.md/);
    assert.match(readFileSync(join(root, 'src/mathutil.js'), 'utf8'), /Math\.min\(Math\.max/);
    assert.match(real.stderr, /Kurultay toplandı/, 'live log on stderr');
  });

  it('run --req injects a requirements file', async () => {
    writeFileSync(join(root, 'req.md'), 'REQ-CLI-777 clamp must handle both bounds');
    const before = mock.log.length;
    await cli(['run', 'Implement clamp', '--req', 'req.md', '--dry-run', '--mode', 'single'], root);
    assert.ok(mock.log.slice(before).some((l) => JSON.stringify(l.body).includes('REQ-CLI-777')));
  });

  it('run --skill preloads the named skill into the worker prompt', async () => {
    const before = mock.log.length;
    const r = await cli(['run', 'Implement clamp in src/mathutil.js', '--skill', 'log-format,olmayan', '--dry-run', '--mode', 'single'], root);
    assert.match(r.stderr + r.stdout, /olmayan/);
    assert.ok(mock.log.slice(before).some((l) => JSON.stringify(l.body).includes('KULLAN-LOG-777')));
  });

  it('ask answers through the council', async () => {
    const r = await cli(['ask', 'clamp nerede?'], root);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /src\/mathutil\.js/);
    assert.match(r.stdout, /konsey:/);
  });

  it('reports unreachable endpoints clearly', async () => {
    const dead = tmpProject({ 'a.c': 'int a;', 'kurultay.config.json': JSON.stringify({ endpoints: [{ name: 'dead', baseUrl: 'http://127.0.0.1:9/v1' }] }) });
    const r = await cli(['run', 'something'], dead);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Hiçbir model erişilebilir değil/);
  });
});
