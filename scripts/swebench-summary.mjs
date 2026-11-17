#!/usr/bin/env node
// Summarise SWE-bench harness results of one benchmark run folder:
//   benchmarks/swebench/<run>/predictions-<agent>.jsonl   what the agents produced (offline)
//   benchmarks/swebench/<run>/results-<agent>.json        what the official harness says
//   benchmarks/swebench/<run>/runs-<agent>.jsonl          optional: time / requests per instance (kurultay swebench run)
// Writes <run>/RESULTS.md and prints the same Markdown (for the job summary / release notes).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export function summarise(dir) {
  const run = basename(dir);
  const agents = readdirSync(dir)
    .filter((f) => /^results-.+\.json$/.test(f))
    .map((f) => f.slice('results-'.length, -'.json'.length))
    .sort();
  if (!agents.length) return `### SWE-bench – ${run}\n\nNo results yet.\n`;
  const meta = existsSync(join(dir, 'meta.json')) ? JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) : {};
  const rows = [];
  const solved = new Map();
  const all = new Set();
  for (const a of agents) {
    const r = JSON.parse(readFileSync(join(dir, `results-${a}.json`), 'utf8'));
    const submitted = r.submitted_instances ?? (r.submitted_ids ?? []).length;
    const resolved = r.resolved_instances ?? (r.resolved_ids ?? []).length;
    for (const id of r.submitted_ids ?? []) all.add(id);
    solved.set(a, new Set(r.resolved_ids ?? []));
    let time = '-';
    let requests = '-';
    const runs = join(dir, `runs-${a}.jsonl`);
    if (existsSync(runs)) {
      const xs = readFileSync(runs, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      if (xs.length) {
        time = `${Math.round(xs.reduce((s, x) => s + (x.seconds ?? 0), 0) / xs.length / 60 * 10) / 10} min`;
        requests = (xs.reduce((s, x) => s + (x.requests ?? 0), 0) / xs.length).toFixed(1);
      }
    }
    rows.push(`| ${a} | ${resolved} / ${submitted} | ${submitted ? ((resolved / submitted) * 100).toFixed(1) : '0.0'}% | ${r.empty_patch_instances ?? 0} | ${r.error_instances ?? 0} | ${time} | ${requests} |`);
  }
  const ids = [...all].sort();
  const only = agents.map((a) => {
    const mine = [...solved.get(a)].filter((id) => agents.every((b) => b === a || !solved.get(b).has(id)));
    return mine.length ? `- only **${a}**: ${mine.join(', ')}` : '';
  }).filter(Boolean);
  const lines = [
    `### SWE-bench – ${run}`,
    '',
    `${meta.dataset ?? 'SWE-bench/SWE-bench_Verified'} · ${ids.length} instances${meta.note ? ` · ${meta.note}` : ''}`,
    '',
    '| Agent | Resolved | Rate | Empty patches | Errors | Avg. time | Avg. requests |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...rows,
    '',
    ...(only.length ? ['Solved by one agent only:', '', ...only, ''] : []),
    '<details><summary>Per instance</summary>',
    '',
    `| Instance | ${agents.join(' | ')} |`,
    `|---|${agents.map(() => ':---:').join('|')}|`,
    ...ids.map((id) => `| ${id} | ${agents.map((a) => (solved.get(a).has(id) ? '✅' : '❌')).join(' | ')} |`),
    '',
    '</details>',
    '',
  ];
  return lines.join('\n');
}

/** Put a run's section into release notes: replace it between its markers, or append it. */
export function mergeNotes(body, run, section) {
  const a = `<!-- swebench:${run} -->`;
  const b = `<!-- /swebench:${run} -->`;
  const block = `${a}\n${section.trim()}\n${b}`;
  const i = body.indexOf(a);
  const j = body.indexOf(b);
  if (i >= 0 && j > i) return body.slice(0, i) + block + body.slice(j + b.length);
  return `${body.trimEnd()}\n\n${block}\n`;
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  const args = process.argv.slice(2);
  const notesAt = args.indexOf('--merge-notes');
  const notes = notesAt >= 0 ? args.splice(notesAt, 2)[1] : undefined;
  const dir = args[0];
  if (!dir) {
    console.error('usage: node scripts/swebench-summary.mjs [--merge-notes notes.md] benchmarks/swebench/<run>');
    process.exit(2);
  }
  const md = summarise(dir);
  writeFileSync(join(dir, 'RESULTS.md'), md);
  if (notes) writeFileSync(notes, mergeNotes(existsSync(notes) ? readFileSync(notes, 'utf8') : '', basename(dir), md));
  else process.stdout.write(md);
}
