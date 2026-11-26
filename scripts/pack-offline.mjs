#!/usr/bin/env node
/**
 * Builds offline distributables into ./release:
 *   1) kurultay-<ver>.tgz            → `npm install -g ./kurultay-<ver>.tgz` (no internet needed: zero runtime deps)
 *   2) kurultay-<ver>-portable-<os>-<arch>/  (+ .tar.gz)
 *        bundles the current Node.js binary + dist, run with ./kurultay (or kurultay.cmd on Windows)
 * Run this on an internet-connected machine with the same OS/arch as the offline target
 * (for the portable bundle), then copy the release folder via USB.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const rel = join(root, 'release');
mkdirSync(rel, { recursive: true });

if (!existsSync(join(root, 'dist', 'src', 'cli.js'))) {
  console.error('dist not found – run "npm run build" first.');
  process.exit(1);
}

// 1) npm tarball
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const out = execFileSync(npmCmd, ['pack', '--pack-destination', rel, '--json'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
const tgz = JSON.parse(out)[0].filename;
console.log(`✓ ${join(rel, basename(tgz))}`);

// 2) portable folder with the node runtime
const isWin = process.platform === 'win32';
const name = `kurultay-${pkg.version}-portable-${process.platform}-${process.arch}`;
const dir = join(rel, name);
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, 'runtime'), { recursive: true });
copyFileSync(process.execPath, join(dir, 'runtime', isWin ? 'node.exe' : 'node'));
for (const p of ['bin', 'README.md', 'LICENSE', 'package.json', 'examples']) {
  if (existsSync(join(root, p))) cpSync(join(root, p), join(dir, p), { recursive: true });
}
cpSync(join(root, 'dist', 'src'), join(dir, 'dist', 'src'), { recursive: true });
// company networks: trust the certificates of the operating system's store as well (Node 22.15+,
// 23.8+); Jira, GitLab and model servers with a company CA then work without NODE_EXTRA_CA_CERTS
const [maj, min] = process.versions.node.split('.').map(Number);
const sysCa = maj >= 24 || (maj === 23 && min >= 8) || (maj === 22 && min >= 15) ? ' --use-system-ca' : '';
if (isWin) {
  // started on its own (double click, Win+R, Start search, start ""): Windows closes the window as
  // soon as Kurultay ends and the answer or the error is gone – then it waits for a key. Typed
  // into an open console window it does not (the console's command line does not name this file).
  writeFileSync(
    join(dir, 'kurultay.cmd'),
    [
      '@echo off',
      'setlocal',
      `"%~dp0runtime\\node.exe"${sysCa} "%~dp0bin\\kurultay.js" %*`,
      'set "KURULTAY_EXIT=%ERRORLEVEL%"',
      // scripts that call it set KURULTAY_NO_PAUSE=1
      'if not defined KURULTAY_NO_PAUSE echo %CMDCMDLINE% | find /i "%~nx0" >nul && (echo. & echo Kurultay ended ^(exit code %KURULTAY_EXIT%^). Press a key to close this window. & pause >nul)',
      'exit /b %KURULTAY_EXIT%',
      '',
    ].join('\r\n'),
  );
} else {
  writeFileSync(join(dir, 'kurultay'), `#!/bin/sh\nHERE="$(cd "$(dirname "$0")" && pwd)"\nexec "$HERE/runtime/node"${sysCa} "$HERE/bin/kurultay.js" "$@"\n`);
  chmodSync(join(dir, 'kurultay'), 0o755);
}
console.log(`✓ ${dir}  (Node ${process.version})`);
// archive the portable bundle (keeps the executable bit; bsdtar on Windows writes .zip)
try {
  const archive = isWin ? `${name}.zip` : `${name}.tar.gz`;
  rmSync(join(rel, archive), { force: true });
  execFileSync('tar', isWin ? ['-a', '-cf', archive, name] : ['-czf', archive, name], { cwd: rel });
  console.log(`✓ ${join(rel, archive)}`);
} catch (e) {
  console.warn(`could not create the archive (no tar?): ${e.message}`);
}
