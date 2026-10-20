// Turns failing tests from a TAP file into GitHub Actions error annotations (used by CI).
import { readFileSync } from 'node:fs';

const tap = readFileSync(process.argv[2] ?? 'tap.txt', 'utf8').split(/\r?\n/);
let count = 0;
for (let i = 0; i < tap.length && count < 10; i++) {
  if (!/^\s*not ok /.test(tap[i])) continue;
  const block = [tap[i]];
  for (let j = i + 1; j < tap.length && j < i + 60 && !/^\s*(not )?ok /.test(tap[j]); j++) block.push(tap[j]);
  const msg = block.join('\n').slice(0, 6000).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::error title=test failure::${msg}`);
  count++;
}
if (!count) console.log('::error title=test failure::no "not ok" lines found; build or runner failed before tests');
