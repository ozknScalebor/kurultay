import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string; dependencies?: Record<string, string> };

describe('offline distribution', () => {
  it('has zero runtime dependencies', () => {
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  });

  it('builds a tarball and a portable bundle that work without network access', () => {
    const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'pack-offline.mjs')], { cwd: ROOT, encoding: 'utf8' });
    const rel = join(ROOT, 'release');
    const tgz = join(rel, `kurultay-${pkg.version}.tgz`);
    assert.ok(existsSync(tgz), out);

    // tarball contents: runtime code only, no tests or sources
    const list = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    assert.ok(list.includes('package/bin/kurultay.js'));
    assert.ok(list.includes('package/dist/src/cli.js'));
    assert.ok(list.includes('package/README.md') && list.includes('package/LICENSE'));
    assert.ok(!list.some((f) => f.includes('/test/') || f.endsWith('.ts') && !f.endsWith('.d.ts')), 'no tests or TypeScript sources shipped');

    // offline install into a fresh prefix (npm must not need the registry)
    const prefix = mkdtempSync(join(tmpdir(), 'k-install-'));
    const install = spawnSync(npm, ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts', '--prefix', prefix, tgz], { encoding: 'utf8', shell: isWin, env: { ...process.env, npm_config_registry: 'http://127.0.0.1:9/' } });
    assert.equal(install.status, 0, install.stderr);
    const installedBin = join(prefix, 'node_modules', 'kurultay', 'bin', 'kurultay.js');
    const v = execFileSync(process.execPath, [installedBin, '--version'], { encoding: 'utf8' }).trim();
    assert.equal(v, pkg.version);

    // portable bundle carries its own node runtime
    const portable = readdirSync(rel).find((d) => d.startsWith(`kurultay-${pkg.version}-portable-`) && !/\.(tar\.gz|zip)$/.test(d));
    assert.ok(portable, 'portable folder created');
    const dir = join(rel, portable!);
    assert.ok(existsSync(join(dir, 'runtime', isWin ? 'node.exe' : 'node')));
    assert.ok(existsSync(join(rel, `${portable}${isWin ? '.zip' : '.tar.gz'}`)), 'portable archive created');
    const launcher = join(dir, isWin ? 'kurultay.cmd' : 'kurultay');
    const help = spawnSync(launcher, ['--help'], { encoding: 'utf8', shell: isWin });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Commands:/);
  });
});
