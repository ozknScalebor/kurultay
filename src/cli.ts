import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { ProjectAnalyzer } from './analyze/summarizer.js';
import { createApp, loadOrBuildIndex, prepareRetrieval, startMcp, type App } from './app.js';
import { closeLspServers } from './lsp/client.js';
import { VectorStore } from './index/embeddings.js';
import { ConfigError, SAMPLE_CONFIG, kurultayHome, loadConfig, type RunMode } from './config.js';
import { SKILL_TEMPLATE, SkillRegistry } from './skills/skills.js';
import { modifiedSince, readCheckpoint, rewindCheckpoint } from './agent/checkpoint.js';
import { ProjectIndex } from './index/project-index.js';
import { DEFAULT_MOCK_MODELS, startMockServer } from './mock/server.js';
import { Orchestrator, fmtDuration, fmtTokens, loadRunUsage, mergeUsage, renderPlan, renderUsageTable, type RunUsage } from './orchestrator/orchestrator.js';
import { ModelStats } from './llm/stats.js';
import type { Plan } from './orchestrator/planner.js';
import { askProject } from './ops.js';
import { detectVerifyCommands } from './orchestrator/verify.js';
import { renderCapabilitiesMarkdown, writeCapabilities } from './probe/probe.js';
import { profilePath, runProbe } from './probe/profile.js';
import { startDashboard } from './ui/dashboard.js';
import { attachTerminal, color, fmtSeconds } from './ui/terminal.js';
import { EventBus } from './util/events.js';
import { forTerminal, setUnicode } from './ui/symbols.js';
import { plural } from './util/text.js';

const VERSION = JSON.parse(readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'package.json'), 'utf8')).version as string;

interface Args {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const booleans = new Set(['deep', 'quick', 'force', 'dry-run', 'yes', 'ui', 'verbose', 'help', 'version', 'json', 'v', 'h', 'y', 'no-index', 'no-probe', 'no-analyze', 'continue', 'c', 'validate', 'keep', 'approve-plan', 'embed', 'ascii']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2);
      if (v !== undefined) flags[k] = v;
      else if (booleans.has(k) || argv[i + 1] === undefined || argv[i + 1].startsWith('-')) flags[k] = true;
      else flags[k] = argv[++i];
    } else if (a.startsWith('-') && a.length === 2) {
      flags[a.slice(1)] = true;
    } else positional.push(a);
  }
  return { cmd: positional.shift() ?? '', positional, flags };
}

const HELP = `${color.bold('kurultay')} ${VERSION} — offline coding agent that uses all your local LLMs together

Usage: kurultay                 interactive console (choose a workspace, / commands)
       kurultay <command> [options]

Commands:
  console              Interactive console (--workspace <dir>, --continue | --resume [id], --worktree <name>,
                         --no-probe, --no-analyze)
  probe                Measure the models and save the capability profile (runs once; use this to re-measure)
                         --deep (thorough, slower), --quick (no benchmark), --model <name> (only this model)
  run "<task>"         Plan the task, distribute it to the models, verify, review and apply
                         --mode auto|single|split|race|council   --req <file>   --dry-run   --yes
                         --skill a,b (preload skills; $skill-name in the task text works too)
                         --approve-plan (show the plan before code is written: approve / reject / feedback)
                         --max-tokens N --max-minutes N (stop when the budget runs out; resumable)
                         --resume [session] (continue an interrupted task where it stopped)
  ask "<question>"     Ask about the project: models answer separately, the council merges (--members N)
  eval <suite>         Measure quality: run a task suite and score it with hidden tests
                         (--modes single,race,council --tasks a,b --repeat N --out <dir> --keep;
                          --validate: check that tasks fail on the base project and pass with the reference solution)
  rewind [session]     Undo what a task applied to the project (default: last task; --yes, --force)
  init                 Create kurultay.config.json and rule/skill templates in the project root
  index                Index the project (symbols, dependency graph, PageRank) – no LLM needed
                         --embed: also build semantic search vectors with an embedding model
  analyze              Index + parallel summaries with all models: ARCHITECTURE.md, PROJECT_NOTES.md, flow documents
                         (--force, --drafts N, --flows N; 0 = no flows)
  map                  Print the repo map (--tokens N, --focus a,b)
  skills               List and validate skills; "skills new <name> --description ..." creates one
  search "<query>"     Search the index (BM25; BM25 + embeddings with RRF once vectors exist)
  status               Models, index and recent sessions
  stats                Per-model requests/tokens/time of recent tasks and learned success rates (--runs N)
  mock                 Start a fake OpenAI-compatible LLM server for testing (--port 9100)

Options:
  --root <dir>         Project root (default: current directory)
  --config <file>      Configuration file
  --ui [--port 7420]   Open the live web dashboard (offline, 127.0.0.1)
  --verbose            Show every step, tool call and LLM request
  --ascii              Plain ASCII output (for consoles that cannot show symbols)
`;

function out(s: string) {
  process.stdout.write(forTerminal(s) + '\n');
}

async function withUi(app: App, flags: Args['flags']): Promise<() => void> {
  const detach = attachTerminal(app.bus, { verbose: !!flags.verbose });
  if (!flags.ui) return detach;
  const port = Number(flags.port ?? 7420);
  try {
    const { server, url } = await startDashboard(app.bus, app.router, port);
    out(`${color.bold('Pano')}: ${url}`);
    return () => {
      detach();
      server.close();
    };
  } catch (e) {
    out(color.yellow(`Could not start the dashboard: ${(e as Error).message}`));
    return detach;
  }
}

function requireModels(app: App): void {
  if (app.router.size === 0) {
    throw new ConfigError('No model is reachable. Check the endpoint address and API key, then run "kurultay probe".');
  }
  if (!app.probed) out(color.yellow('Note: no capability profile yet, default values are used. Run "kurultay probe" once for the best results.'));
}

async function cmdInit(root: string, flags: Args['flags']) {
  const cfgPath = join(root, 'kurultay.config.json');
  if (existsSync(cfgPath) && !flags.force) {
    out(`${cfgPath} already exists (--force overwrites it).`);
  } else {
    const cfg = { ...SAMPLE_CONFIG, verify: detectVerifyCommands(root) };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    out(`${color.green('✓')} created ${cfgPath} – edit the server address, API key and model names.`);
  }
  const state = join(root, '.kurultay');
  for (const d of ['rules', 'skills']) mkdirSync(join(state, d), { recursive: true });
  const tpl = (p: string, content: string) => {
    if (!existsSync(p)) writeFileSync(p, content);
  };
  tpl(
    join(state, 'rules', 'general.md'),
    `---\nname: general-rules\ndescription: Project rules for every change\n---\n# General rules\n\n- Keep the existing code style; no unnecessary reformatting.\n- Add a unit test for every new public function.\n- Never swallow error codes; log them and pass them up.\n`,
  );
  tpl(
    join(state, 'rules', 'java.md'),
    `---\nname: java-rules\napplies_to: "*.java"\n---\n# Java rules\n\n- Fields should be final where possible.\n- Add a context message before wrapping checked exceptions in RuntimeException.\n`,
  );
  mkdirSync(join(state, 'skills', 'add-new-driver', 'references'), { recursive: true });
  tpl(
    join(state, 'skills', 'add-new-driver', 'SKILL.md'),
    `---\nname: add-new-driver\ndescription: Steps for adding a new hardware driver - interface header, init/deinit/read/write, platform registration and tests. Use it when the task adds a new driver.\nkeywords: [driver]\n---\n# Adding a new driver\n\n1. Create the interface header under include/ (see references/interface-rules.md).\n2. Implement init/deinit/read/write under drivers/.\n3. Add the driver to the platform registration table.\n4. Add a unit test under tests/ and check that the build passes.\n`,
  );
  tpl(join(state, 'skills', 'add-new-driver', 'references', 'interface-rules.md'), `# Interface rules\n\n- Every function returns an error code (int); 0 = success.\n- Hardware register addresses are defined in a single header.\n`);
  tpl(join(state, 'review_rules.md'), `# Review rules\n\n- No memory leaks, buffer overflows or race conditions.\n- Every error path releases its resources.\n- Public API changes are documented.\n`);
  out(`${color.green('✓')} templates ready: .kurultay/rules, .kurultay/skills, .kurultay/review_rules.md`);
  out(`Tip: add ".kurultay/" to your .gitignore (or keep the rule folders under version control).`);
  out(`\nNext steps:\n  kurultay probe\n  kurultay analyze\n  kurultay run "describe the task"`);
}

async function cmdProbe(app: App, flags: Args['flags']) {
  const stop = await withUi(app, flags);
  try {
    const models = typeof flags.model === 'string' ? flags.model.split(',').map((m) => m.trim()).filter(Boolean) : undefined;
    const t0 = Date.now();
    out(`${color.bold('Capability probe')} – ${models ? models.join(', ') : 'all configured models'}${flags.deep ? ' (deep)' : flags.quick ? ' (quick)' : ''}`);
    const run = await runProbe(app.config, app.bus, { deep: !!flags.deep, quick: !!flags.quick, scope: 'all', models });
    if (!run) return;
    const paths = writeCapabilities(app.stateDir, run.profile);
    out('\n' + renderCapabilitiesMarkdown(run.measured));
    out(`${color.green('✓')} measured ${run.measured.models.length} model${run.measured.models.length === 1 ? '' : 's'} in ${fmtSeconds((Date.now() - t0) / 1000)}`);
    out(`${color.green('✓')} saved ${profilePath()} ${color.dim('(used by every project; measured again only with "kurultay probe")')}`);
    out(`${color.green('✓')} ${paths.md}`);
  } finally {
    stop();
  }
}

async function cmdIndex(app: App, flags: Args['flags']) {
  const { index, stats } = loadOrBuildIndex(app);
  const s = index.stats();
  out(`${color.green('✓')} index: ${plural(s.files, 'file')}, ${s.lines.toLocaleString('en')} lines, ${plural(s.defs, 'definition')}, ${s.edges} dependency edges`);
  if (stats) out(color.dim(`  added ${stats.added}, changed ${stats.changed}, removed ${stats.removed}`));
  out(color.dim(`  languages: ${Object.entries(s.langs).map(([l, n]) => `${l}:${n}`).join(' ')}`));
  if (flags.embed) await reportRetrieval(app, index);
}

/** Build/refresh the embedding vectors and print one line about it. */
async function reportRetrieval(app: App, index: ProjectIndex): Promise<void> {
  const r = await prepareRetrieval(app, index);
  if (!r.model) out(color.dim('  semantic search: no embedding model (BM25 only). Set one with config.embeddings.model.'));
  else if (r.error) out(color.yellow(`  semantic search: ${r.model} unavailable – ${r.error}`));
  else out(`${color.green('✓')} semantic search: ${r.model} · ${plural(r.vectors, 'chunk')} embedded (${r.embedded} new)`);
}

async function cmdAnalyze(app: App, flags: Args['flags']) {
  requireModels(app);
  const stop = await withUi(app, flags);
  try {
    const { index } = loadOrBuildIndex(app);
    const s = index.stats();
    out(`${color.bold('Analysis')}: ${plural(s.files, 'file')}, ${plural(app.router.size, 'model')}, ${app.router.totalCapacity()} parallel slots`);
    const analyzer = new ProjectAnalyzer(index, app.router, app.config, app.bus);
    const r = await analyzer.run({
      force: !!flags.force,
      architectureDrafts: flags.drafts !== undefined ? Number(flags.drafts) : undefined,
      flows: flags.flows !== undefined ? Number(flags.flows) : undefined,
    });
    out(`\n${color.green('✓')} ${plural(r.filesSummarized, 'file')} summarised, ${plural(r.modules, 'module')}, ${plural(r.flowPaths.length, 'flow document')}, ${plural(r.failures, 'failure')}`);
    out(`${color.green('✓')} ${r.architecturePath}`);
    if (r.notesPath) out(`${color.green('✓')} ${r.notesPath}`);
    for (const f of r.flowPaths) out(`${color.green('✓')} ${f}`);
    out(color.dim(`  model usage: ${Object.entries(r.modelsUsed).map(([m, n]) => `${m}×${n}`).join(', ')}`));
    await reportRetrieval(app, index);
  } finally {
    stop();
  }
}

async function confirmPrompt(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^(y|yes)$/i.test(a.trim());
}

/** Plan approval on the terminal: Enter/e = go, h = cancel, any other text = feedback for a revised plan. */
async function approvePlanPrompt(plan: Plan, info: { mode: RunMode; round: number }): Promise<boolean | string> {
  out('\n' + renderPlan(plan, info.mode) + '\n');
  if (!process.stdin.isTTY) {
    out(color.yellow('Not an interactive terminal; the plan is approved automatically.'));
    return true;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`Approve the plan? [Y]es / [n]o / or type the changes you want: `)).trim();
  rl.close();
  if (!a || /^(y|yes)$/i.test(a)) return true;
  if (/^(n|no)$/i.test(a)) return false;
  return a;
}

function numFlag(v: string | boolean | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ConfigError(`--${name} must be a number`);
  return n;
}

async function cmdRun(app: App, args: Args) {
  const task = args.positional.join(' ').trim();
  const resume = args.flags.resume;
  if (!task && !resume) throw new ConfigError('A task is required: kurultay run "..." (to continue an interrupted task: kurultay run --resume [session])');
  requireModels(app);
  const stop = await withUi(app, args.flags);
  const ctrl = new AbortController();
  const onSig = () => {
    out(color.yellow('\nStopping… (unfinished changes are rolled back; continue later with "kurultay run --resume")'));
    ctrl.abort(new Error('cancelled by the user'));
  };
  process.once('SIGINT', onSig);
  let mcp: Awaited<ReturnType<typeof startMcp>>;
  try {
    const { index } = loadOrBuildIndex(app);
    await prepareRetrieval(app, index, { signal: ctrl.signal });
    if (!existsSync(join(app.stateDir, 'ARCHITECTURE.md'))) out(color.yellow('Tip: run "kurultay analyze" once so the models know the project architecture.'));
    const reqFile = typeof args.flags.req === 'string' ? args.flags.req : undefined;
    const requirements = reqFile ? readFileSync(resolve(reqFile), 'utf8') : undefined;
    const orch = new Orchestrator(app.root, app.config, app.router, app.materializer, index, app.bus);
    mcp = await startMcp(app);
    orch.external = mcp;
    if (args.flags.yes || args.flags.y) app.config.orchestrator.confirmMerge = false;
    const opts = {
      mode: (args.flags.mode as RunMode) || undefined,
      skills: typeof args.flags.skill === 'string' ? args.flags.skill.split(',').map((x) => x.trim()).filter(Boolean) : undefined,
      requirements,
      dryRun: args.flags['dry-run'] ? true : undefined,
      confirm: confirmPrompt,
      signal: ctrl.signal,
      approvePlan: args.flags['approve-plan'] || app.config.orchestrator.approvePlan ? approvePlanPrompt : undefined,
      budget: { tokens: numFlag(args.flags['max-tokens'], 'max-tokens'), minutes: numFlag(args.flags['max-minutes'], 'max-minutes') },
    };
    if (resume) {
      const list = Orchestrator.resumable(app.root, app.config.stateDir);
      if (resume === true && !list.length) throw new ConfigError('There is no interrupted task to continue.');
      const id = typeof resume === 'string' ? resume : list[0].id;
      out(`${color.bold('Resuming')}: ${id}`);
    }
    const report = resume ? await orch.resume(typeof resume === 'string' ? resume : undefined, opts) : await orch.run(task, opts);
    out('');
    const st = report.status === 'completed' ? color.green(report.status) : color.yellow(report.status);
    out(`\n${color.bold('Result')}: ${st} · ${plural(report.changedFiles.length, 'file')} changed · ${report.iterations} iteration${report.iterations === 1 ? '' : 's'}`);
    out(color.dim(`  models: ${report.modelsUsed.join(', ') || '-'}`));
    for (const f of report.changedFiles) out(`  ${f}`);
    if (report.merge?.conflicts.length) out(color.yellow(`Conflicts: ${report.merge.conflicts.join(', ')}`));
    out(`${color.bold('Report')}: ${report.reportPath}`);
    out(`${color.bold('Diff')}:  ${report.diffPath}`);
    if (report.usage) out(`${color.bold('Usage')}: ${plural(report.usage.requests, 'request')} · ${fmtTokens(report.usage.tokensIn + report.usage.tokensOut)} tokens · ${fmtDuration(report.usage.seconds)}`);
    if (report.stopReason && report.status === 'incomplete') out(color.yellow(`Stopped: ${report.stopReason}. Continue with: kurultay run --resume ${report.sessionId}`));
    if (report.status !== 'completed') process.exitCode = 2;
  } finally {
    process.off('SIGINT', onSig);
    mcp?.close();
    await closeLspServers();
    stop();
  }
}

async function cmdAsk(app: App, args: Args) {
  const q = args.positional.join(' ').trim();
  if (!q) throw new ConfigError('A question is required: kurultay ask "..."');
  requireModels(app);
  const stop = attachTerminal(app.bus, { verbose: !!args.flags.verbose });
  try {
    const { index } = loadOrBuildIndex(app);
    await prepareRetrieval(app, index);
    const r = await askProject(app, index, q, { members: args.flags.members !== undefined ? Number(args.flags.members) : undefined });
    out('\n' + r.answer.trim());
    out(color.dim(`\n– council: ${r.members.join(', ')}${r.chair ? ` · chair: ${r.chair}` : ''}`));
  } finally {
    stop();
  }
}

async function cmdSkills(root: string, args: Args, cfgSkills?: { paths: string[]; disabled: string[]; includeUser: boolean }) {
  const sub = args.positional[0];
  if (sub === 'new') {
    const name = (args.positional[1] ?? '').trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new ConfigError('A skill name uses lowercase letters, digits and hyphens (e.g. "code-review"), at most 64 characters.');
    const dir = join(root, '.kurultay', 'skills', name);
    if (existsSync(join(dir, 'SKILL.md'))) throw new ConfigError(`${join(dir, 'SKILL.md')} already exists.`);
    mkdirSync(dir, { recursive: true });
    const desc = typeof args.flags.description === 'string' ? args.flags.description : 'What this skill does and when to use it – the models choose skills by this sentence.';
    writeFileSync(join(dir, 'SKILL.md'), SKILL_TEMPLATE(name, desc));
    out(`${color.green('✓')} ${join(dir, 'SKILL.md')}`);
    return;
  }
  const reg = SkillRegistry.discover(root, { extraPaths: cfgSkills?.paths, disabled: cfgSkills?.disabled, includeUser: cfgSkills?.includeUser ?? true });
  if (!reg.size) out("No skills found. Create one with: kurultay skills new <name>  (searched: .kurultay/skills, .agents/skills, .claude/skills, .codex/skills, .qwen/skills, .goose/skills, .opencode/skills, .github/skills, skills/, ~/.agents/skills, ~/.claude/skills)");
  for (const s of reg.skills) {
    const flags = [s.hidden ? 'explicit selection only' : '', s.always ? 'always' : '', s.paths.length ? `paths: ${s.paths.join(' ')}` : '', s.keywords.length ? `keywords: ${s.keywords.join(', ')}` : '', s.files.length ? `${s.files.length} support files` : '']
      .filter(Boolean)
      .join(' · ');
    out(`${color.bold(s.name)}  ${color.dim(`[${s.source}${s.format === 'file' ? ', single file' : ''}]`)}
  ${s.description}${flags ? `
  ${color.dim(flags)}` : ''}`);
  }
  if (reg.diagnostics.length) {
    out(`
${color.yellow('Warnings:')}`);
    for (const d of reg.diagnostics) out(`  ${d.level === 'error' ? color.red('✖') : color.yellow('⚠')} ${d.path}: ${d.message}`);
    if (reg.diagnostics.some((d) => d.level === 'error')) process.exitCode = 1;
  }
}

async function cmdEval(args: Args) {
  const dir = args.positional[0];
  if (!dir) throw new ConfigError('A suite folder is required: kurultay eval <dir>');
  const list = (v: unknown) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
  const { runEval, validateSuite } = await import('./eval/eval.js');
  const common = {
    suiteDir: resolve(dir),
    tasks: list(args.flags.tasks),
    outDir: typeof args.flags.out === 'string' ? resolve(args.flags.out) : undefined,
    config: typeof args.flags.config === 'string' ? args.flags.config : undefined,
    keepWork: !!args.flags.keep,
    onProgress: (l: string) => out(l),
  };
  try {
    if (args.flags.validate) {
      const r = await validateSuite(common);
      const bad = r.filter((x) => !x.baselineFails || x.solutionPasses === false);
      for (const b of bad) out(color.red(`✗ ${b.task}\n${b.output.split('\n').slice(-12).join('\n')}`));
      out(bad.length ? color.red(`${bad.length}/${plural(r.length, 'task')} invalid`) : color.green(`✓ ${plural(r.length, 'task')} valid`));
      if (bad.length) process.exitCode = 1;
      return;
    }
    const modes = (list(args.flags.modes) ?? ['single']) as RunMode[];
    const { summary, reportPath, jsonPath } = await runEval({ ...common, modes, repeat: args.flags.repeat !== undefined ? Number(args.flags.repeat) : undefined });
    out('');
    for (const [m, b] of Object.entries(summary.byMode)) out(`${color.bold(m.padEnd(8))} ${b.passed}/${b.attempts} passed (${Math.round(b.passRate * 100)}%) · avg ${b.avgSeconds.toFixed(1)} s · ${Math.round(b.avgTokens)} tokens · ${b.avgRequests.toFixed(1)} requests`);
    out(`${color.bold('Report')}: ${reportPath}\n${color.bold('JSON')}:   ${jsonPath}`);
  } catch (e) {
    if (e instanceof Error && !(e instanceof ConfigError)) throw new ConfigError(e.message);
    throw e;
  }
}

/** Undo what a run applied to the project, using its checkpoint (last applied run by default). */
async function cmdRewind(root: string, args: Args) {
  const sessions = join(root, '.kurultay', 'sessions');
  const ref = args.positional[0];
  const candidates = existsSync(sessions)
    ? readdirSync(sessions)
        .sort()
        .reverse()
        .filter((s) => (!ref || s === ref || s.startsWith(ref)) && existsSync(join(sessions, s, 'checkpoint.json')))
    : [];
  const id = candidates.find((s) => !readCheckpoint(join(sessions, s, 'checkpoint.json'))?.rewoundAt) ?? candidates[0];
  if (!id) throw new ConfigError(ref ? `No session to rewind: ${ref}` : 'No applied task that can be rewound.');
  const file = join(sessions, id, 'checkpoint.json');
  const cp = readCheckpoint(file)!;
  if (cp.rewoundAt) throw new ConfigError(`${id} was already rewound (${cp.rewoundAt}).`);
  const files = Object.keys(cp.files);
  out(`${color.bold(id)} — ${cp.label}`);
  out(`${plural(files.length, 'file')} will be restored: ${files.join(', ')}`);
  const touched = modifiedSince(root, cp);
  if (touched.length) out(color.yellow(`Warning: changed after the task was applied: ${touched.join(', ')}${args.flags.force ? ' (--force: will be overwritten)' : ' (skipped; --force overwrites them)'}`));
  if (!(args.flags.yes || args.flags.y) && !(await confirmPrompt('Rewind?'))) {
    out('Cancelled.');
    process.exitCode = 1;
    return;
  }
  const r = rewindCheckpoint(root, file, { force: !!args.flags.force });
  out(`${color.green('✓')} ${plural(r.restored.length, 'file')} restored${r.skipped.length ? color.yellow(`, ${r.skipped.length} skipped: ${r.skipped.join(', ')}`) : ''}`);
  if (r.skipped.length) process.exitCode = 2;
}

async function cmdStatus(app: App) {
  out(`${color.bold('Project')}: ${app.root}`);
  out(`${color.bold('Config')}:  ${app.configPath}`);
  out(`${color.bold('Models')} (${app.router.size}, ${app.probed ? 'capability profile' : 'discovered, not probed'}):`);
  for (const h of app.router.list()) {
    const c = h.caps;
    const best = Object.entries(c.roleScores).sort((a, b) => b[1] - a[1])[0];
    out(`  ${c.key.padEnd(40)} context ${String(c.contextWindow).padStart(7)} · ${c.nativeTools ? 'native tools' : 'prompt tools'} · ${c.tokensPerSec} tok/s · best role ${best[0]} (${best[1]})`);
  }
  const idx = ProjectIndex.load(app.root, app.stateDir);
  if (idx) {
    const s = idx.stats();
    out(`${color.bold('Index')}:   ${plural(s.files, 'file')}, ${plural(s.defs, 'definition')}, ${idx.files.filter((f) => f.summary).length} summarised (${idx.data.builtAt})`);
  } else out(`${color.bold('Index')}:   none – "kurultay index" or "kurultay analyze"`);
  const sessions = join(app.stateDir, 'sessions');
  if (existsSync(sessions)) {
    const list = readdirSync(sessions).sort().slice(-5);
    out(`${color.bold('Recent runs')}:`);
    for (const s of list) out(`  ${s}  →  ${join(sessions, s, 'REPORT.md')}`);
  }
}

/** Per-run and per-model consumption across the last task runs (observability). */
function cmdStats(stateDir: string, flags: Args['flags']) {
  const n = numFlag(flags.runs, 'runs') ?? 10;
  const runs = loadRunUsage(stateDir, n);
  if (!runs.length) return out('No task runs recorded yet.');
  const total: RunUsage = { requests: 0, tokensIn: 0, tokensOut: 0, seconds: 0, byModel: {} };
  out(color.bold(`Last ${runs.length} task${runs.length === 1 ? '' : 's'}:`));
  for (const r of runs) {
    out(`  ${r.id}  ${r.status.padEnd(10)} ${String(r.usage.requests).padStart(5)} req · ${fmtTokens(r.usage.tokensIn + r.usage.tokensOut).padStart(6)} tokens · ${fmtDuration(r.usage.seconds).padStart(10)}  ${r.task.split('\n')[0].slice(0, 60)}`);
    mergeUsage(total, r.usage);
  }
  out('');
  out(color.bold(`Total: ${plural(total.requests, 'request')} · ${fmtTokens(total.tokensIn)} in / ${fmtTokens(total.tokensOut)} out tokens · ${fmtDuration(total.seconds)}`));
  out(renderUsageTable(total).join('\n'));
  const learned = new ModelStats(join(kurultayHome(), 'model-stats.json'));
  const rates = Object.keys(total.byModel)
    .map((k) => [k, learned.summary(k)] as const)
    .filter((x): x is readonly [string, { n: number; rate: number }] => !!x[1]);
  if (rates.length) out(`\n${color.bold('Learned success rate')}: ${rates.map(([k, s]) => `${k} ${Math.round(s.rate * 100)}% (${s.n})`).join(' · ')}`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.flags.ascii) setUnicode(false);
  if (args.flags.version || args.flags.v) return out(VERSION);
  if (args.cmd === '' && !args.flags.help && !args.flags.h && process.stdin.isTTY && process.stdout.isTTY) args.cmd = 'console';
  if (args.cmd === '' || args.cmd === 'help' || args.flags.help || args.flags.h) return out(HELP);
  if (args.cmd === 'console' || args.cmd === 'tui' || args.cmd === 'chat') {
    const { KurultayConsole } = await import('./tui/console.js');
    const c = new KurultayConsole(
      { input: process.stdin, output: process.stdout },
      {
        version: VERSION,
        workspace: typeof args.flags.workspace === 'string' ? args.flags.workspace : args.positional[0],
        config: typeof args.flags.config === 'string' ? args.flags.config : undefined,
        autoIndex: !args.flags['no-index'],
        autoProbe: !args.flags['no-probe'],
        autoAnalyze: !args.flags['no-analyze'],
        resume: args.flags.continue || args.flags.c ? true : typeof args.flags.resume === 'string' ? args.flags.resume : args.flags.resume ? true : undefined,
        worktree: typeof args.flags.worktree === 'string' ? args.flags.worktree : undefined,
      },
    );
    process.exitCode = await c.run();
    return;
  }
  const KNOWN = ['init', 'mock', 'probe', 'index', 'analyze', 'run', 'ask', 'status', 'map', 'search', 'skills', 'rewind', 'eval', 'stats'];
  if (!KNOWN.includes(args.cmd)) {
    out(`Unknown command: ${args.cmd}\n`);
    out(HELP);
    process.exitCode = 1;
    return;
  }
  const root = resolve(typeof args.flags.root === 'string' ? args.flags.root : process.cwd());
  const configPath = typeof args.flags.config === 'string' ? args.flags.config : undefined;
  try {
    switch (args.cmd) {
      case 'init':
        return await cmdInit(root, args.flags);
      case 'skills': {
        let cfgSkills;
        try {
          cfgSkills = loadConfig(root, configPath).config.skills;
        } catch {
          cfgSkills = undefined; // skills work without a config file
        }
        return await cmdSkills(root, args, cfgSkills);
      }
      case 'rewind':
        return await cmdRewind(root, args);
      case 'stats': {
        let stateDir = '.kurultay';
        try {
          stateDir = loadConfig(root, configPath).config.stateDir;
        } catch {
          /* statistics need no endpoints */
        }
        return cmdStats(join(root, stateDir), args.flags);
      }
      case 'eval':
        return await cmdEval(args);
      case 'mock': {
        const port = Number(args.flags.port ?? 9100);
        const { url } = await startMockServer(DEFAULT_MOCK_MODELS, port);
        out(`Mock LLM server running: ${url}\nModels: ${DEFAULT_MOCK_MODELS.map((m) => m.id).join(', ')}\nPress Ctrl+C to stop.`);
        return await new Promise(() => undefined);
      }
    }
    const bus = new EventBus();
    const needsModels = !['index', 'map', 'search'].includes(args.cmd);
    const app = await createApp({ root, config: configPath, bus, requireModels: needsModels });
    switch (args.cmd) {
      case 'probe':
        return await cmdProbe(app, args.flags);
      case 'index':
        return await cmdIndex(app, args.flags);
      case 'analyze':
        return await cmdAnalyze(app, args.flags);
      case 'run':
        return await cmdRun(app, args);
      case 'ask':
        return await cmdAsk(app, args);
      case 'status':
        return await cmdStatus(app);
      case 'map': {
        const { index } = loadOrBuildIndex(app);
        const focus = typeof args.flags.focus === 'string' ? args.flags.focus.split(',') : [];
        return out(index.repoMap(Number(args.flags.tokens ?? 2048), { identifiers: focus, files: focus }));
      }
      case 'search': {
        const { index } = loadOrBuildIndex(app);
        // hybrid (BM25 + embeddings) once vectors exist; plain BM25 otherwise – no network needed
        if (existsSync(VectorStore.pathFor(app.stateDir))) await prepareRetrieval(app, index);
        for (const h of await index.hybridSearch(args.positional.join(' '), Number(args.flags.limit ?? 10))) out(`${h.path}:${h.startLine}-${h.endLine}  (${h.score.toFixed(index.embedder ? 4 : 2)})`);
        return;
      }
      default:
        out(`Unknown command: ${args.cmd}\n`);
        out(HELP);
        process.exitCode = 1;
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(color.red(`Error: ${e.message}`) + '\n');
      process.exitCode = 1;
      return;
    }
    throw e;
  }
}
