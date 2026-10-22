import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { cpSync } from 'node:fs';
import { basename, join } from 'node:path';
import { modifiedSince, readCheckpoint, rewindCheckpoint } from '../agent/checkpoint.js';
import { ProjectAnalyzer } from '../analyze/summarizer.js';
import { runShell } from '../agent/tools.js';
import { createApp, loadOrBuildIndex, type App } from '../app.js';
import { ConfigError, kurultayHome, loadConfig, parseConfig, type KurultayConfig, type LlmConfig, type RunMode } from '../config.js';
import type { ProjectIndex } from '../index/project-index.js';
import { OpenAICompatClient } from '../llm/client.js';
import { readCapabilitiesFile, type CapabilitiesFile } from '../llm/models.js';
import { Router } from '../llm/router.js';
import { ModelStats } from '../llm/stats.js';
import { askProject, type AskTurn } from '../ops.js';
import { Orchestrator, type RunReport } from '../orchestrator/orchestrator.js';
import { probeAll, writeCapabilities } from '../probe/probe.js';
import { SkillRegistry } from '../skills/skills.js';
import { startDashboard } from '../ui/dashboard.js';
import { attachTerminal, color } from '../ui/terminal.js';
import { errorMessage } from '../util/async.js';
import { EventBus } from '../util/events.js';
import { truncateTokens } from '../util/text.js';
import { branchConversation, findConversation, listConversations, loadConversation, newConversation, relativeTime, saveConversation, type Conversation, type Turn } from './conversation.js';
import type { Completion, Suggestion } from './editor.js';
import { renderMarkdown } from './markdown.js';
import { commitWorktree, createWorktree, currentBranch, listWorktrees, mergeWorktree, realPath, removeWorktree, repoRoot, worktreeDiff, type WorktreeInfo } from './worktree.js';
import { banner, helpText, llmPanel, type EndpointHealth } from './panels.js';
import { Screen, type TermIO } from './screen.js';
import { checkWorkspace, completePath, loadState, looksLikeProject, rememberWorkspace, saveState, shortPath, type ConsoleState } from './state.js';

export interface ConsoleOptions {
  version: string;
  cwd?: string;
  /** skip the selection prompt */
  workspace?: string;
  config?: string;
  /** index / probe / analyze automatically when a workspace is opened (default true) */
  autoIndex?: boolean;
  autoProbe?: boolean;
  autoAnalyze?: boolean;
  forceInteractive?: boolean;
  /** endpoint health-check timeout (ms) */
  healthTimeoutMs?: number;
  /** resume a saved conversation: true = the latest one, string = id / list number */
  resume?: string | true;
  /** start inside a new git worktree with this name */
  worktree?: string;
}

interface Command {
  name: string;
  aliases?: string[];
  args?: string;
  description: string;
  /** needs an open workspace */
  ws?: boolean;
  /** argument suggestions */
  complete?: (arg: string) => Suggestion[];
  run: (arg: string) => Promise<void> | void;
}

const MODES: RunMode[] = ['auto', 'single', 'split', 'race', 'council'];
const MODE_HELP: Record<RunMode, string> = {
  auto: 'tek alt görevde yarış, çok alt görevde paralel dağıtım',
  single: 'tek model',
  split: 'alt görevler farklı modellerde paralel',
  race: 'aynı işi N model yarışarak yapar',
  council: 'yarış + her zaman tam konsey incelemesi',
};

/** Questions go to the council, everything else is a task. Explicit /ask, /run or ? / /intent override. */
export function classifyIntent(text: string): 'ask' | 'run' {
  const t = text.trim().toLowerCase();
  if (!t) return 'ask';
  if (t.endsWith('?')) return 'ask';
  if (/^(ne|neden|niçin|nasıl|nerede|nereden|hangi|kim|kaç|niye|açıkla|anlat|özetle|göster|listele|what|why|how|where|which|who|explain|describe|summari[sz]e|is|are|does|can)\b/.test(t)) return 'ask';
  if (/\b(nedir|ne işe yarar|ne yapar|nasıl çalışır|ne demek|mi|mı|mu|mü)\s*$/.test(t)) return 'ask';
  return 'run';
}

/** `@path` mentions → plain paths + the list of mentioned files that exist. */
export function expandMentions(text: string, exists: (p: string) => boolean): { text: string; files: string[] } {
  const files: string[] = [];
  const out = text.replace(/(^|\s)@([\w./\\-]+)/g, (m, pre: string, p: string) => {
    const clean = p.replace(/[.,;:]+$/, '');
    if (!exists(clean)) return m;
    if (!files.includes(clean)) files.push(clean);
    return `${pre}${clean}${p.slice(clean.length)}`;
  });
  return { text: out, files };
}

/**
 * Interactive Kurultay console (omp / Qwen Code style): LLM panel on start,
 * mandatory workspace selection with automatic indexing/analysis, then a
 * prompt that answers questions and carries out tasks with every model.
 */
export class KurultayConsole {
  private readonly screen: Screen;
  private readonly cwd: string;
  private readonly bus = new EventBus();
  private readonly state: ConsoleState;
  private config: KurultayConfig | undefined;
  private configPath: string | undefined;
  private app: App | undefined;
  private index: ProjectIndex | undefined;
  private router: Router | undefined;
  private probed = false;
  private health: EndpointHealth[] | undefined;
  private detachLog: (() => void) | undefined;
  private dashboard: Server | undefined;
  private askHistory: AskTurn[] = [];
  private lastReport: RunReport | undefined;
  /** the conversation being recorded (saved after every turn) */
  private conversation: Conversation | undefined;
  /** main repository root while working inside a worktree */
  private mainRoot: string | undefined;
  private mainConfig: string | undefined;
  private activeRequests = 0;
  private exitRequested = false;
  private readonly commands: Command[];
  readonly settings = {
    mode: undefined as RunMode | undefined,
    intent: 'auto' as 'auto' | 'ask' | 'run',
    dryRun: false,
    autoApply: false,
    verbose: false,
    skills: [] as string[],
  };

  constructor(
    io: TermIO,
    private readonly opts: ConsoleOptions,
  ) {
    this.cwd = opts.cwd ?? process.cwd();
    this.state = loadState();
    this.screen = new Screen(io, { history: this.state.history, forceInteractive: opts.forceInteractive });
    this.screen.onExitRequest = () => {
      this.exitRequested = true;
    };
    this.commands = this.buildCommands();
    // in-flight LLM requests for the activity line
    this.bus.on('event', (e: { type: string }) => {
      if (e.type === 'llm.request') this.activeRequests++;
      else if (e.type === 'llm.response' || e.type === 'llm.error') this.activeRequests = Math.max(0, this.activeRequests - 1);
    });
  }

  /** Markdown → terminal text (colours only on a real terminal). */
  private md(text: string): string {
    return renderMarkdown(text, { width: Math.min(this.screen.columns - 2, 120), ansi: this.screen.interactive && !process.env.NO_COLOR });
  }

  /** Where conversations live: the main repository even while inside a worktree. */
  private get convStateDir(): string {
    const root = this.mainRoot ?? this.app!.root;
    return join(root, this.app!.config.stateDir);
  }

  private snapshotSettings(): Conversation['settings'] {
    const s = this.settings;
    return { mode: s.mode, intent: s.intent, dryRun: s.dryRun, autoApply: s.autoApply, skills: [...s.skills] };
  }

  private recordTurn(t: Omit<Turn, 'n' | 'at'>): void {
    if (!this.app) return;
    this.conversation ??= newConversation(this.mainRoot ?? this.app.root, this.snapshotSettings());
    const c = this.conversation;
    c.turns.push({ ...t, n: (c.turns[c.turns.length - 1]?.n ?? 0) + 1, at: new Date().toISOString() });
    c.settings = this.snapshotSettings();
    try {
      saveConversation(this.convStateDir, c);
    } catch (e) {
      this.out(color.yellow(`konuşma kaydedilemedi: ${errorMessage(e)}`));
    }
  }

  private footer(): string {
    const parts: string[] = [];
    const br = this.workspace ? currentBranch(this.workspace) : undefined;
    if (br) parts.push(`⎇ ${br}${this.mainRoot ? ' (worktree)' : ''}`);
    parts.push(`mod ${this.settings.mode ?? this.config?.orchestrator.defaultMode ?? 'auto'}`);
    if (this.router) {
      const st = this.router.stats();
      const ready = st.filter((x) => !x.circuitOpen).length;
      parts.push(`${ready}/${st.length} model hazır`);
    }
    if (this.settings.dryRun) parts.push('dry-run');
    if (this.settings.skills.length) parts.push(`skill: ${this.settings.skills.join(',')}`);
    const c = this.conversation;
    parts.push(c?.turns.length ? `oturum: ${(c.title || c.id).slice(0, 30)} (${c.turns.length} tur)` : 'yeni oturum');
    // the path goes last: the most useful facts survive when the line is cut to the terminal width
    if (this.workspace) parts.push(shortPath(this.workspace));
    return parts.join(' · ');
  }

  private makeApp(root: string): Promise<App> {
    return createApp({ root, config: this.opts.config ?? (this.mainRoot ? this.mainConfig : undefined), bus: this.bus, requireModels: true, discoverTimeoutMs: this.opts.healthTimeoutMs ?? 8000 });
  }

  private out(s = ''): void {
    this.screen.print(s);
  }

  private get workspace(): string | undefined {
    return this.app?.root;
  }

  // ------------------------------------------------------------------ lifecycle

  async run(): Promise<number> {
    try {
      this.out(banner(this.opts.version, this.screen.columns));
      this.out('');
      if (!(await this.loadLlmConfig())) return 1;
      await this.refreshModels();
      this.out(llmPanel({ config: this.config!, configPath: this.configPath, router: this.router!, probed: this.probed, health: this.health, width: this.screen.columns }));
      this.out('');
      if (!(await this.selectWorkspace())) return 0;
      if (this.opts.resume) await this.resume(this.opts.resume === true ? '1' : this.opts.resume);
      if (this.opts.worktree) await this.worktreeCommand(`new ${this.opts.worktree}`);
      this.out(color.dim(`Soru sorun veya yapılacak işi yazın. Komutlar için ${color.cyan('/')} yazın.`));
      await this.loop();
      return 0;
    } catch (e) {
      this.out(color.red(`Hata: ${errorMessage(e)}`));
      return 1;
    } finally {
      this.shutdown();
    }
  }

  private shutdown(): void {
    this.detachLog?.();
    this.dashboard?.close();
    this.state.history = this.screen.history;
    saveState(this.state);
    this.screen.close();
  }

  private async loop(): Promise<void> {
    while (!this.exitRequested) {
      const name = basename(this.workspace ?? '') || 'kurultay';
      const flags = [this.settings.mode ?? '', this.settings.dryRun ? 'dry-run' : ''].filter(Boolean).join(' ');
      const line = await this.screen.readLine(`${color.cyan(name)}${flags ? color.dim(` [${flags}]`) : ''} ${color.bold('❯')} `, (t, c) => this.complete(t, c), () => this.footer());
      if (line === null) break;
      await this.handle(line);
      this.state.history = this.screen.history;
      saveState(this.state);
    }
  }

  /** Execute one line of input (exposed for tests and scripting). */
  async handle(input: string): Promise<void> {
    const line = input.trim();
    if (!line) return;
    if (line.startsWith('/')) {
      const [head, ...rest] = line.slice(1).split(/\s+/);
      const cmd = this.findCommand(head);
      if (!cmd && /[\\/]/.test(line.slice(1)) && existsSync(line)) {
        this.out(color.yellow(`Bu bir klasör yolu. Çalışma alanını değiştirmek için: /workspace ${line}`));
        return;
      }
      if (!cmd) {
        const near = this.commands.filter((c) => c.name.startsWith(head.slice(0, 2))).map((c) => `/${c.name}`);
        this.out(color.yellow(`Bilinmeyen komut: /${head}.${near.length ? ` Bunu mu demek istediniz: ${near.join(', ')}?` : ''} Tüm komutlar için /help.`));
        return;
      }
      if (cmd.ws && !this.app) {
        this.out(color.yellow('Önce bir çalışma alanı seçin: /workspace <klasör>'));
        return;
      }
      await cmd.run(line.slice(1 + head.length).trim());
      return;
    }
    if (line.startsWith('!')) return this.shell(line.slice(1).trim());
    if (!this.app) {
      this.out(color.yellow('Önce bir çalışma alanı seçin: /workspace <klasör>'));
      return;
    }
    if (line.startsWith('?')) return this.ask(line.slice(1).trim());
    const intent = this.settings.intent === 'auto' ? classifyIntent(line) : this.settings.intent;
    this.out(color.dim(intent === 'ask' ? '→ soru: modeller konsey olarak cevaplayacak (görev olarak çalıştırmak için /run)' : '→ görev: planlanıp modellere dağıtılacak (yalnızca sormak için /ask)'));
    if (intent === 'ask') await this.ask(line);
    else await this.runTask(line);
  }

  private findCommand(name: string): Command | undefined {
    const n = name.toLowerCase();
    return this.commands.find((c) => c.name === n || c.aliases?.includes(n));
  }

  // ------------------------------------------------------------------ LLM config & models

  private async loadLlmConfig(): Promise<boolean> {
    try {
      const r = loadConfig(this.opts.workspace ?? this.cwd, this.opts.config);
      this.config = r.config;
      this.configPath = r.path;
      return true;
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      this.out(color.yellow('LLM yapılandırması bulunamadı.'));
      return this.setupWizard();
    }
  }

  /** First run: ask for one OpenAI-compatible endpoint and save it to ~/.kurultay/config.json. */
  private async setupWizard(): Promise<boolean> {
    const path = join(kurultayHome(), 'config.json');
    this.out(`İlk kurulum: bir OpenAI-uyumlu endpoint girin (vLLM, llama.cpp, Ollama, LM Studio…). Kaydedileceği yer: ${shortPath(path)}`);
    for (;;) {
      const url = await this.screen.readLine('Endpoint adresi (ör. http://10.0.0.5:8000/v1) ❯ ');
      if (url === null || url.trim() === '/exit') return false;
      if (!url.trim()) continue;
      const name = (await this.screen.readLine('Kısa ad [gpu1] ❯ '))?.trim() || 'gpu1';
      const apiKey = (await this.screen.readLine('API anahtarı (boş = yok) ❯ '))?.trim() || 'none';
      const raw = { endpoints: [{ name, baseUrl: url.trim(), apiKey }], language: 'tr' };
      try {
        this.config = parseConfig(raw);
      } catch (e) {
        this.out(color.red(errorMessage(e)));
        continue;
      }
      mkdirSync(kurultayHome(), { recursive: true });
      writeFileSync(path, JSON.stringify(raw, null, 2));
      this.configPath = path;
      this.out(`${color.green('✓')} kaydedildi: ${shortPath(path)} — başka endpoint eklemek için /endpoint add <ad> <url> [anahtar]`);
      return true;
    }
  }

  /** Health-check endpoints and build a router from cached capabilities or discovery. */
  private async refreshModels(): Promise<void> {
    const cfg = this.config!;
    const timeout = this.opts.healthTimeoutMs ?? 5000;
    this.health = await Promise.all(
      cfg.endpoints
        .filter((e) => !e.disabled)
        .map(async (ep): Promise<EndpointHealth> => {
          const t0 = Date.now();
          try {
            const models = await new OpenAICompatClient(ep).listModels(AbortSignal.timeout(timeout));
            return { name: ep.name, baseUrl: ep.baseUrl, ok: true, ms: Date.now() - t0, models: models.map((m) => m.id) };
          } catch (e) {
            const msg = errorMessage(e).replace(/^bağlantı hatası \([^)]*\): /, '');
            return { name: ep.name, baseUrl: ep.baseUrl, ok: false, ms: Date.now() - t0, models: [], error: /abort|timeout/i.test(msg) ? `${timeout / 1000} sn içinde yanıt yok` : msg };
          }
        }),
    );
    if (this.app) {
      this.router = this.app.router;
      this.probed = this.app.probed;
      return;
    }
    const router = new Router(cfg, this.bus);
    router.learned = new ModelStats(join(kurultayHome(), 'model-stats.json'));
    const caps = readCapabilitiesFile(join(kurultayHome(), 'capabilities.json'));
    const live = new Set(this.health.filter((h) => h.ok).map((h) => h.name));
    const cached = (caps?.models ?? []).filter((m) => m.reachable && live.has(m.endpoint));
    if (cached.length) {
      router.register(cached);
      this.probed = true;
    } else {
      const okCfg = { ...cfg, endpoints: cfg.endpoints.filter((e) => live.has(e.name)) };
      router.register(await new Router(okCfg).discover(AbortSignal.timeout(timeout)));
      this.probed = false;
    }
    this.router = router;
  }

  // ------------------------------------------------------------------ workspace

  private async selectWorkspace(): Promise<boolean> {
    if (this.opts.workspace) {
      const c = checkWorkspace(this.opts.workspace, this.cwd);
      if (c.path) {
        await this.openWorkspace(c.path);
        return true;
      }
      this.out(color.red(c.error!));
    }
    const candidates = this.workspaceCandidates();
    this.out(color.bold('Çalışma alanı seçin') + color.dim(' (zorunlu — projenin kök klasörü)'));
    candidates.forEach((c, i) => this.out(`  ${color.cyan(String(i + 1))}) ${shortPath(c.path)}${c.note ? color.dim(`  ${c.note}`) : ''}`));
    if (!candidates.length) this.out(color.dim('  (son kullanılan yok) bir klasör yolu yazın; Tab ile tamamlanır'));
    for (;;) {
      const input = await this.screen.readLine(`${color.bold('Çalışma alanı')} ${color.dim('[numara veya yol]')} ❯ `, (t) => this.completeWorkspace(t, candidates));
      if (input === null) return false;
      const v = input.trim();
      if (!v) continue;
      if (v === '/exit' || v === '/quit' || v === '/q') return false;
      // "/models" is a command, "/home/me/proje" is a path
      const cmd = v.startsWith('/') ? this.findCommand(v.slice(1).split(/\s+/)[0]) : undefined;
      if (cmd && cmd.name !== 'workspace') {
        if (cmd.ws) this.out(color.yellow('Önce çalışma alanı seçilmeli.'));
        else await cmd.run(v.slice(1).split(/\s+/).slice(1).join(' '));
        if (this.exitRequested) return false;
        continue;
      }
      const raw = v.replace(/^\/workspace\s*/, '');
      const pick = /^\d+$/.test(raw) ? candidates[Number(raw) - 1]?.path : raw;
      if (!pick) {
        this.out(color.yellow(`Listede ${raw} numaralı seçenek yok.`));
        continue;
      }
      const c = checkWorkspace(pick, this.cwd);
      if (!c.path) {
        this.out(color.red(c.error!));
        continue;
      }
      await this.openWorkspace(c.path);
      return true;
    }
  }

  private workspaceCandidates(): Array<{ path: string; note?: string }> {
    const out: Array<{ path: string; note?: string }> = [];
    if (checkWorkspace(this.cwd, this.cwd).path && looksLikeProject(this.cwd)) out.push({ path: this.cwd, note: 'şu anki klasör' });
    for (const r of this.state.recent) {
      if (out.some((o) => o.path === r.path) || !existsSync(r.path)) continue;
      out.push({ path: r.path, note: `son kullanım ${r.lastUsed.slice(0, 10)}` });
    }
    return out.slice(0, 9);
  }

  private completeWorkspace(text: string, candidates: Array<{ path: string; note?: string }>): Completion | undefined {
    const t = text.replace(/^\/workspace\s*/, '');
    const offset = text.length - t.length;
    if (!t || /^\d+$/.test(t)) {
      const items = candidates.map((c, i) => ({ value: c.path, label: `${i + 1}) ${shortPath(c.path)}`, description: c.note })).filter((_, i) => !t || String(i + 1).startsWith(t));
      return items.length ? { items, from: offset, to: Array.from(text).length, submitOnEnter: true, autoAccept: true } : undefined;
    }
    const items = completePath(t, this.cwd);
    return items.length ? { items, from: offset, to: Array.from(text).length } : undefined;
  }

  /** Open a workspace: load its config, index it, and (optionally) probe and analyze automatically. */
  async openWorkspace(path: string, o: { keepConversation?: boolean } = {}): Promise<void> {
    this.detachLog?.();
    this.out(`${color.bold('Çalışma alanı')}: ${shortPath(path)}`);
    if (!o.keepConversation) {
      this.mainRoot = undefined;
      rememberWorkspace(this.state, path);
      saveState(this.state);
    }
    this.app = await this.makeApp(path);
    this.config = this.app.config;
    if (this.app.configPath !== this.configPath) this.out(color.dim(`  yapılandırma: ${shortPath(this.app.configPath)}`));
    this.configPath = this.app.configPath;
    this.router = this.app.router;
    this.probed = this.app.probed;
    this.detachLog = attachTerminal(this.bus, { verbose: this.settings.verbose, write: (l) => this.out(l) });
    if (!o.keepConversation) {
      this.askHistory = [];
      this.conversation = undefined;
      const prev = listConversations(join(path, this.app.config.stateDir))[0];
      if (prev && !this.opts.resume) this.out(color.dim(`  son oturum: "${prev.title}" (${prev.turns.length} tur, ${relativeTime(prev.updatedAt)}) — devam etmek için /resume`));
    }

    if (this.opts.autoIndex !== false) this.reindex();
    if (this.opts.autoProbe !== false && !this.probed && this.app.router.size > 0) {
      this.out(color.dim('  yetenek profili yok → hızlı yetenek analizi (Ctrl+C ile atlanır; ayrıntılı ölçüm için /probe --deep)'));
      await this.probe({ quick: true });
    }
    if (this.opts.autoAnalyze !== false && this.app.router.size > 0 && this.index) {
      const pending = this.index.needsSummary().length;
      const hasArch = existsSync(join(this.app.stateDir, 'ARCHITECTURE.md'));
      if (pending > 0 || !hasArch) {
        this.out(color.dim(`  mimari analiz: ${pending} dosya özetlenecek (Ctrl+C ile atlanır, sonra /analyze)`));
        await this.analyze(false);
      } else this.out(`  ${color.green('✓')} mimari analiz güncel (${shortPath(join(this.app.stateDir, 'ARCHITECTURE.md'))})`);
    }
    if (!this.app.router.size) this.out(color.yellow('  Kullanılabilir model yok: /models ile durumu görün, /endpoint ile ekleyin.'));
    const skills = SkillRegistry.discover(path, { extraPaths: this.app.config.skills.paths, disabled: this.app.config.skills.disabled, includeUser: this.app.config.skills.includeUser });
    if (skills.size) this.out(color.dim(`  ${skills.size} skill: ${skills.visible().map((s) => s.name).slice(0, 8).join(', ')}${skills.size > 8 ? '…' : ''}`));
  }

  private reindex(quiet = false): void {
    const { index, stats } = loadOrBuildIndex(this.app!);
    this.index = index;
    const s = index.stats();
    if (!quiet || (stats && stats.added + stats.changed + stats.removed > 0)) {
      this.out(`  ${color.green('✓')} indeks: ${s.files} dosya, ${s.defs} tanım, ${s.edges} bağımlılık${stats && (stats.changed || stats.added || stats.removed) ? color.dim(` (+${stats.added} ~${stats.changed} -${stats.removed})`) : ''}${Object.keys(s.langs).length ? color.dim(` · ${Object.entries(s.langs).map(([l, n]) => `${l}:${n}`).join(' ')}`) : ''}`);
    }
  }

  // ------------------------------------------------------------------ long operations

  private async withAbort<T>(label: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    const ctrl = new AbortController();
    const stop = () => {
      if (ctrl.signal.aborted) return;
      this.out(color.yellow(`${label} durduruluyor… (yarım kalan değişiklikler geri alınır)`));
      ctrl.abort(new Error('kullanıcı iptal etti'));
    };
    const release = this.screen.busy(stop);
    const endActivity = this.screen.activity(label, () => (this.activeRequests ? `${this.activeRequests} LLM isteği sürüyor` : ''));
    // in line mode (no raw terminal) Ctrl+C arrives as SIGINT
    if (!this.screen.interactive) process.once('SIGINT', stop);
    try {
      return await fn(ctrl.signal);
    } catch (e) {
      if (ctrl.signal.aborted) {
        this.out(color.yellow(`${label} iptal edildi.`));
        return undefined;
      }
      this.out(color.red(`${label} başarısız: ${errorMessage(e)}`));
      return undefined;
    } finally {
      endActivity();
      release();
      process.off('SIGINT', stop);
    }
  }

  private async probe(o: { quick?: boolean; deep?: boolean }): Promise<void> {
    const cfg = this.config!;
    const file = await this.withAbort('Yetenek analizi', (signal) => probeAll(cfg, this.bus, { quick: o.quick, deep: o.deep, signal }));
    if (!file) return;
    if (this.app) writeCapabilities(this.app.stateDir, file);
    saveGlobalCapabilities(file);
    const ok = file.models.filter((m) => m.reachable);
    this.out(`  ${color.green('✓')} yetenek analizi: ${ok.length}/${file.models.length} model erişilebilir`);
    if (this.app) {
      this.app = await this.makeApp(this.app.root);
      this.router = this.app.router;
      this.probed = this.app.probed;
    } else {
      const r = new Router(cfg, this.bus);
      r.register(ok);
      this.router = r;
      this.probed = true;
    }
  }

  private async analyze(force: boolean): Promise<void> {
    const app = this.app!;
    if (!app.router.size) return this.out(color.yellow('Model yok; analiz yapılamaz.'));
    this.reindex(true);
    const r = await this.withAbort('Analiz', (signal) => new ProjectAnalyzer(this.index!, app.router, app.config, this.bus).run({ force, signal }));
    if (!r) return;
    this.out(`  ${color.green('✓')} ${r.filesSummarized} dosya özetlendi · ${r.modules} modül · ${r.flowPaths.length} akış dokümanı${r.failures ? color.yellow(` · ${r.failures} hata`) : ''}`);
    this.out(color.dim(`    ${shortPath(r.architecturePath)}${r.notesPath ? ` · ${shortPath(r.notesPath)}` : ''}`));
  }

  private async ask(question: string): Promise<void> {
    if (!question) return this.out(color.yellow('Soru yazın: /ask <soru>'));
    const app = this.app!;
    if (!app.router.size) return this.out(color.yellow('Model yok.'));
    const m = expandMentions(question, (p) => this.index?.files.some((f) => f.path === p) ?? false);
    const extra = m.files.length
      ? `\n\n# MENTIONED FILES\n${m.files.map((f) => `## ${f}\n${truncateTokens(readFileSync(join(app.root, f), 'utf8'), 2500)}`).join('\n\n')}`
      : '';
    const r = await this.withAbort('Soru', (signal) => askProject(app, this.index!, m.text + extra, { history: this.askHistory, signal }));
    if (!r) return;
    this.askHistory.push({ question: m.text, answer: r.answer });
    this.recordTurn({ kind: 'ask', input: question, output: r.answer, models: r.members });
    this.out('');
    this.out(this.md(r.answer.trim()));
    this.out(color.dim(`\n— konsey: ${r.members.join(', ')}${r.chair ? ` · başkan: ${r.chair}` : ''}`));
  }

  private async runTask(task: string): Promise<void> {
    if (!task) return this.out(color.yellow('Görev yazın: /run <görev>'));
    const app = this.app!;
    if (!app.router.size) return this.out(color.yellow('Model yok.'));
    this.reindex(true);
    const m = expandMentions(task, (p) => this.index?.files.some((f) => f.path === p) ?? false);
    const text = m.files.length ? `${m.text}\n\nFiles explicitly referenced by the user: ${m.files.join(', ')}` : m.text;
    app.config.orchestrator.confirmMerge = !this.settings.autoApply && !this.settings.dryRun;
    const orch = new Orchestrator(app.root, app.config, app.router, app.materializer, this.index!, this.bus);
    const report = await this.withAbort('Görev', (signal) =>
      orch.run(text, {
        mode: this.settings.mode,
        skills: this.settings.skills.length ? this.settings.skills : undefined,
        dryRun: this.settings.dryRun,
        confirm: (q) => this.screen.confirm(q),
        signal,
      }),
    );
    if (!report) return;
    this.lastReport = report;
    const st = report.status === 'completed' ? color.green(report.status) : color.yellow(report.status);
    this.out('');
    this.out(`${color.bold('Sonuç')}: ${st} · ${report.changedFiles.length} dosya · ${report.iterations} iterasyon · modeller: ${report.modelsUsed.join(', ')}`);
    for (const f of report.changedFiles.slice(0, 20)) this.out(`  ${f}`);
    if (report.changedFiles.length > 20) this.out(color.dim(`  … ${report.changedFiles.length - 20} dosya daha`));
    if (report.merge?.conflicts.length) this.out(color.yellow(`Çakışmalar: ${report.merge.conflicts.join(', ')}`));
    this.out(color.dim(`Rapor: ${shortPath(report.reportPath)} (/report) · Diff: /diff${report.checkpointPath ? ' · Geri almak için: /rewind' : ''}`));
    this.recordTurn({
      kind: 'run',
      input: task,
      output: `${report.status} · ${report.changedFiles.length} dosya · ${report.iterations} iterasyon`,
      models: report.modelsUsed,
      run: { sessionId: report.sessionId, sessionDir: report.sessionDir, status: report.status, changedFiles: report.changedFiles, checkpointPath: report.checkpointPath },
    });
    this.reindex(true);
  }

  // ------------------------------------------------------------------ sessions: resume / branch / rewind / worktree

  private conversationList(): Conversation[] {
    return this.app ? listConversations(this.convStateDir) : [];
  }

  private printConversations(): void {
    const list = this.conversationList();
    if (!list.length) return this.out(color.dim('Kayıtlı oturum yok. Soru sorun veya görev verin; her tur otomatik kaydedilir.'));
    list.slice(0, 15).forEach((c, i) => {
      const cur = c.id === this.conversation?.id ? color.green('●') : ' ';
      const parent = c.parent ? color.dim(` ⑂ ${c.parent.id.slice(0, 19)} #${c.parent.turn}`) : '';
      this.out(`${cur} ${color.cyan(String(i + 1).padStart(2))}) ${c.title || '(başlıksız)'}  ${color.dim(`${c.turns.length} tur · ${relativeTime(c.updatedAt)} · ${c.id}`)}${parent}`);
    });
    this.out(color.dim('Devam etmek için /resume <numara>, dallandırmak için /branch'));
  }

  private applyConversation(c: Conversation): void {
    this.conversation = c;
    const s = c.settings;
    this.settings.mode = s.mode;
    this.settings.intent = s.intent;
    this.settings.dryRun = s.dryRun;
    this.settings.autoApply = s.autoApply;
    this.settings.skills = [...s.skills];
    this.askHistory = c.turns.filter((t) => t.kind === 'ask').map((t) => ({ question: t.input, answer: t.output }));
  }

  /** Continue a saved conversation: settings, question history and a short recap. */
  async resume(ref: string): Promise<void> {
    const list = this.conversationList();
    if (!list.length) return this.out(color.dim('Devam edilecek kayıtlı oturum yok.'));
    const c = findConversation(list, ref);
    if (!c) return this.out(color.yellow(`Oturum bulunamadı: ${ref}. Liste için /sessions`));
    this.applyConversation(c);
    this.out(`${color.green('✓')} oturuma devam: ${color.bold(c.title || c.id)} ${color.dim(`(${c.turns.length} tur, ${relativeTime(c.updatedAt)})`)}`);
    for (const t of c.turns.slice(-3)) {
      this.out(color.dim(`  #${t.n} ${t.kind === 'ask' ? 'soru' : 'görev'}: `) + t.input.split('\n')[0].slice(0, 100));
      this.out(color.dim(`     → ${t.output.replace(/\s+/g, ' ').slice(0, 160)}`));
    }
  }

  private branch(title: string): void {
    const c = this.conversation;
    if (!c?.turns.length) return this.out(color.yellow('Dallandırılacak bir konuşma yok (henüz tur yok).'));
    saveConversation(this.convStateDir, c);
    const b = branchConversation(c, c.turns.length, title);
    saveConversation(this.convStateDir, b);
    this.applyConversation(b);
    this.out(`${color.green('✓')} dal oluşturuldu: ${color.bold(b.title)} ${color.dim(b.id)}`);
    this.out(color.dim(`  ana konuşmaya dönmek için: /resume ${c.id}  (kod dallanmaz; ayrı kod için /worktree new <ad>)`));
  }

  private history(): void {
    const c = this.conversation;
    if (!c?.turns.length) return this.out(color.dim('Bu oturumda henüz tur yok.'));
    for (const t of c.turns) {
      const applied = t.run?.checkpointPath ? (readCheckpoint(t.run.checkpointPath)?.rewoundAt ? color.dim(' [geri alındı]') : color.yellow(` [${t.run.changedFiles.length} dosya uygulandı]`)) : '';
      this.out(`  ${color.cyan(`#${t.n}`)} ${t.kind === 'ask' ? 'soru ' : 'görev'} ${t.input.split('\n')[0].slice(0, 90)}${applied}`);
    }
  }

  /**
   * Rewind to just before turn `n`: undo every change applied by that turn and
   * the later ones (newest first), and drop those turns from the conversation.
   */
  async rewind(arg: string): Promise<void> {
    const c = this.conversation;
    if (!c?.turns.length) return this.out(color.dim('Geri alınacak tur yok.'));
    let ref = arg.trim();
    if (!ref) {
      this.history();
      const a = await this.screen.readLine(`Hangi turun öncesine dönülsün? [1-${c.turns[c.turns.length - 1].n}, boş = vazgeç] ❯ `);
      ref = (a ?? '').trim();
      if (!ref) return this.out(color.dim('Vazgeçildi.'));
    }
    const n = Number(ref.replace(/^#/, ''));
    if (!Number.isInteger(n) || !c.turns.some((t) => t.n === n)) return this.out(color.yellow(`Geçersiz tur: ${ref}`));
    const undo = c.turns.filter((t) => t.n >= n && t.run?.checkpointPath && existsSync(t.run.checkpointPath) && !readCheckpoint(t.run.checkpointPath)?.rewoundAt).reverse();
    const root = this.app!.root;
    if (undo.length) {
      const files = [...new Set(undo.flatMap((t) => Object.keys(readCheckpoint(t.run!.checkpointPath!)?.files ?? {})))];
      this.out(`${undo.length} görevin uyguladığı ${files.length} dosya eski hâline dönecek: ${files.slice(0, 12).join(', ')}${files.length > 12 ? ' …' : ''}`);
      // only the newest checkpoint of each file is compared with the disk: older ones were changed by later turns on purpose
      const seen = new Set<string>();
      const touched: string[] = [];
      for (const t of undo) {
        const cp = readCheckpoint(t.run!.checkpointPath!)!;
        for (const f of modifiedSince(root, cp)) if (!seen.has(f)) touched.push(f);
        for (const f of Object.keys(cp.files)) seen.add(f);
      }
      if (touched.length) this.out(color.yellow(`Uyarı: şu dosyalar uygulamadan sonra değişmiş, sizin değişiklikleriniz kaybolabilir: ${touched.join(', ')}`));
      if (!(await this.screen.confirm('Geri alınsın mı?'))) return this.out(color.dim('Vazgeçildi.'));
      for (const t of undo) {
        const r = rewindCheckpoint(root, t.run!.checkpointPath!, { force: true });
        this.out(`  ${color.green('↶')} #${t.n}: ${r.restored.length} dosya geri yüklendi`);
      }
    }
    const dropped = c.turns.filter((t) => t.n >= n).length;
    c.turns = c.turns.filter((t) => t.n < n);
    saveConversation(this.convStateDir, c);
    this.applyConversation(c);
    this.out(`${color.green('✓')} #${n} öncesine dönüldü (${dropped} tur konuşmadan çıkarıldı${undo.length ? ', kod geri alındı' : ''}).`);
    this.reindex(true);
  }

  private currentWorktrees(): WorktreeInfo[] {
    const root = this.mainRoot ?? this.app!.root;
    return listWorktrees(root);
  }

  /** /worktree new|list|exit|diff|merge|remove */
  async worktreeCommand(arg: string): Promise<void> {
    const [sub = 'list', ...rest] = arg.trim().split(/\s+/).filter(Boolean);
    const name = rest.join(' ');
    const main = this.mainRoot ?? this.app!.root;
    if (!repoRoot(main)) return this.out(color.yellow('Bu çalışma alanı bir git deposu değil; worktree kullanılamaz.'));
    const find = (n: string): WorktreeInfo | undefined => {
      const all = this.currentWorktrees();
      if (!n && this.mainRoot) return all.find((w) => w.path === realPath(this.app!.root));
      return all.find((w) => w.slug === n || w.branch === n);
    };
    try {
      switch (sub) {
        case 'new':
        case 'add': {
          if (!name) return this.out(color.yellow('Kullanım: /worktree new <ad>'));
          const wt = createWorktree(main, name);
          // reuse the main workspace's index, analysis and capability profile instead of recomputing
          const src = join(main, this.app!.config.stateDir);
          const dst = join(wt.path, this.app!.config.stateDir);
          for (const item of ['index', 'ARCHITECTURE.md', 'INDEX.md', 'modules', 'flows', 'PROJECT_NOTES.md', 'capabilities.json', 'CAPABILITIES.md', 'rules', 'skills', 'review_rules.md']) {
            if (existsSync(join(src, item))) cpSync(join(src, item), join(dst, item), { recursive: true });
          }
          this.mainConfig = existsSync(join(main, 'kurultay.config.json')) ? join(main, 'kurultay.config.json') : this.mainConfig;
          this.mainRoot = main;
          this.out(`${color.green('✓')} worktree: ${shortPath(wt.path)} (dal ${wt.branch})`);
          await this.openWorkspace(wt.path, { keepConversation: true });
          this.out(color.dim('  bitince: /worktree diff · /worktree merge · /worktree exit'));
          return;
        }
        case 'list': {
          const all = this.currentWorktrees();
          this.out(`${color.bold('Ana depo')}: ${shortPath(main)} ${color.dim(`(⎇ ${currentBranch(main) ?? '?'})`)}${this.mainRoot ? '' : color.green('  ● şu an burada')}`);
          if (!all.length) return this.out(color.dim('  worktree yok — /worktree new <ad>'));
          for (const w of all) this.out(`  ${w.path === realPath(this.app!.root) ? color.green('●') : ' '} ${color.cyan(w.slug)}  ${color.dim(`${w.branch}${w.dirty ? ' · kaydedilmemiş değişiklik var' : ''}`)}`);
          return;
        }
        case 'exit': {
          if (!this.mainRoot) return this.out(color.dim('Zaten ana depodasınız.'));
          const back = this.mainRoot;
          this.mainRoot = undefined;
          await this.openWorkspace(back, { keepConversation: true });
          this.out(color.dim('  worktree korunuyor: /worktree list'));
          return;
        }
        case 'diff': {
          const wt = find(name);
          if (!wt) return this.out(color.yellow(name ? `Worktree yok: ${name}` : 'Hangi worktree? /worktree diff <ad>'));
          const d = worktreeDiff(main, wt);
          this.out(d.trim() ? this.md('```diff\n' + d + '\n```') : color.dim('(fark yok)'));
          return;
        }
        case 'merge': {
          const wt = find(name);
          if (!wt) return this.out(color.yellow(name ? `Worktree yok: ${name}` : 'Hangi worktree? /worktree merge <ad>'));
          if (!(await this.screen.confirm(`${wt.branch} dalı ${shortPath(main)} içindeki ${currentBranch(main) ?? 'mevcut'} dalına birleştirilsin mi?`))) return this.out(color.dim('Vazgeçildi.'));
          const r = mergeWorktree(main, wt);
          if (!r.ok) return this.out(color.red(`Birleştirme başarısız (geri alındı):\n${r.output}`));
          this.out(`${color.green('✓')} ${wt.branch} birleştirildi.`);
          if (this.mainRoot) {
            this.mainRoot = undefined;
            await this.openWorkspace(main, { keepConversation: true });
          } else this.reindex(true);
          return;
        }
        case 'commit': {
          const wt = find(name);
          if (!wt) return this.out(color.yellow('Hangi worktree?'));
          this.out(commitWorktree(wt, `kurultay: ${wt.slug}`) ? `${color.green('✓')} kaydedildi (${wt.branch})` : color.dim('Kaydedilecek değişiklik yok.'));
          return;
        }
        case 'remove':
        case 'rm': {
          const wt = find(name);
          if (!wt) return this.out(color.yellow(name ? `Worktree yok: ${name}` : 'Kullanım: /worktree remove <ad>'));
          if (!(await this.screen.confirm(`${wt.slug} worktree'si ve ${wt.branch} dalı silinsin mi?${wt.dirty ? ' (kaydedilmemiş değişiklikler kaybolur)' : ''}`))) return this.out(color.dim('Vazgeçildi.'));
          if (this.mainRoot && wt.path === realPath(this.app!.root)) {
            this.mainRoot = undefined;
            await this.openWorkspace(main, { keepConversation: true });
          }
          removeWorktree(main, wt);
          this.out(`${color.green('✓')} ${wt.slug} silindi.`);
          return;
        }
        default:
          this.out(color.yellow('Kullanım: /worktree new <ad> | list | diff [ad] | merge [ad] | commit [ad] | exit | remove <ad>'));
      }
    } catch (e) {
      this.out(color.red(errorMessage(e)));
    }
  }

  private async shell(command: string): Promise<void> {
    if (!command) return this.out(color.yellow('Komut yazın: !<komut>'));
    if (!this.app) return this.out(color.yellow('Önce bir çalışma alanı seçin.'));
    const r = await this.withAbort('Komut', (signal) => runShell(command, this.app!.root, this.app!.config.tools.commandTimeoutMs, signal));
    if (!r) return;
    if (r.output.trim()) this.out(r.output.trimEnd());
    this.out(color.dim(`(çıkış kodu ${r.code ?? '-'}${r.timedOut ? ', zaman aşımı' : ''})`));
  }

  // ------------------------------------------------------------------ completion

  complete(text: string, cursor: number): Completion | undefined {
    const chars = Array.from(text);
    const before = chars.slice(0, cursor).join('');
    // "/" command palette
    if (before.startsWith('/') && !/\s/.test(before)) {
      const q = before.slice(1).toLowerCase();
      // exact name/alias first (so "/mode" never selects "/models"), then prefix, then substring matches
      const exactCmd = q ? this.findCommand(q) : undefined;
      const items = [
        ...(exactCmd ? [exactCmd] : []),
        ...this.commands.filter((c) => c !== exactCmd && (!q || c.name.startsWith(q) || c.aliases?.some((a) => a.startsWith(q)))),
        ...(q ? this.commands.filter((c) => c !== exactCmd && !c.name.startsWith(q) && !c.aliases?.some((a) => a.startsWith(q)) && c.name.includes(q)) : []),
      ]
        .map((c) => ({ value: `/${c.name}${c.args ? ' ' : ''}`, label: `/${c.name}${c.args ? ' ' + c.args : ''}`, description: c.description + (c.ws && !this.app ? ' (çalışma alanı gerekir)' : ''), submit: !c.args }));
      if (!items.length) return undefined;
      // Enter runs the highlighted command; commands that need an argument stop for it first
      const exact = this.findCommand(q);
      return { items, from: 0, to: cursor, autoAccept: !exact || !!exact.args };
    }
    // command arguments
    const m = before.match(/^\/(\S+)\s+(.*)$/s);
    if (m) {
      const cmd = this.findCommand(m[1]);
      if (!cmd?.complete) return undefined;
      const items = cmd.complete(m[2]);
      if (!items.length) return undefined;
      const from = Array.from(before).length - Array.from(m[2]).length;
      return { items, from, to: cursor, submitOnEnter: items.every((i) => !i.value.endsWith('/')), autoAccept: false };
    }
    // @file mentions
    const at = before.match(/(?:^|\s)@([\w./\\-]*)$/);
    if (at && this.index) {
      const q = at[1].toLowerCase();
      const files = this.index.files.map((f) => f.path);
      const items = [...files.filter((f) => f.toLowerCase().startsWith(q)), ...files.filter((f) => !f.toLowerCase().startsWith(q) && f.toLowerCase().includes(q))].slice(0, 30).map((f) => ({ value: `@${f} `, label: f }));
      if (!items.length) return undefined;
      return { items, from: cursor - Array.from(at[1]).length - 1, to: cursor };
    }
    // $skill mentions
    const sk = before.match(/(?:^|\s)\$([a-z0-9-]*)$/);
    if (sk && this.app) {
      const reg = SkillRegistry.discover(this.app.root, { includeUser: this.app.config.skills.includeUser, extraPaths: this.app.config.skills.paths });
      const items = reg
        .visible()
        .filter((s) => s.name.startsWith(sk[1]))
        .map((s) => ({ value: `$${s.name} `, label: `$${s.name}`, description: s.description }));
      if (!items.length) return undefined;
      return { items, from: cursor - Array.from(sk[1]).length - 1, to: cursor };
    }
    return undefined;
  }

  // ------------------------------------------------------------------ commands

  private onOff(arg: string, cur: boolean): boolean {
    if (/^(on|açık|aç|evet|1|true)$/i.test(arg)) return true;
    if (/^(off|kapalı|kapat|hayır|0|false)$/i.test(arg)) return false;
    return !cur;
  }

  private writeConfig(mut: (raw: Record<string, unknown>) => void): void {
    const path = this.configPath ?? join(kurultayHome(), 'config.json');
    const raw = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {};
    mut(raw);
    const parsed = parseConfig(raw); // validate before writing
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(raw, null, 2));
    this.config = parsed;
    this.configPath = path;
    this.out(`${color.green('✓')} kaydedildi: ${shortPath(path)}`);
  }

  private async reloadModels(): Promise<void> {
    if (this.app) {
      this.app = await this.makeApp(this.app.root);
      this.config = this.app.config;
      this.configPath = this.app.configPath;
    }
    await this.refreshModels();
    this.out(llmPanel({ config: this.config!, configPath: this.configPath, router: this.router!, probed: this.probed, health: this.health, width: this.screen.columns }));
  }

  private buildCommands(): Command[] {
    const sessionsDir = () => join(this.app!.stateDir, 'sessions');
    const lastSession = (): string | undefined => {
      if (this.lastReport) return this.lastReport.sessionDir;
      if (!existsSync(sessionsDir())) return undefined;
      const list = readdirSync(sessionsDir()).sort();
      return list.length ? join(sessionsDir(), list[list.length - 1]) : undefined;
    };
    const llmKeys: Array<keyof LlmConfig> = ['firstTokenTimeoutMs', 'idleTimeoutMs', 'timeoutMs', 'prefillMsPerToken', 'timeoutRetries', 'timeoutCooldownMs', 'stickyFailover'];
    const list: Command[] = [
      { name: 'help', aliases: ['h', '?'], description: 'komutları ve kısayolları göster', run: () => this.out(helpText(this.commands)) },
      {
        name: 'models',
        aliases: ['m'],
        description: 'LLM paneli: endpoint sağlığı, modeller, yetenekler, kapasite',
        run: async () => {
          await this.refreshModels();
          this.out(llmPanel({ config: this.config!, configPath: this.configPath, router: this.router!, probed: this.probed, health: this.health, width: this.screen.columns }));
        },
      },
      {
        name: 'llm',
        args: '[set <ayar> <değer>]',
        description: 'zaman aşımı / failover ayarlarını göster veya değiştir',
        complete: (a) => {
          const parts = a.split(/\s+/);
          if (parts.length <= 1) return 'set'.startsWith(parts[0]) ? [{ value: 'set ', label: 'set', description: 'bir ayarı değiştir' }] : [];
          if (parts.length === 2) return llmKeys.filter((k) => k.startsWith(parts[1])).map((k) => ({ value: `set ${k} `, label: k, description: String(this.config?.llm[k]) }));
          return [];
        },
        run: (a) => {
          const m = a.match(/^set\s+(\w+)\s+(\S+)$/);
          if (m) {
            const key = m[1] as keyof LlmConfig;
            if (!llmKeys.includes(key)) return this.out(color.yellow(`Bilinmeyen ayar: ${m[1]}. Geçerli: ${llmKeys.join(', ')}`));
            const value = key === 'stickyFailover' ? this.onOff(m[2], true) : Number(m[2]);
            try {
              this.writeConfig((raw) => {
                raw.llm = { ...((raw.llm as object) ?? {}), [key]: value };
              });
            } catch (e) {
              return this.out(color.red(errorMessage(e)));
            }
            this.out(color.dim('Yeni ayar bir sonraki istekten itibaren geçerli (çalışma alanı yeniden yüklenir).'));
            if (this.app) return this.reloadModels();
            return;
          }
          const l = this.config!.llm;
          this.out(`${color.bold('LLM ayarları')} ${color.dim(shortPath(this.configPath ?? '-'))}`);
          for (const k of llmKeys) this.out(`  ${k.padEnd(20)} ${String(l[k])}`);
          for (const e of this.config!.endpoints) {
            this.out(`  ${color.cyan(e.name.padEnd(12))} ${e.baseUrl}${e.disabled ? color.dim(' (kapalı)') : ''}${e.firstTokenTimeoutMs || e.idleTimeoutMs || e.timeoutMs ? color.dim(` · ilk token ${e.firstTokenTimeoutMs ?? '-'} · sessizlik ${e.idleTimeoutMs ?? '-'} · toplam ${e.timeoutMs ?? '-'}`) : ''}`);
          }
          this.out(color.dim('Değiştirmek için: /llm set firstTokenTimeoutMs 120000'));
        },
      },
      {
        name: 'endpoint',
        args: 'add <ad> <url> [anahtar] | remove <ad>',
        description: 'LLM endpoint ekle / çıkar',
        complete: (a) => {
          const parts = a.split(/\s+/);
          if (parts.length <= 1) return ['add', 'remove'].filter((x) => x.startsWith(parts[0])).map((x) => ({ value: `${x} `, label: x }));
          if (parts[0] === 'remove' && parts.length === 2) return (this.config?.endpoints ?? []).filter((e) => e.name.startsWith(parts[1])).map((e) => ({ value: `remove ${e.name}`, label: e.name, description: e.baseUrl }));
          return [];
        },
        run: async (a) => {
          const [sub, name, url, key] = a.split(/\s+/);
          try {
            if (sub === 'add' && name && url) {
              this.writeConfig((raw) => {
                const eps = ((raw.endpoints as Array<Record<string, unknown>>) ?? []).filter((e) => e.name !== name);
                eps.push({ name, baseUrl: url, apiKey: key ?? 'none' });
                raw.endpoints = eps;
              });
            } else if (sub === 'remove' && name) {
              if (!this.config!.endpoints.some((e) => e.name === name)) return this.out(color.yellow(`Endpoint yok: ${name}`));
              this.writeConfig((raw) => {
                raw.endpoints = ((raw.endpoints as Array<Record<string, unknown>>) ?? []).filter((e) => e.name !== name);
              });
            } else return this.out(color.yellow('Kullanım: /endpoint add <ad> <url> [anahtar]  |  /endpoint remove <ad>'));
          } catch (e) {
            return this.out(color.red(errorMessage(e)));
          }
          await this.reloadModels();
        },
      },
      {
        name: 'probe',
        args: '[--deep|--quick]',
        description: 'tüm modellerin yeteneklerini ölç (bağlam, araç, hız, kod/düzenleme puanı)',
        complete: (a) => ['--quick', '--deep'].filter((x) => x.startsWith(a)).map((x) => ({ value: x, label: x, description: x === '--deep' ? '256K bağlam, 16 paralel istek' : 'benchmark yok' })),
        run: async (a) => {
          await this.probe({ quick: a.includes('--quick'), deep: a.includes('--deep') });
          this.out(llmPanel({ config: this.config!, configPath: this.configPath, router: this.router!, probed: this.probed, health: this.health, width: this.screen.columns }));
        },
      },
      {
        name: 'workspace',
        aliases: ['ws', 'cd'],
        args: '[klasör]',
        description: 'çalışma alanını göster / değiştir',
        complete: (a) => {
          const recent = this.state.recent.filter((r) => existsSync(r.path) && r.path.startsWith(a)).map((r) => ({ value: r.path, label: shortPath(r.path), description: 'son kullanılan' }));
          return a && !recent.length ? completePath(a, this.cwd) : [...recent, ...(a ? completePath(a, this.cwd) : [])];
        },
        run: async (a) => {
          if (!a) {
            this.out(`Çalışma alanı: ${this.workspace ? shortPath(this.workspace) : '-'}`);
            const others = this.state.recent.filter((r) => r.path !== this.workspace && existsSync(r.path));
            if (others.length) this.out(color.dim(`Son kullanılanlar: ${others.slice(0, 5).map((r) => shortPath(r.path)).join(', ')}`));
            return;
          }
          const c = checkWorkspace(a, this.workspace ?? this.cwd);
          if (!c.path) return this.out(color.red(c.error!));
          await this.openWorkspace(c.path);
        },
      },
      { name: 'index', ws: true, description: 'statik indeksi güncelle (LLM gerekmez)', run: () => this.reindex() },
      { name: 'analyze', ws: true, args: '[--force]', description: 'mimari analiz: dosya özetleri, ARCHITECTURE.md, akışlar, proje notları', complete: (a) => ('--force'.startsWith(a) ? [{ value: '--force', label: '--force', description: 'tüm dosyaları yeniden özetle' }] : []), run: (a) => this.analyze(a.includes('--force')) },
      { name: 'ask', aliases: ['a'], ws: true, args: '<soru>', description: 'soru sor (konsey cevaplar, kod değişmez)', run: (a) => this.ask(a) },
      { name: 'run', aliases: ['r', 'do'], ws: true, args: '<görev>', description: 'görevi planla, modellere dağıt, doğrula, incele, uygula', run: (a) => this.runTask(a) },
      {
        name: 'mode',
        args: '[auto|single|split|race|council]',
        description: 'görev çalıştırma modu',
        complete: (a) => MODES.filter((m) => m.startsWith(a)).map((m) => ({ value: m, label: m, description: MODE_HELP[m] })),
        run: (a) => {
          if (!a) return this.out(`Mod: ${this.settings.mode ?? `${this.config?.orchestrator.defaultMode} (varsayılan)`}\n${MODES.map((m) => `  ${m.padEnd(8)} ${MODE_HELP[m]}`).join('\n')}`);
          if (!MODES.includes(a as RunMode)) return this.out(color.yellow(`Geçersiz mod: ${a}`));
          this.settings.mode = a as RunMode;
          this.out(`Mod: ${a}`);
        },
      },
      {
        name: 'intent',
        args: '[auto|ask|run]',
        description: 'düz metin soru mu iş mi sayılsın',
        complete: (a) => ['auto', 'ask', 'run'].filter((x) => x.startsWith(a)).map((x) => ({ value: x, label: x, description: x === 'auto' ? 'metinden tahmin et' : x === 'ask' ? 'hep soru' : 'hep görev' })),
        run: (a) => {
          if (a && !['auto', 'ask', 'run'].includes(a)) return this.out(color.yellow('auto, ask veya run'));
          if (a) this.settings.intent = a as 'auto' | 'ask' | 'run';
          this.out(`Girdi yorumu: ${this.settings.intent}`);
        },
      },
      {
        name: 'skills',
        ws: true,
        args: '[ad]',
        description: "skill'leri listele; ad verilirse sonraki işlerde baştan yükle/kaldır",
        complete: (a) => {
          if (!this.app) return [];
          const reg = SkillRegistry.discover(this.app.root, { includeUser: this.app.config.skills.includeUser, extraPaths: this.app.config.skills.paths });
          return reg.skills.filter((s) => s.name.startsWith(a)).map((s) => ({ value: s.name, label: s.name, description: s.description }));
        },
        run: (a) => {
          const reg = SkillRegistry.discover(this.app!.root, { includeUser: this.app!.config.skills.includeUser, extraPaths: this.app!.config.skills.paths, disabled: this.app!.config.skills.disabled });
          if (a) {
            if (!reg.get(a)) return this.out(color.yellow(`Skill bulunamadı: ${a}`));
            const name = reg.get(a)!.name;
            this.settings.skills = this.settings.skills.includes(name) ? this.settings.skills.filter((s) => s !== name) : [...this.settings.skills, name];
            return this.out(`Baştan yüklenecek skill'ler: ${this.settings.skills.join(', ') || '-'}`);
          }
          if (!reg.size) return this.out(color.dim("Skill yok. .kurultay/skills/<ad>/SKILL.md oluşturun (kurultay skills new <ad>)."));
          for (const s of reg.skills) this.out(`  ${this.settings.skills.includes(s.name) ? color.green('●') : ' '} ${color.cyan(s.name)}  ${s.description}${s.hidden ? color.dim(' (yalnızca açık seçimle)') : ''}`);
        },
      },
      { name: 'map', ws: true, args: '[odak]', description: 'repo haritası (önemli dosya ve semboller)', run: (a) => this.out(this.index!.repoMap(1200, { identifiers: a ? a.split(/[\s,]+/) : [], files: a ? a.split(/[\s,]+/) : [] })) },
      {
        name: 'search',
        aliases: ['s'],
        ws: true,
        args: '<sorgu>',
        description: 'kodda BM25 araması',
        run: (a) => {
          if (!a) return this.out(color.yellow('Kullanım: /search <sorgu>'));
          const hits = this.index!.search(a, 10);
          if (!hits.length) return this.out(color.dim('Sonuç yok.'));
          for (const h of hits) this.out(`  ${color.cyan(`${h.path}:${h.startLine}-${h.endLine}`)} ${color.dim(h.score.toFixed(2))}`);
        },
      },
      {
        name: 'status',
        description: 'çalışma alanı, indeks, modeller ve ayarlar',
        run: () => {
          this.out(`${color.bold('Çalışma alanı')}: ${this.workspace ? shortPath(this.workspace) : '-'}`);
          this.out(`${color.bold('Yapılandırma')}: ${shortPath(this.configPath ?? '-')}`);
          this.out(`${color.bold('Modeller')}: ${this.router?.size ?? 0} (${this.probed ? 'ölçülmüş' : 'keşif'}) · ${this.router?.totalCapacity() ?? 0} paralel slot`);
          if (this.index) {
            const s = this.index.stats();
            this.out(`${color.bold('İndeks')}: ${s.files} dosya, ${s.defs} tanım, özetli ${this.index.files.filter((f) => f.summary).length}`);
          }
          this.out(`${color.bold('Ayarlar')}: mod ${this.settings.mode ?? this.config?.orchestrator.defaultMode} · girdi ${this.settings.intent} · dry-run ${this.settings.dryRun ? 'açık' : 'kapalı'} · onaysız uygula ${this.settings.autoApply ? 'açık' : 'kapalı'} · skill ${this.settings.skills.join(', ') || '-'}`);
        },
      },
      {
        name: 'runs',
        ws: true,
        description: 'son görev çalıştırmaları (rapor klasörleri)',
        run: () => {
          if (!existsSync(sessionsDir())) return this.out(color.dim('Henüz oturum yok.'));
          const list = readdirSync(sessionsDir()).sort().slice(-10);
          for (const s of list) {
            let status = '';
            try {
              const j = JSON.parse(readFileSync(join(sessionsDir(), s, 'session.json'), 'utf8')) as { task?: string };
              const rep = existsSync(join(sessionsDir(), s, 'REPORT.md')) ? readFileSync(join(sessionsDir(), s, 'REPORT.md'), 'utf8') : '';
              const st = rep.match(/\*\*Durum:\*\* (\S+)/)?.[1] ?? 'yarım';
              status = `${st.padEnd(10)} ${(j.task ?? '').split('\n')[0].slice(0, 70)}`;
            } catch {
              /* older or partial session */
            }
            this.out(`  ${color.cyan(s)}  ${status}`);
          }
        },
      },
      {
        name: 'report',
        ws: true,
        description: 'son görev raporunu göster',
        run: () => {
          const dir = lastSession();
          const p = dir && join(dir, 'REPORT.md');
          if (!p || !existsSync(p)) return this.out(color.dim('Rapor yok.'));
          this.out(this.md(readFileSync(p, 'utf8')));
        },
      },
      {
        name: 'diff',
        ws: true,
        description: 'son görevin değişiklikleri',
        run: () => {
          const dir = lastSession();
          const p = dir && join(dir, 'changes.diff');
          if (!p || !existsSync(p)) return this.out(color.dim('Diff yok.'));
          const text = readFileSync(p, 'utf8');
          this.out(text.split('\n').map((l) => (l.startsWith('+') && !l.startsWith('+++') ? color.green(l) : l.startsWith('-') && !l.startsWith('---') ? color.red(l) : l.startsWith('@@') ? color.cyan(l) : l)).join('\n') || color.dim('(boş)'));
        },
      },
      { name: 'dry-run', args: '[on|off]', description: 'değişiklikleri projeye yazma, yalnızca diff üret', complete: (a) => ['on', 'off'].filter((x) => x.startsWith(a)).map((x) => ({ value: x, label: x })), run: (a) => this.out(`dry-run: ${(this.settings.dryRun = this.onOff(a, this.settings.dryRun)) ? 'açık' : 'kapalı'}`) },
      { name: 'auto-apply', args: '[on|off]', description: 'sonucu onay sormadan projeye uygula', complete: (a) => ['on', 'off'].filter((x) => x.startsWith(a)).map((x) => ({ value: x, label: x })), run: (a) => this.out(`onaysız uygula: ${(this.settings.autoApply = this.onOff(a, this.settings.autoApply)) ? 'açık' : 'kapalı'}`) },
      {
        name: 'verbose',
        args: '[on|off]',
        description: 'LLM istek/yanıt ayrıntılarını göster',
        complete: (a) => ['on', 'off'].filter((x) => x.startsWith(a)).map((x) => ({ value: x, label: x })),
        run: (a) => {
          this.settings.verbose = this.onOff(a, this.settings.verbose);
          if (this.app) {
            this.detachLog?.();
            this.detachLog = attachTerminal(this.bus, { verbose: this.settings.verbose, write: (l) => this.out(l) });
          }
          this.out(`ayrıntılı günlük: ${this.settings.verbose ? 'açık' : 'kapalı'}`);
        },
      },
      {
        name: 'ui',
        args: '[port]',
        description: 'tarayıcıda canlı pano aç (yerel, harici kaynak yok)',
        run: async (a) => {
          if (this.dashboard) return this.out('Pano zaten açık.');
          if (!this.router) return this.out(color.yellow('Model yok.'));
          try {
            const { server, url } = await startDashboard(this.bus, this.router, Number(a) || 7420);
            this.dashboard = server;
            this.out(`Pano: ${url}`);
          } catch (e) {
            this.out(color.red(`Pano açılamadı: ${errorMessage(e)}`));
          }
        },
      },
      { name: 'sessions', ws: true, description: 'kayıtlı konuşma oturumları', run: () => this.printConversations() },
      {
        name: 'resume',
        aliases: ['continue'],
        ws: true,
        args: '[numara|id]',
        description: 'kayıtlı bir oturuma devam et (soru geçmişi ve ayarlarla)',
        complete: (a) =>
          this.conversationList()
            .slice(0, 15)
            .map((c, i) => ({ value: String(i + 1), label: `${i + 1}) ${c.title || c.id}`, description: `${c.turns.length} tur · ${relativeTime(c.updatedAt)}` }))
            .filter((x) => !a || x.value.startsWith(a)),
        run: async (a) => {
          if (!a) return this.printConversations();
          await this.resume(a);
        },
      },
      { name: 'branch', aliases: ['fork'], ws: true, args: '[başlık]', description: 'konuşmayı buradan dallandır (yeni oturum, öncekisi korunur)', run: (a) => this.branch(a) },
      { name: 'history', ws: true, description: 'bu oturumun turları', run: () => this.history() },
      {
        name: 'rewind',
        aliases: ['undo'],
        ws: true,
        args: '[tur]',
        description: 'bir turun öncesine dön: uygulanan değişiklikleri ve sonraki turları geri al',
        complete: (a) => (this.conversation?.turns ?? []).map((t) => ({ value: String(t.n), label: `#${t.n}`, description: t.input.split('\n')[0].slice(0, 60) })).filter((x) => x.value.startsWith(a)).reverse(),
        run: (a) => this.rewind(a),
      },
      {
        name: 'worktree',
        aliases: ['wt'],
        ws: true,
        args: '[new <ad>|list|diff|merge|commit|exit|remove <ad>]',
        description: 'git worktree: ayrı dalda çalış, farkı gör, birleştir',
        complete: (a) => {
          const parts = a.split(/\s+/);
          const subs: Array<[string, string]> = [['new ', 'yeni worktree + dal'], ['list', 'listele'], ['diff ', 'farkı göster'], ['merge ', 'ana dala birleştir'], ['commit ', 'değişiklikleri kaydet'], ['exit', 'ana depoya dön'], ['remove ', 'sil']];
          if (parts.length <= 1) return subs.filter(([v]) => v.startsWith(parts[0])).map(([v, d]) => ({ value: v, label: v.trim(), description: d }));
          if (['diff', 'merge', 'commit', 'remove', 'rm'].includes(parts[0]) && this.app) {
            try {
              return this.currentWorktrees().filter((w) => w.slug.startsWith(parts[1])).map((w) => ({ value: `${parts[0]} ${w.slug}`, label: w.slug, description: w.branch }));
            } catch {
              return [];
            }
          }
          return [];
        },
        run: (a) => this.worktreeCommand(a),
      },
      {
        name: 'clear',
        aliases: ['new'],
        description: 'ekranı temizle ve yeni oturum başlat (önceki kayıtlı kalır)',
        run: () => {
          this.askHistory = [];
          this.conversation = undefined;
          if (this.screen.interactive) this.screen.write('\x1b[2J\x1b[H');
          this.out(color.dim('Yeni oturum başladı (öncekine /resume ile dönebilirsiniz).'));
        },
      },
      {
        name: 'exit',
        aliases: ['quit', 'q'],
        description: 'çık',
        run: () => {
          this.exitRequested = true;
        },
      },
    ];
    return list;
  }
}

/** Merge a probe result into the per-user capability cache (shared by all workspaces). */
export function saveGlobalCapabilities(file: CapabilitiesFile): void {
  try {
    const path = join(kurultayHome(), 'capabilities.json');
    const prev = readCapabilitiesFile(path);
    const endpoints = new Set(file.models.map((m) => m.endpoint));
    const models = [...(prev?.models ?? []).filter((m) => !endpoints.has(m.endpoint)), ...file.models];
    mkdirSync(kurultayHome(), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...file, models }, null, 2));
  } catch {
    /* cache only */
  }
}
