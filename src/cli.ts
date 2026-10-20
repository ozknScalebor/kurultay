import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { ProjectAnalyzer } from './analyze/summarizer.js';
import { createApp, loadOrBuildIndex, type App } from './app.js';
import { ConfigError, SAMPLE_CONFIG, loadConfig, type RunMode } from './config.js';
import { SKILL_TEMPLATE, SkillRegistry } from './skills/skills.js';
import { ProjectIndex } from './index/project-index.js';
import { DEFAULT_MOCK_MODELS, startMockServer } from './mock/server.js';
import { councilAnswer } from './orchestrator/council.js';
import { focusTerms, Orchestrator } from './orchestrator/orchestrator.js';
import { detectVerifyCommands } from './orchestrator/verify.js';
import { probeAll, renderCapabilitiesMarkdown, writeCapabilities } from './probe/probe.js';
import { startDashboard } from './ui/dashboard.js';
import { attachTerminal, color } from './ui/terminal.js';
import { EventBus } from './util/events.js';

const VERSION = JSON.parse(readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'package.json'), 'utf8')).version as string;

interface Args {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const booleans = new Set(['deep', 'quick', 'force', 'dry-run', 'yes', 'ui', 'verbose', 'help', 'version', 'json', 'v', 'h', 'y']);
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
  return { cmd: positional.shift() ?? 'help', positional, flags };
}

const HELP = `${color.bold('kurultay')} ${VERSION} — tüm yerel LLM'leri birlikte çalıştıran offline kodlama ajanı

Kullanım: kurultay <komut> [seçenekler]

Komutlar:
  init                 Proje köküne kurultay.config.json, kural/skill şablonları oluştur
  probe                Tüm endpoint ve modellerin yeteneklerini ölç (--deep, --quick)
  index                Projeyi indeksle (sembol, bağımlılık grafiği, PageRank) – LLM gerekmez
  analyze              İndeksle + tüm modellerle paralel özet: ARCHITECTURE.md, PROJECT_NOTES.md, akış dokümanları
                         (--force, --drafts N, --flows N; 0 = akış yok)
  run "<görev>"        Görevi planla, modellere dağıt, doğrula, incele ve uygula
                         --mode auto|single|split|race|council   --req <dosya>   --dry-run   --yes
                         --skill a,b (skill'leri baştan yükle; görev metninde $skill-adı da olur)
  ask "<soru>"         Proje hakkında soru: modeller ayrı cevaplar, konsey birleştirir (--members N)
  map                  Repo haritasını yazdır (--tokens N, --focus a,b)
  skills               Skill'leri listele ve doğrula; "skills new <ad> --description ..." yeni skill oluşturur
  search "<sorgu>"     İndekste BM25 arama
  status               Modeller, indeks ve son oturumlar
  mock                 Test için sahte OpenAI-uyumlu LLM sunucusu başlat (--port 9100)

Genel seçenekler:
  --root <dizin>       Proje kökü (varsayılan: bulunulan dizin)
  --config <dosya>     Yapılandırma dosyası
  --ui [--port 7420]   Canlı web panosunu aç (offline, 127.0.0.1)
  --verbose            Her LLM isteğini göster
`;

function out(s: string) {
  process.stdout.write(s + '\n');
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
    out(color.yellow(`Pano başlatılamadı: ${(e as Error).message}`));
    return detach;
  }
}

function requireModels(app: App): void {
  if (app.router.size === 0) {
    throw new ConfigError('Hiçbir model erişilebilir değil. Endpoint adreslerini kontrol edip "kurultay probe" çalıştırın.');
  }
  if (!app.probed) out(color.yellow('Not: yetenek profili yok, varsayılan değerler kullanılıyor. En iyi sonuç için önce "kurultay probe" çalıştırın.'));
}

async function cmdInit(root: string, flags: Args['flags']) {
  const cfgPath = join(root, 'kurultay.config.json');
  if (existsSync(cfgPath) && !flags.force) {
    out(`${cfgPath} zaten var (üzerine yazmak için --force).`);
  } else {
    const cfg = { ...SAMPLE_CONFIG, verify: detectVerifyCommands(root) };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    out(`${color.green('✓')} ${cfgPath} oluşturuldu – endpoint adreslerini ve API anahtarlarını düzenleyin.`);
  }
  const state = join(root, '.kurultay');
  for (const d of ['rules', 'skills']) mkdirSync(join(state, d), { recursive: true });
  const tpl = (p: string, content: string) => {
    if (!existsSync(p)) writeFileSync(p, content);
  };
  tpl(
    join(state, 'rules', 'genel.md'),
    `---\nname: genel-kurallar\ndescription: Tüm değişikliklerde uyulacak proje kuralları\n---\n# Genel kurallar\n\n- Mevcut kod stilini koru; gereksiz yeniden biçimlendirme yapma.\n- Her yeni public fonksiyon için birim testi ekle.\n- Hata kodlarını yutma; logla ve yukarı ilet.\n`,
  );
  tpl(
    join(state, 'rules', 'java.md'),
    `---\nname: java-kurallari\napplies_to: "*.java"\n---\n# Java kuralları\n\n- Alanlar mümkünse final olmalı.\n- Checked exception'ları RuntimeException'a sarmadan önce bağlam mesajı ekle.\n`,
  );
  mkdirSync(join(state, 'skills', 'yeni-surucu-ekleme', 'references'), { recursive: true });
  tpl(
    join(state, 'skills', 'yeni-surucu-ekleme', 'SKILL.md'),
    `---\nname: yeni-surucu-ekleme\ndescription: Yeni bir donanım sürücüsü (driver) eklerken izlenecek adımlar - arayüz başlığı, init/deinit/read/write, platform kaydı ve test. Görev yeni bir sürücü/driver eklemeyi içeriyorsa kullan.\nkeywords: [sürücü, driver]\n---\n# Yeni sürücü ekleme\n\n1. include/ altında arayüz başlığını oluştur (bkz. references/arayuz-kurallari.md).\n2. drivers/ altında init/deinit/read/write fonksiyonlarını uygula.\n3. Sürücüyü platform kayıt tablosuna ekle.\n4. Birim testini tests/ altına ekle ve derlemeyi doğrula.\n`,
  );
  tpl(join(state, 'skills', 'yeni-surucu-ekleme', 'references', 'arayuz-kurallari.md'), `# Arayüz kuralları\n\n- Tüm fonksiyonlar hata kodu (int) döndürür; 0 = başarı.\n- Donanım kaydı adresleri tek bir başlıkta tanımlanır.\n`);
  tpl(join(state, 'review_rules.md'), `# Review kuralları\n\n- Bellek sızıntısı, tampon taşması ve yarış durumu olmamalı.\n- Her hata yolu kaynakları serbest bırakmalı.\n- Public API değişiklikleri dokümante edilmeli.\n`);
  out(`${color.green('✓')} .kurultay/rules, .kurultay/skills ve .kurultay/review_rules.md şablonları hazır.`);
  out(`Öneri: .gitignore dosyanıza ".kurultay/" ekleyin (veya kural klasörlerini sürüm kontrolünde tutun).`);
  out(`\nSonraki adımlar:\n  kurultay probe\n  kurultay analyze\n  kurultay run "yapılacak iş"`);
}

async function cmdProbe(app: App, flags: Args['flags']) {
  const stop = await withUi(app, flags);
  try {
    out(`${color.bold('Yetenek analizi')} – ${app.config.endpoints.length} endpoint paralel inceleniyor…`);
    const file = await probeAll(app.config, app.bus, { deep: !!flags.deep, quick: !!flags.quick });
    const paths = writeCapabilities(app.stateDir, file);
    out('\n' + renderCapabilitiesMarkdown(file));
    out(`${color.green('✓')} ${paths.json}\n${color.green('✓')} ${paths.md}`);
  } finally {
    stop();
  }
}

async function cmdIndex(app: App) {
  const { index, stats } = loadOrBuildIndex(app);
  const s = index.stats();
  out(`${color.green('✓')} indeks: ${s.files} dosya, ${s.lines.toLocaleString('en')} satır, ${s.defs} tanım, ${s.edges} bağımlılık kenarı`);
  if (stats) out(color.dim(`  eklenen ${stats.added}, değişen ${stats.changed}, silinen ${stats.removed}`));
  out(color.dim(`  diller: ${Object.entries(s.langs).map(([l, n]) => `${l}:${n}`).join(' ')}`));
}

async function cmdAnalyze(app: App, flags: Args['flags']) {
  requireModels(app);
  const stop = await withUi(app, flags);
  try {
    const { index } = loadOrBuildIndex(app);
    const s = index.stats();
    out(`${color.bold('Analiz')}: ${s.files} dosya, ${app.router.size} model, toplam ${app.router.totalCapacity()} paralel slot`);
    const analyzer = new ProjectAnalyzer(index, app.router, app.config, app.bus);
    const r = await analyzer.run({
      force: !!flags.force,
      architectureDrafts: flags.drafts !== undefined ? Number(flags.drafts) : undefined,
      flows: flags.flows !== undefined ? Number(flags.flows) : undefined,
    });
    out(`\n${color.green('✓')} ${r.filesSummarized} dosya özetlendi, ${r.modules} modül, ${r.flowPaths.length} akış dokümanı, ${r.failures} hata`);
    out(`${color.green('✓')} ${r.architecturePath}`);
    if (r.notesPath) out(`${color.green('✓')} ${r.notesPath}`);
    for (const f of r.flowPaths) out(`${color.green('✓')} ${f}`);
    out(color.dim(`  model kullanımı: ${Object.entries(r.modelsUsed).map(([m, n]) => `${m}×${n}`).join(', ')}`));
  } finally {
    stop();
  }
}

async function confirmPrompt(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`${question} [e/H] `);
  rl.close();
  return /^(e|evet|y|yes)$/i.test(a.trim());
}

async function cmdRun(app: App, args: Args) {
  const task = args.positional.join(' ').trim();
  if (!task) throw new ConfigError('Görev metni gerekli: kurultay run "..."');
  requireModels(app);
  const stop = await withUi(app, args.flags);
  const ctrl = new AbortController();
  const onSig = () => {
    out(color.yellow('\nDurduruluyor… (yarım kalan değişiklikler geri alınacak)'));
    ctrl.abort(new Error('kullanıcı iptal etti'));
  };
  process.once('SIGINT', onSig);
  try {
    const { index } = loadOrBuildIndex(app);
    if (!existsSync(join(app.stateDir, 'ARCHITECTURE.md'))) out(color.yellow('İpucu: "kurultay analyze" çalıştırılırsa modeller proje mimarisini bilerek çalışır.'));
    const reqFile = typeof args.flags.req === 'string' ? args.flags.req : undefined;
    const requirements = reqFile ? readFileSync(resolve(reqFile), 'utf8') : undefined;
    const orch = new Orchestrator(app.root, app.config, app.router, app.materializer, index, app.bus);
    if (args.flags.yes || args.flags.y) app.config.orchestrator.confirmMerge = false;
    const report = await orch.run(task, {
      mode: (args.flags.mode as RunMode) || undefined,
      skills: typeof args.flags.skill === 'string' ? args.flags.skill.split(',').map((x) => x.trim()).filter(Boolean) : undefined,
      requirements,
      dryRun: !!args.flags['dry-run'],
      confirm: confirmPrompt,
      signal: ctrl.signal,
    });
    out('');
    const st = report.status === 'completed' ? color.green(report.status) : color.yellow(report.status);
    out(`${color.bold('Sonuç')}: ${st} · ${report.changedFiles.length} dosya · ${report.iterations} iterasyon · modeller: ${report.modelsUsed.join(', ')}`);
    for (const f of report.changedFiles) out(`  ${f}`);
    if (report.merge?.conflicts.length) out(color.yellow(`Çakışmalar: ${report.merge.conflicts.join(', ')}`));
    out(`${color.bold('Rapor')}: ${report.reportPath}`);
    out(`${color.bold('Diff')}:  ${report.diffPath}`);
    if (report.status !== 'completed') process.exitCode = 2;
  } finally {
    process.off('SIGINT', onSig);
    stop();
  }
}

async function cmdAsk(app: App, args: Args) {
  const q = args.positional.join(' ').trim();
  if (!q) throw new ConfigError('Soru gerekli: kurultay ask "..."');
  requireModels(app);
  const stop = attachTerminal(app.bus, { verbose: !!args.flags.verbose });
  try {
    const { index } = loadOrBuildIndex(app);
    const arch = join(app.stateDir, 'ARCHITECTURE.md');
    const focus = focusTerms(q);
    const hits = index.search(q, 6);
    const ctx = [
      existsSync(arch) ? `# ARCHITECTURE\n${readFileSync(arch, 'utf8')}` : '',
      `# REPO MAP\n${index.repoMap(1500, { files: hits.map((h) => h.path), identifiers: focus.identifiers })}`,
      `# RELEVANT CODE\n${hits.map((h) => `## ${h.path}:${h.startLine}-${h.endLine}\n${h.text}`).join('\n\n')}`,
    ].join('\n\n');
    const minWin = Math.min(...app.router.list().map((h) => h.caps.contextWindow));
    const r = await councilAnswer(app.router, q, ctx, {
      members: Number(args.flags.members ?? Math.min(3, app.router.size)),
      contextTokens: Math.floor(minWin * 0.5),
      bus: app.bus,
      language: app.config.language === 'tr' ? 'Turkish' : 'English',
    });
    out('\n' + r.answer.trim());
    out(color.dim(`\n— konsey: ${r.members.join(', ')}${r.chair ? ` · başkan: ${r.chair}` : ''}`));
  } finally {
    stop();
  }
}

async function cmdSkills(root: string, args: Args, cfgSkills?: { paths: string[]; disabled: string[]; includeUser: boolean }) {
  const sub = args.positional[0];
  if (sub === 'new') {
    const name = (args.positional[1] ?? '').trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new ConfigError('Skill adı küçük harf, rakam ve tire olmalı (ör. "kod-inceleme"), en fazla 64 karakter.');
    const dir = join(root, '.kurultay', 'skills', name);
    if (existsSync(join(dir, 'SKILL.md'))) throw new ConfigError(`${join(dir, 'SKILL.md')} zaten var.`);
    mkdirSync(dir, { recursive: true });
    const desc = typeof args.flags.description === 'string' ? args.flags.description : 'Bu skill ne yapar ve hangi görevlerde kullanılmalı – modeller bu cümleye bakarak seçer.';
    writeFileSync(join(dir, 'SKILL.md'), SKILL_TEMPLATE(name, desc));
    out(`${color.green('✓')} ${join(dir, 'SKILL.md')}`);
    return;
  }
  const reg = SkillRegistry.discover(root, { extraPaths: cfgSkills?.paths, disabled: cfgSkills?.disabled, includeUser: cfgSkills?.includeUser ?? true });
  if (!reg.size) out("Skill bulunamadı. Oluşturmak için: kurultay skills new <ad>  (taranan dizinler: .kurultay/skills, .agents/skills, .claude/skills, .codex/skills, .qwen/skills, .goose/skills, .opencode/skills, .github/skills, skills/, ~/.agents/skills, ~/.claude/skills)");
  for (const s of reg.skills) {
    const flags = [s.hidden ? 'yalnızca açık seçimle' : '', s.always ? 'always' : '', s.paths.length ? `paths: ${s.paths.join(' ')}` : '', s.keywords.length ? `keywords: ${s.keywords.join(', ')}` : '', s.files.length ? `${s.files.length} destek dosyası` : '']
      .filter(Boolean)
      .join(' · ');
    out(`${color.bold(s.name)}  ${color.dim(`[${s.source}${s.format === 'file' ? ', tek dosya' : ''}]`)}
  ${s.description}${flags ? `
  ${color.dim(flags)}` : ''}`);
  }
  if (reg.diagnostics.length) {
    out(`
${color.yellow('Uyarılar:')}`);
    for (const d of reg.diagnostics) out(`  ${d.level === 'error' ? color.red('✖') : color.yellow('⚠')} ${d.path}: ${d.message}`);
    if (reg.diagnostics.some((d) => d.level === 'error')) process.exitCode = 1;
  }
}

async function cmdStatus(app: App) {
  out(`${color.bold('Proje')}: ${app.root}`);
  out(`${color.bold('Yapılandırma')}: ${app.configPath}`);
  out(`${color.bold('Modeller')} (${app.router.size}, ${app.probed ? 'probe sonucu' : 'keşif'}):`);
  for (const h of app.router.list()) {
    const c = h.caps;
    const best = Object.entries(c.roleScores).sort((a, b) => b[1] - a[1])[0];
    out(`  ${c.key.padEnd(40)} bağlam ${String(c.contextWindow).padStart(7)} · ${c.nativeTools ? 'native araç' : 'prompt araç'} · ${c.tokensPerSec} tok/s · en iyi rol ${best[0]} (${best[1]})`);
  }
  const idx = ProjectIndex.load(app.root, app.stateDir);
  if (idx) {
    const s = idx.stats();
    out(`${color.bold('İndeks')}: ${s.files} dosya, ${s.defs} tanım, özetli ${idx.files.filter((f) => f.summary).length} dosya (${idx.data.builtAt})`);
  } else out(`${color.bold('İndeks')}: yok – "kurultay index" veya "kurultay analyze"`);
  const sessions = join(app.stateDir, 'sessions');
  if (existsSync(sessions)) {
    const list = readdirSync(sessions).sort().slice(-5);
    out(`${color.bold('Son oturumlar')}:`);
    for (const s of list) out(`  ${s}  →  ${join(sessions, s, 'REPORT.md')}`);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.flags.version || args.flags.v) return out(VERSION);
  if (args.cmd === 'help' || args.flags.help || args.flags.h) return out(HELP);
  const KNOWN = ['init', 'mock', 'probe', 'index', 'analyze', 'run', 'ask', 'status', 'map', 'search', 'skills'];
  if (!KNOWN.includes(args.cmd)) {
    out(`Bilinmeyen komut: ${args.cmd}\n`);
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
      case 'mock': {
        const port = Number(args.flags.port ?? 9100);
        const { url } = await startMockServer(DEFAULT_MOCK_MODELS, port);
        out(`Mock LLM sunucusu çalışıyor: ${url}\nModeller: ${DEFAULT_MOCK_MODELS.map((m) => m.id).join(', ')}\nDurdurmak için Ctrl+C.`);
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
        return await cmdIndex(app);
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
        for (const h of index.search(args.positional.join(' '), Number(args.flags.limit ?? 10))) out(`${h.path}:${h.startLine}-${h.endLine}  (${h.score.toFixed(2)})`);
        return;
      }
      default:
        out(`Bilinmeyen komut: ${args.cmd}\n`);
        out(HELP);
        process.exitCode = 1;
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(color.red(`Hata: ${e.message}`) + '\n');
      process.exitCode = 1;
      return;
    }
    throw e;
  }
}
