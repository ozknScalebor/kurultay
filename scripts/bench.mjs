#!/usr/bin/env node
// Head-to-head bench: Kurultay and Qwen Code on the same tasks, scored with the same hidden tests.
//
//   node scripts/bench.mjs --out bench-out [--suites java-envanter,cpp-telemetri] [--tasks K1-depo-transfer,…]
//                          [--config k.json] [--qwen "qwen"] [--minutes 30] [--name v0.10.0]
//
// Kurultay runs through its own eval harness (fresh copy per task, hidden tests added afterwards).
// Qwen Code gets a fresh copy of the same project, the same task text, and is run headless
// (--yolo, a wall-clock budget); its folder is then scored with the same hidden tests.
// Writes <out>/bench.json and <out>/BENCH.md; --merge-notes <file> also merges the table into release notes.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function flags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) f[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  return f;
}

/** Qwen Code's --output-format json: an array of messages, the last one carries stats. */
export function qwenStats(stdout) {
  try {
    const arr = JSON.parse(stdout);
    const last = Array.isArray(arr) ? arr[arr.length - 1] : arr;
    const models = last?.stats?.models ?? {};
    let requests = 0;
    let tokens = 0;
    for (const m of Object.values(models)) {
      requests += m?.api?.totalRequests ?? 0;
      tokens += m?.tokens?.total ?? 0;
    }
    return { requests, tokens, toolCalls: last?.stats?.tools?.totalCalls ?? 0 };
  } catch {
    return { requests: 0, tokens: 0, toolCalls: 0 };
  }
}

export function renderBench(b) {
  const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '-');
  const k = b.tasks.filter((t) => t.kurultay?.passed).length;
  const q = b.tasks.filter((t) => t.qwen?.passed).length;
  const sum = (sel) => b.tasks.reduce((s, t) => s + (sel(t) ?? 0), 0);
  const min = (s) => `${(s / 60).toFixed(1)} min`;
  return [
    `### Bench – ${b.name}`,
    '',
    `Models: ${b.models}. Same task text, a fresh copy of the project for every task, the same hidden tests.`,
    '',
    '| Agent | Passed | Rate | Total time | Requests |',
    '|---|---:|---:|---:|---:|',
    `| Kurultay | ${k} / ${b.tasks.length} | ${pct(k, b.tasks.length)} | ${min(sum((t) => t.kurultay?.seconds))} | ${sum((t) => t.kurultay?.requests)} |`,
    ...(b.tasks.some((t) => t.qwen) ? [`| Qwen Code | ${q} / ${b.tasks.length} | ${pct(q, b.tasks.length)} | ${min(sum((t) => t.qwen?.seconds))} | ${sum((t) => t.qwen?.requests) || '-'} |`] : []),
    '',
    '| Task | Kurultay | Qwen Code | Kurultay time | Qwen time |',
    '|---|:---:|:---:|---:|---:|',
    ...b.tasks.map((t) => `| ${t.suite}/${t.id} | ${t.kurultay ? (t.kurultay.passed ? '✅' : '❌') : '-'} | ${t.qwen ? (t.qwen.passed ? '✅' : '❌') : '-'} | ${t.kurultay ? min(t.kurultay.seconds) : '-'} | ${t.qwen ? min(t.qwen.seconds) : '-'} |`),
    '',
  ].join('\n');
}

async function main() {
  const f = flags(process.argv.slice(2));
  const out = resolve(f.out ?? 'bench-out');
  mkdirSync(out, { recursive: true });
  const evalMod = await import(pathToFileURL(join(root, 'dist', 'src', 'eval', 'eval.js')).href);
  const suites = String(f.suites ?? 'java-envanter,cpp-telemetri').split(',').map((s) => s.trim()).filter(Boolean);
  const wanted = f.tasks ? new Set(String(f.tasks).split(',').map((s) => s.trim())) : undefined;
  const minutes = Number(f.minutes ?? 30);
  const bench = { name: String(f.name ?? 'bench'), models: String(f.models ?? process.env.BENCH_MODELS ?? '?'), at: new Date().toISOString(), tasks: [] };

  for (const name of suites) {
    const suiteDir = join(root, 'samples', 'evals', name);
    const suite = evalMod.loadSuite(suiteDir);
    const tasks = suite.tasks.filter((t) => (wanted ? wanted.has(t.id) : t.id.startsWith('K')));
    if (!tasks.length) continue;
    // ---- Kurultay
    console.log(`\n== Kurultay · ${name}: ${tasks.map((t) => t.id).join(', ')}`);
    const k = await evalMod.runEval({ suiteDir, tasks: tasks.map((t) => t.id), modes: ['auto'], config: f.config, outDir: join(out, `kurultay-${name}`), onProgress: (l) => console.log(l) });
    for (const t of tasks) {
      const a = k.summary.attempts.find((x) => x.task === t.id);
      bench.tasks.push({ suite: name, id: t.id, kurultay: a && { passed: a.passed, seconds: a.seconds, requests: a.requests, tokens: a.tokensIn + a.tokensOut, status: a.status } });
    }
    // ---- Qwen Code
    if (!f.qwen) continue;
    for (const t of tasks) {
      const work = join(out, `qwen-${name}`, t.id);
      rmSync(work, { recursive: true, force: true });
      mkdirSync(dirname(work), { recursive: true });
      cpSync(join(suiteDir, suite.project), work, { recursive: true, filter: (p) => !/[\\/](\.kurultay|build|\.build)$/.test(p) });
      // Qwen Code works in a git repository like a developer would
      execFileSync('git', ['init', '-q'], { cwd: work });
      console.log(`\n== Qwen Code · ${name}/${t.id}`);
      const t0 = Date.now();
      const [cmd, ...pre] = String(f.qwen).split(' ');
      const r = spawnSync(cmd, [...pre, '-p', t.prompt, '--yolo', '--max-wall-time', `${minutes}m`, '--output-format', 'json'], { cwd: work, encoding: 'utf8', timeout: (minutes + 5) * 60_000, maxBuffer: 256 * 1024 * 1024, env: process.env });
      const seconds = (Date.now() - t0) / 1000;
      writeFileSync(join(out, `qwen-${name}-${t.id}.log`), `${r.stdout ?? ''}\n--- stderr\n${r.stderr ?? ''}`);
      const s = qwenStats(r.stdout ?? '');
      const score = await evalMod.scoreFolder({ suiteDir, dir: work, tasks: [t.id] });
      const row = bench.tasks.find((x) => x.suite === name && x.id === t.id);
      row.qwen = { passed: score[0].passed, seconds, requests: s.requests, tokens: s.tokens, exit: r.status };
      console.log(`${row.qwen.passed ? '✓' : '✗'} ${t.id} · ${seconds.toFixed(0)} s · ${s.requests} requests · exit ${r.status}`);
    }
  }
  writeFileSync(join(out, 'bench.json'), JSON.stringify(bench, null, 1));
  const md = renderBench(bench);
  writeFileSync(join(out, 'BENCH.md'), md);
  if (f['merge-notes']) {
    const { mergeNotes } = await import(pathToFileURL(join(root, 'scripts', 'swebench-summary.mjs')).href);
    const notes = String(f['merge-notes']);
    writeFileSync(notes, mergeNotes(existsSync(notes) ? readFileSync(notes, 'utf8') : '', 'bench', md));
  }
  process.stdout.write(`\n${md}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
