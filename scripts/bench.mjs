#!/usr/bin/env node
/* global setTimeout, clearTimeout */
// Head-to-head bench: Kurultay and Qwen Code on the same tasks, scored with the same hidden tests.
//
//   node scripts/bench.mjs --out bench-out [--suites java-envanter,cpp-telemetri] [--tasks K1-depo-transfer,…]
//                          [--config k.json] [--solo-config k-solo.json] [--qwen "qwen"] [--minutes 30] [--name v0.10.0]
//
// Per task up to three agents run, in an order rotated per task: Kurultay with all models,
// Kurultay with the main model only (--solo-config) and Qwen Code (--qwen).
// Kurultay runs through its own eval harness (fresh copy per task, hidden tests added afterwards).
// Qwen Code gets a fresh copy of the same project, the same task text, and is run headless
// (--yolo, a wall-clock budget); its folder is then scored with the same hidden tests.
// Writes <out>/bench.json and <out>/BENCH.md; --merge-notes <file> also merges the table into release notes.
import { execFileSync, spawn } from 'node:child_process';
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

export const AGENTS = [
  { key: 'kurultay', label: 'Kurultay' },
  { key: 'solo', label: 'Kurultay (main model only)' },
  { key: 'qwen', label: 'Qwen Code' },
];

/** Run order for the i-th task: rotated so no agent always goes first (warm caches, quieter API minutes). */
export function orderFor(i, keys) {
  const n = keys.length;
  return keys.map((_, j) => keys[(i + j) % n]);
}

/**
 * The evaluation section of the release notes: Kurultay's own score only (tasks solved, model,
 * tasks and trials, time) – the comparison table stays in benchmarks/bench/.
 */
export function renderEvaluation(b) {
  const runs = b.tasks.map((t) => t.kurultay).filter(Boolean);
  if (!runs.length) return '';
  const passed = runs.filter((r) => r.passed).length;
  const minutes = runs.reduce((s, r) => s + (r.seconds ?? 0), 0) / 60;
  const ids = [...new Set(b.tasks.filter((t) => t.kurultay).map((t) => `${t.suite}/${String(t.id).replace(/ #\d+$/, '')}`))];
  const trials = Math.round(runs.length / Math.max(1, ids.length));
  const suites = [...new Set(b.tasks.map((t) => t.suite))];
  const lang = suites.map((s) => (/java/i.test(s) ? 'Java 8' : /cpp|c\+\+/i.test(s) ? 'C++17' : s)).join(' and ');
  const model = /Kurultay: main ([^\s,·+]+)/.exec(b.models)?.[1] ?? b.models;
  const what = b.fault
    ? `with \`${b.fault.faulty}\` ${b.fault.mode === 'error' ? 'answering HTTP 503' : 'no longer answering'} after ${b.fault.after} of its requests in every run`
    : `with ${model}`;
  return [
    '### Kurultay evaluation',
    '',
    `On the bundled feature tasks (${ids.length} tasks${lang ? ` – ${lang}` : ''}, hidden acceptance tests${trials > 1 ? `, ${trials} trials each` : ''}), Kurultay ${b.name} solved **${passed}/${runs.length} (${Math.round((passed / runs.length) * 100)}%)** ${what}, in ${minutes.toFixed(1)} min.`,
  ].join('\n');
}

export function renderBench(b) {
  const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '-');
  const sum = (sel) => b.tasks.reduce((s, t) => s + (sel(t) ?? 0), 0);
  const min = (s) => `${(s / 60).toFixed(1)} min`;
  const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${Math.round(n / 1e3)} K` : String(n));
  const ran = AGENTS.filter((a) => b.tasks.some((t) => t[a.key]));
  const rows = ran.map((a) => {
    const got = b.tasks.filter((t) => t[a.key]);
    const passed = got.filter((t) => t[a.key].passed).length;
    const wait = sum((t) => t[a.key]?.rateLimitWait);
    const mm = sum((t) => t[a.key]?.multiModelSeconds);
    return `| ${a.label} | ${passed} / ${got.length} | ${pct(passed, got.length)} | ${min(sum((t) => t[a.key]?.seconds))} | ${sum((t) => t[a.key]?.requests) || '-'} | ${tok(sum((t) => t[a.key]?.tokens))} | ${a.key === 'qwen' ? '-' : min(wait)} | ${a.key === 'kurultay' ? min(mm) : '-'} |`;
  });
  const notes = [];
  // only tasks both Kurultay variants finished – two runs stopped by the time budget say nothing about speed
  const both = b.tasks.filter((t) => t.kurultay && t.solo && t.kurultay.status !== 'timeout' && t.solo.status !== 'timeout');
  const k = both.reduce((s, t) => s + t.kurultay.seconds, 0);
  const so = both.reduce((s, t) => s + t.solo.seconds, 0);
  // one agent with or without backup models: the difference is noise, not multi-model work
  const mm = both.reduce((s, t) => s + (t.kurultay.multiModelSeconds ?? 0), 0);
  if (k && so && mm > 0) {
    const d = k - so;
    notes.push(
      d > Math.max(30, so * 0.05)
        ? `⚠ **Multi-model slowdown:** with all models Kurultay took ${min(d)} (${Math.round((d / so) * 100)}%) longer than with the main model alone; ${min(both.reduce((s, t) => s + (t.kurultay.multiModelSeconds ?? 0), 0))} of its time went to multi-model work (plan council, waiting for slower candidates, cross-checks, judges, shared rate limit) – see each run's REPORT.md "Time".`
        : -d > Math.max(30, so * 0.05)
          ? `The extra models made Kurultay ${min(-d)} (${Math.round((-d / so) * 100)}%) faster than the main model alone.`
          : 'With all models Kurultay was about as fast as with the main model alone.',
    );
  }
  return [
    `### Bench – ${b.name}`,
    ...(b.fault ? ['', `**Fault test:** in every run \`${b.fault.faulty}\` ${b.fault.mode === 'error' ? 'answers HTTP 503' : 'stops answering (the connection stays open)'} after ${b.fault.after} of its requests. Kurultay has its other models; Qwen Code gets \`--fallback-model ${b.fault.fallback ?? '-'}\` (it switches on 429/503/529).`] : []),
    '',
    `Models: ${b.models}. Same task text, a fresh copy of the project for every task and agent, the same hidden tests; the run order is rotated per task.`,
    '',
    '| Agent | Passed | Rate | Total time | Requests | Tokens | Rate-limit wait | Multi-model work |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...rows,
    '',
    ...(notes.length ? [...notes, ''] : []),
    `| Task | ${ran.map((a) => a.label).join(' | ')} |`,
    `|---|${ran.map(() => ':---:').join('|')}|`,
    ...b.tasks.map((t) => `| ${t.suite}/${t.id} | ${ran.map((a) => (t[a.key] ? `${t[a.key].passed ? '✅' : '❌'} ${min(t[a.key].seconds)}` : '-')).join(' | ')} |`),
    '',
  ].join('\n');
}

/** One log line: where a Kurultay run's time went. */
export function timingLine(t) {
  if (!t) return '';
  const f = (x) => `${Math.round(x)} s`;
  const parts = [
    [t.planCouncil ? 'plan council' : 'triage', t.planning],
    ['coding', t.coding],
    ['slower candidates', t.slowerCandidates],
    ['candidate checks', t.selection],
    ['fix rounds', t.fixes],
    ['build/tests', t.verify],
    ['judges', t.requirements],
    ['rate limit', t.rateLimitWait],
    ['busy endpoint', t.slotWait],
  ].filter(([, v]) => v >= 0.5);
  return `   time: ${parts.map(([k, v]) => `${k} ${f(v)}`).join(' · ')} (total ${f(t.totalSeconds)}, multi-model ${Math.round(t.multiModelShare * 100)}%)`;
}

function kurultayResult(a) {
  return a && { passed: a.passed, seconds: a.seconds, requests: a.requests, tokens: a.tokensIn + a.tokensOut, status: a.status, rateLimitWait: a.rateLimitWait ?? 0, multiModelSeconds: a.multiModelSeconds ?? 0, multiModelShare: a.multiModelShare ?? 0, timing: a.timing };
}

/** Run a command without blocking the event loop (the fault proxy lives in this process). */
function run(cmd, args, opts) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeout);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolveRun({ status, stdout, stderr });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolveRun({ status: -1, stdout, stderr: `${stderr}\n${e.message}` });
    });
  });
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
  // fault test: the main model stops answering (or answers 503) after a few of its requests;
  // Kurultay gets every model, Qwen Code its own fallback chain with the same second model
  let kurultayConfig = f.config;
  let qwenEnv = process.env;
  let qwenExtra = [];
  let proxy;
  if (f.fault && f.fault !== 'none') {
    const { startFaultProxy, viaProxy } = await import(pathToFileURL(join(root, 'scripts', 'fault-proxy.mjs')).href);
    const cfg = JSON.parse(readFileSync(String(f.config), 'utf8'));
    const faulty = cfg.orchestrator?.primaryModel ?? cfg.endpoints?.[0]?.models?.[0];
    const second = cfg.endpoints?.find((e) => !(e.models ?? []).includes(faulty))?.models?.[0];
    const after = Number(f['fault-after'] ?? 3);
    proxy = await startFaultProxy({ routes: viaProxy(cfg, 'x').routes, faulty, mode: String(f.fault), after });
    kurultayConfig = join(out, 'config-fault.json');
    writeFileSync(kurultayConfig, JSON.stringify(viaProxy(cfg, proxy.url).config, null, 2));
    qwenEnv = { ...process.env, OPENAI_BASE_URL: proxy.url, OPENAI_API_KEY: 'proxy', OPENAI_MODEL: faulty };
    qwenExtra = second ? ['--fallback-model', second] : [];
    bench.fault = { mode: String(f.fault), after, faulty, fallback: second };
    console.log(`fault test: ${faulty} ${f.fault === 'error' ? 'answers 503' : 'stops answering'} after ${after} of its requests in every run; second model ${second ?? '(none)'}`);
  }
  const only = f.agents ? String(f.agents).split(',').map((s) => s.trim()) : undefined;
  const keys = ['kurultay', ...(f['solo-config'] && !proxy ? ['solo'] : []), ...(f.qwen ? ['qwen'] : [])].filter((k) => !only || only.includes(k));
  let i = 0;
  // the CI job has a hard limit: stop starting runs that could not finish before it, so the
  // results are still written, committed and added to the release notes
  const stopAt = f['stop-after'] ? Date.now() + Number(f['stop-after']) * 60_000 : Infinity;
  let stopped = false;

  for (const name of suites) {
    const suiteDir = join(root, 'samples', 'evals', name);
    const suite = evalMod.loadSuite(suiteDir);
    const tasks = suite.tasks.filter((t) => (wanted ? wanted.has(t.id) : t.id.startsWith('K')));
    const repeat = Math.max(1, Number(f.repeat ?? 1));
    for (const t of tasks.flatMap((x) => Array.from({ length: repeat }, (_, r) => ({ ...x, rep: r + 1 })))) {
      // --repeat N: the same task N times (a pass rate instead of one draw – model speed and luck vary)
      const row = { suite: name, id: repeat > 1 ? `${t.id} #${t.rep}` : t.id };
      const tag = repeat > 1 ? `${t.id}-${t.rep}` : t.id;
      bench.tasks.push(row);
      for (const key of orderFor(i++, keys)) {
        if (Date.now() + (minutes + 3) * 60_000 > stopAt) {
          if (!stopped) console.log(`\n== time limit of the job near: no further runs (${t.id} and later are left out)`);
          stopped = true;
          break;
        }
        if (key === 'kurultay' || key === 'solo') {
          console.log(`\n== ${key === 'solo' ? 'Kurultay (main model only)' : 'Kurultay'} · ${name}/${t.id}`);
          const config = key === 'solo' ? String(f['solo-config']) : kurultayConfig;
          proxy?.reset?.();
          const k = await evalMod.runEval({ suiteDir, tasks: [t.id], modes: ['auto'], config, runTimeoutSec: minutes * 60, keepFailed: true, outDir: join(out, `${key}-${name}-${tag}`), onProgress: (l) => console.log(l) });
          row[key] = kurultayResult(k.summary.attempts.find((x) => x.task === t.id));
          if (row[key]?.timing) console.log(timingLine(row[key].timing));
          const att = k.summary.attempts.find((x) => x.task === t.id);
          if (att?.models?.length) console.log(`   models: ${att.models.join(', ')}${att.llmErrors ? ` · ${att.llmErrors} failed requests` : ''}`);
          if (att) {
            console.log(`   project's own checks: ${att.ownChecks ?? '?'} · files: ${(att.files ?? []).join(', ') || '-'}`);
          }
          // a failed run: which hidden tests failed and why (the end of the check output)
          if (att && !att.passed) console.log(`   hidden tests (failures first, then the last lines):\n${evalMod.failureLines(att.checkOutput).split('\n').map((l) => `     | ${l}`).join('\n')}`);
          continue;
        }
        const work = join(out, `qwen-${name}`, tag);
        rmSync(work, { recursive: true, force: true });
        mkdirSync(dirname(work), { recursive: true });
        cpSync(join(suiteDir, suite.project), work, { recursive: true, filter: (p) => !/[\\/](\.kurultay|build|\.build)$/.test(p) });
        // Qwen Code works in a git repository like a developer would
        execFileSync('git', ['init', '-q'], { cwd: work });
        console.log(`\n== Qwen Code · ${name}/${t.id}`);
        const t0 = Date.now();
        const [cmd, ...pre] = String(f.qwen).split(' ');
        proxy?.reset?.();
        const r = await run(cmd, [...pre, '-p', t.prompt, '--yolo', '--max-wall-time', `${minutes}m`, '--output-format', 'json', ...qwenExtra], { cwd: work, timeout: (minutes + 5) * 60_000, env: qwenEnv });
        const seconds = (Date.now() - t0) / 1000;
        writeFileSync(join(out, `qwen-${name}-${tag}.log`), `${r.stdout ?? ''}\n--- stderr\n${r.stderr ?? ''}`);
        const s = qwenStats(r.stdout ?? '');
        const score = await evalMod.scoreFolder({ suiteDir, dir: work, tasks: [t.id] });
        row.qwen = { passed: score[0].passed, seconds, requests: s.requests, tokens: s.tokens, exit: r.status };
        console.log(`${row.qwen.passed ? '✓' : '✗'} ${t.id} · ${seconds.toFixed(0)} s · ${s.requests} requests · exit ${r.status}`);
        if (!row.qwen.passed) console.log(`   hidden tests (failures first, then the last lines):\n${evalMod.failureLines(String(score[0].output ?? '')).split('\n').map((l) => `     | ${l}`).join('\n')}`);
      }
      if (stopped && !Object.keys(row).some((k) => keys.includes(k))) bench.tasks.pop();
      // partial results survive a cancelled job
      writeFileSync(join(out, 'bench.json'), JSON.stringify(bench, null, 1));
      writeFileSync(join(out, 'BENCH.md'), renderBench(bench));
    }
  }
  await proxy?.close();
  writeFileSync(join(out, 'bench.json'), JSON.stringify(bench, null, 1));
  const md = renderBench(bench);
  writeFileSync(join(out, 'BENCH.md'), md);
  writeFileSync(join(out, 'EVALUATION.md'), renderEvaluation(bench));
  if (f['merge-notes']) {
    const { mergeNotes } = await import(pathToFileURL(join(root, 'scripts', 'swebench-summary.mjs')).href);
    const notes = String(f['merge-notes']);
    writeFileSync(notes, mergeNotes(existsSync(notes) ? readFileSync(notes, 'utf8') : '', 'bench', renderEvaluation(bench)));
  }
  process.stdout.write(`\n${md}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let finished = false;
  // a promise nobody will ever settle lets Node exit with code 0 in the middle of a run –
  // the job would then look successful with half of the table missing
  process.on('beforeExit', () => {
    if (finished) return;
    console.error('::error::bench: the process ran out of work before the bench finished (a promise that never settles) – the results are incomplete');
    process.exit(2);
  });
  main().then(
    () => {
      finished = true;
    },
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
