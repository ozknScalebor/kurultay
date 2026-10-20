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
  console.error('dist bulunamadı – önce "npm run build" çalıştırın.');
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
if (isWin) {
  writeFileSync(join(dir, 'kurultay.cmd'), '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0bin\\kurultay.js" %*\r\n');
} else {
  writeFileSync(join(dir, 'kurultay'), '#!/bin/sh\nHERE="$(cd "$(dirname "$0")" && pwd)"\nexec "$HERE/runtime/node" "$HERE/bin/kurultay.js" "$@"\n');
  chmodSync(join(dir, 'kurultay'), 0o755);
}
console.log(`✓ ${dir}  (Node ${process.version})`);
if (!isWin) {
  try {
    execFileSync('tar', ['-czf', `${name}.tar.gz`, name], { cwd: rel });
    console.log(`✓ ${join(rel, name + '.tar.gz')}`);
  } catch {
    /* tar optional */
  }
}
