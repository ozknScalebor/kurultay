#!/usr/bin/env node
/**
 * Test runner (Node ≥ 20, no dependencies).
 *   node scripts/run-tests.mjs [unit|integration|cli|package|all ...] [--coverage] [--reporter=spec|tap|dot] [--min-lines=N --min-branches=N --min-functions=N]
 * Coverage thresholds need Node ≥ 22.8; on older Node they are ignored with a warning.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => {
  const [k, v] = a.slice(2).split('=');
  return [k, v ?? true];
}));
let suites = args.filter((a) => !a.startsWith('--'));
if (!suites.length || suites.includes('all')) suites = ['unit', 'integration', 'cli'];

function find(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...find(p));
    else if (name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

const files = suites.flatMap((s) => find(join(root, 'dist', 'test', s)));
if (!files.length) {
  console.error(`Test dosyası bulunamadı (${suites.join(', ')}). Önce "npm run build" çalıştırın.`);
  process.exit(1);
}

const [major, minor] = process.versions.node.split('.').map(Number);
const nodeArgs = ['--test', `--test-reporter=${flags.reporter ?? 'spec'}`];
if (flags.concurrency) nodeArgs.push(`--test-concurrency=${flags.concurrency}`);
if (flags['test-timeout'] ?? true) nodeArgs.push(`--test-timeout=${flags['test-timeout'] && flags['test-timeout'] !== true ? flags['test-timeout'] : 120000}`);
if (flags.coverage) {
  nodeArgs.push('--experimental-test-coverage');
  const thresholdsSupported = major > 22 || (major === 22 && minor >= 8);
  if (thresholdsSupported) {
    nodeArgs.push('--test-coverage-include=dist/src/**', '--test-coverage-exclude=dist/src/mock/**');
    for (const k of ['lines', 'branches', 'functions']) if (flags[`min-${k}`]) nodeArgs.push(`--test-coverage-${k}=${flags[`min-${k}`]}`);
  } else if (flags['min-lines'] || flags['min-branches'] || flags['min-functions']) {
    console.warn(`Uyarı: kapsam eşikleri Node ${process.versions.node} sürümünde desteklenmiyor, atlanıyor.`);
  }
}
console.error(`Çalıştırılıyor: ${suites.join(', ')} – ${files.length} dosya`);
const r = spawnSync(process.execPath, [...nodeArgs, ...files.map((f) => relative(root, f))], { cwd: root, stdio: 'inherit', env: { ...process.env, KURULTAY_TEST: '1' } });
process.exit(r.status ?? 1);
