#!/usr/bin/env node
/**
 * CI wrapper around run-tests.mjs:
 *  - runs the given suites with the TAP reporter and echoes the output
 *  - turns failing tests into GitHub error annotations (visible in the PR / run page)
 *  - writes a result table (and the coverage table when --coverage) to the job summary
 * Usage: node scripts/ci-run.mjs <suite...> [--coverage --min-lines=N ...]
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const args = process.argv.slice(2);
const r = spawnSync(process.execPath, [join(root, 'scripts', 'run-tests.mjs'), ...args, '--reporter=tap'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
process.stdout.write(out);
writeFileSync(join(root, 'test-output.tap'), out);
const lines = out.split(/\r?\n/);

const count = (k) => Number(lines.find((l) => new RegExp(`^# ${k} \\d+`).test(l))?.split(' ')[2] ?? 0);
const stats = { tests: count('tests'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), skipped: count('skipped') };
const suites = args.filter((a) => !a.startsWith('--')).join(', ') || 'all';

// failing tests → annotations (only leaf tests; suites just say "subtests failed")
const failures = [];
for (let i = 0; i < lines.length; i++) {
  if (!/^\s*not ok /.test(lines[i])) continue;
  const block = [lines[i]];
  for (let j = i + 1; j < lines.length && j < i + 80 && !/^\s*(not )?ok \d+/.test(lines[j]); j++) block.push(lines[j]);
  const text = block.join('\n');
  if (/failureType: 'subtestsFailed'/.test(text)) continue;
  failures.push({ title: lines[i].replace(/^\s*not ok \d+ - /, '').trim(), text });
}
const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
for (const f of failures.slice(0, 20)) console.log(`::error title=${esc(`[${suites}] ${f.title}`).slice(0, 200)}::${esc(f.text.slice(0, 6000))}`);
if (r.status !== 0 && !failures.length) console.log(`::error title=[${suites}] test run failed::exit code ${r.status} – see log (build/runner error or coverage threshold)`);

// job summary
const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile) {
  const icon = r.status === 0 ? '✅' : '❌';
  let md = `### ${icon} Testler: ${suites} (Node ${process.versions.node}, ${process.platform})\n\n| toplam | geçti | kaldı | iptal | atlandı |\n|---|---|---|---|---|\n| ${stats.tests} | ${stats.pass} | ${stats.fail} | ${stats.cancelled} | ${stats.skipped} |\n\n`;
  if (failures.length) md += `**Başarısız testler**\n\n${failures.map((f) => `- ${f.title}`).join('\n')}\n\n`;
  const covStart = lines.findIndex((l) => /^# start of coverage report/.test(l));
  const covEnd = lines.findIndex((l) => /^# end of coverage report/.test(l));
  if (covStart >= 0 && covEnd > covStart) {
    const rows = lines.slice(covStart + 1, covEnd).map((l) => l.replace(/^# ?/, '')).filter((l) => l.includes('|') && !/^-+/.test(l));
    const all = rows.find((l) => /^all files/.test(l.trim()));
    if (all) {
      const [, line, branch, funcs] = all.split('|').map((x) => x.trim());
      md += `**Kapsam:** satır ${line}% · dal ${branch}% · fonksiyon ${funcs}%\n\n<details><summary>Dosya bazında</summary>\n\n\`\`\`\n${rows.join('\n')}\n\`\`\`\n</details>\n\n`;
    }
  }
  appendFileSync(summaryFile, md);
}
process.exit(r.status ?? 1);
