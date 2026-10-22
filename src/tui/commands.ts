import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type LlmConfig, type RunMode } from '../config.js';
import { SkillRegistry } from '../skills/skills.js';
import { startDashboard } from '../ui/dashboard.js';
import { attachTerminal, color } from '../ui/terminal.js';
import { errorMessage } from '../util/async.js';
import { relativeTime } from './conversation.js';
import { helpText, llmPanel } from './panels.js';
import { checkWorkspace, completePath, shortPath } from './state.js';
import { MODES, MODE_HELP, type Command } from './command-types.js';
import * as sessions from './session-commands.js';
import type { KurultayConsole } from './console.js';

/** The slash-command table of the console (one place to see every command). */
export function buildCommands(con: KurultayConsole): Command[] {
    const sessionsDir = () => join(con.app!.stateDir, 'sessions');
    const lastSession = (): string | undefined => {
      if (con.lastReport) return con.lastReport.sessionDir;
      if (!existsSync(sessionsDir())) return undefined;
      const list = readdirSync(sessionsDir()).sort();
      return list.length ? join(sessionsDir(), list[list.length - 1]) : undefined;
    };
    const llmKeys: Array<keyof LlmConfig> = ['firstTokenTimeoutMs', 'idleTimeoutMs', 'timeoutMs', 'prefillMsPerToken', 'timeoutRetries', 'timeoutCooldownMs', 'stickyFailover'];
    const list: Command[] = [
      { name: 'help', aliases: ['h', '?'], description: 'komutları ve kısayolları göster', run: () => con.out(helpText(con.commands)) },
      {
        name: 'models',
        aliases: ['m'],
        description: 'LLM paneli: endpoint sağlığı, modeller, yetenekler, kapasite',
        run: async () => {
          await con.refreshModels();
          con.out(llmPanel({ config: con.config!, configPath: con.configPath, router: con.router!, probed: con.probed, health: con.health, width: con.screen.columns }));
        },
      },
      {
        name: 'llm',
        args: '[set <ayar> <değer>]',
        description: 'zaman aşımı / failover ayarlarını göster veya değiştir',
        complete: (a) => {
          const parts = a.split(/\s+/);
          if (parts.length <= 1) return 'set'.startsWith(parts[0]) ? [{ value: 'set ', label: 'set', description: 'bir ayarı değiştir' }] : [];
          if (parts.length === 2) return llmKeys.filter((k) => k.startsWith(parts[1])).map((k) => ({ value: `set ${k} `, label: k, description: String(con.config?.llm[k]) }));
          return [];
        },
        run: (a) => {
          const m = a.match(/^set\s+(\w+)\s+(\S+)$/);
          if (m) {
            const key = m[1] as keyof LlmConfig;
            if (!llmKeys.includes(key)) return con.out(color.yellow(`Bilinmeyen ayar: ${m[1]}. Geçerli: ${llmKeys.join(', ')}`));
            const value = key === 'stickyFailover' ? con.onOff(m[2], true) : Number(m[2]);
            try {
              con.writeConfig((raw) => {
                raw.llm = { ...((raw.llm as object) ?? {}), [key]: value };
              });
            } catch (e) {
              return con.out(color.red(errorMessage(e)));
            }
            con.out(color.dim('Yeni ayar bir sonraki istekten itibaren geçerli (çalışma alanı yeniden yüklenir).'));
            if (con.app) return con.reloadModels();
            return;
          }
          const l = con.config!.llm;
          con.out(`${color.bold('LLM ayarları')} ${color.dim(shortPath(con.configPath ?? '-'))}`);
          for (const k of llmKeys) con.out(`  ${k.padEnd(20)} ${String(l[k])}`);
          for (const e of con.config!.endpoints) {
            con.out(`  ${color.cyan(e.name.padEnd(12))} ${e.baseUrl}${e.disabled ? color.dim(' (kapalı)') : ''}${e.firstTokenTimeoutMs || e.idleTimeoutMs || e.timeoutMs ? color.dim(` · ilk token ${e.firstTokenTimeoutMs ?? '-'} · sessizlik ${e.idleTimeoutMs ?? '-'} · toplam ${e.timeoutMs ?? '-'}`) : ''}`);
          }
          con.out(color.dim('Değiştirmek için: /llm set firstTokenTimeoutMs 120000'));
        },
      },
      {
        name: 'endpoint',
        args: 'add <ad> <url> [anahtar] | remove <ad>',
        description: 'LLM endpoint ekle / çıkar',
        complete: (a) => {
          const parts = a.split(/\s+/);
          if (parts.length <= 1) return ['add', 'remove'].filter((x) => x.startsWith(parts[0])).map((x) => ({ value: `${x} `, label: x }));
          if (parts[0] === 'remove' && parts.length === 2) return (con.config?.endpoints ?? []).filter((e) => e.name.startsWith(parts[1])).map((e) => ({ value: `remove ${e.name}`, label: e.name, description: e.baseUrl }));
          return [];
        },
        run: async (a) => {
          const [sub, name, url, key] = a.split(/\s+/);
          try {
            if (sub === 'add' && name && url) {
              con.writeConfig((raw) => {
                const eps = ((raw.endpoints as Array<Record<string, unknown>>) ?? []).filter((e) => e.name !== name);
                eps.push({ name, baseUrl: url, apiKey: key ?? 'none' });
                raw.endpoints = eps;
              });
            } else if (sub === 'remove' && name) {
              if (!con.config!.endpoints.some((e) => e.name === name)) return con.out(color.yellow(`Endpoint yok: ${name}`));
              con.writeConfig((raw) => {
                raw.endpoints = ((raw.endpoints as Array<Record<string, unknown>>) ?? []).filter((e) => e.name !== name);
              });
            } else return con.out(color.yellow('Kullanım: /endpoint add <ad> <url> [anahtar]  |  /endpoint remove <ad>'));
          } catch (e) {
            return con.out(color.red(errorMessage(e)));
          }
          await con.reloadModels();
        },
      },
      {
        name: 'probe',
        args: '[--deep|--quick]',
        description: 'tüm modellerin yeteneklerini ölç (bağlam, araç, hız, kod/düzenleme puanı)',
        complete: (a) => ['--quick', '--deep'].filter((x) => x.startsWith(a)).map((x) => ({ value: x, label: x, description: x === '--deep' ? '256K bağlam, 16 paralel istek' : 'benchmark yok' })),
        run: async (a) => {
          await con.probe({ quick: a.includes('--quick'), deep: a.includes('--deep') });
          con.out(llmPanel({ config: con.config!, configPath: con.configPath, router: con.router!, probed: con.probed, health: con.health, width: con.screen.columns }));
        },
      },
      {
        name: 'workspace',
        aliases: ['ws', 'cd'],
        args: '[klasör]',
        description: 'çalışma alanını göster / değiştir',
        complete: (a) => {
          const recent = con.state.recent.filter((r) => existsSync(r.path) && r.path.startsWith(a)).map((r) => ({ value: r.path, label: shortPath(r.path), description: 'son kullanılan' }));
          return a && !recent.length ? completePath(a, con.cwd) : [...recent, ...(a ? completePath(a, con.cwd) : [])];
        },
        run: async (a) => {
          if (!a) {
            con.out(`Çalışma alanı: ${con.workspace ? shortPath(con.workspace) : '-'}`);
            const others = con.state.recent.filter((r) => r.path !== con.workspace && existsSync(r.path));
            if (others.length) con.out(color.dim(`Son kullanılanlar: ${others.slice(0, 5).map((r) => shortPath(r.path)).join(', ')}`));
            return;
          }
          const c = checkWorkspace(a, con.workspace ?? con.cwd);
          if (!c.path) return con.out(color.red(c.error!));
          await con.openWorkspace(c.path);
        },
      },
      { name: 'index', ws: true, description: 'statik indeksi güncelle (LLM gerekmez)', run: () => con.reindex() },
      { name: 'analyze', ws: true, args: '[--force]', description: 'mimari analiz: dosya özetleri, ARCHITECTURE.md, akışlar, proje notları', complete: (a) => ('--force'.startsWith(a) ? [{ value: '--force', label: '--force', description: 'tüm dosyaları yeniden özetle' }] : []), run: (a) => con.analyze(a.includes('--force')) },
      { name: 'ask', aliases: ['a'], ws: true, args: '<soru>', description: 'soru sor (konsey cevaplar, kod değişmez)', run: (a) => con.ask(a) },
      { name: 'run', aliases: ['r', 'do'], ws: true, args: '<görev>', description: 'görevi planla, modellere dağıt, doğrula, incele, uygula', run: (a) => con.runTask(a) },
      {
        name: 'mode',
        args: '[auto|single|split|race|council]',
        description: 'görev çalıştırma modu',
        complete: (a) => MODES.filter((m) => m.startsWith(a)).map((m) => ({ value: m, label: m, description: MODE_HELP[m] })),
        run: (a) => {
          if (!a) return con.out(`Mod: ${con.settings.mode ?? `${con.config?.orchestrator.defaultMode} (varsayılan)`}\n${MODES.map((m) => `  ${m.padEnd(8)} ${MODE_HELP[m]}`).join('\n')}`);
          if (!MODES.includes(a as RunMode)) return con.out(color.yellow(`Geçersiz mod: ${a}`));
          con.settings.mode = a as RunMode;
          con.out(`Mod: ${a}`);
        },
      },
      {
        name: 'intent',
        args: '[auto|ask|run]',
        description: 'düz metin soru mu iş mi sayılsın',
        complete: (a) => ['auto', 'ask', 'run'].filter((x) => x.startsWith(a)).map((x) => ({ value: x, label: x, description: x === 'auto' ? 'metinden tahmin et' : x === 'ask' ? 'hep soru' : 'hep görev' })),
        run: (a) => {
          if (a && !['auto', 'ask', 'run'].includes(a)) return con.out(color.yellow('auto, ask veya run'));
          if (a) con.settings.intent = a as 'auto' | 'ask' | 'run';
          con.out(`Girdi yorumu: ${con.settings.intent}`);
        },
      },
      {
        name: 'skills',
        ws: true,
        args: '[ad]',
        description: "skill'leri listele; ad verilirse sonraki işlerde baştan yükle/kaldır",
        complete: (a) => {
          if (!con.app) return [];
          const reg = SkillRegistry.discover(con.app.root, { includeUser: con.app.config.skills.includeUser, extraPaths: con.app.config.skills.paths });
          return reg.skills.filter((s) => s.name.startsWith(a)).map((s) => ({ value: s.name, label: s.name, description: s.description }));
        },
        run: (a) => {
          const reg = SkillRegistry.discover(con.app!.root, { includeUser: con.app!.config.skills.includeUser, extraPaths: con.app!.config.skills.paths, disabled: con.app!.config.skills.disabled });
          if (a) {
            if (!reg.get(a)) return con.out(color.yellow(`Skill bulunamadı: ${a}`));
            const name = reg.get(a)!.name;
            con.settings.skills = con.settings.skills.includes(name) ? con.settings.skills.filter((s) => s !== name) : [...con.settings.skills, name];
            return con.out(`Baştan yüklenecek skill'ler: ${con.settings.skills.join(', ') || '-'}`);
          }
          if (!reg.size) return con.out(color.dim("Skill yok. .kurultay/skills/<ad>/SKILL.md oluşturun (kurultay skills new <ad>)."));
          for (const s of reg.skills) con.out(`  ${con.settings.skills.includes(s.name) ? color.green('●') : ' '} ${color.cyan(s.name)}  ${s.description}${s.hidden ? color.dim(' (yalnızca açık seçimle)') : ''}`);
        },
      },
      { name: 'map', ws: true, args: '[odak]', description: 'repo haritası (önemli dosya ve semboller)', run: (a) => con.out(con.index!.repoMap(1200, { identifiers: a ? a.split(/[\s,]+/) : [], files: a ? a.split(/[\s,]+/) : [] })) },
      {
        name: 'search',
        aliases: ['s'],
        ws: true,
        args: '<sorgu>',
        description: 'kodda BM25 araması',
        run: (a) => {
          if (!a) return con.out(color.yellow('Kullanım: /search <sorgu>'));
          const hits = con.index!.search(a, 10);
          if (!hits.length) return con.out(color.dim('Sonuç yok.'));
          for (const h of hits) con.out(`  ${color.cyan(`${h.path}:${h.startLine}-${h.endLine}`)} ${color.dim(h.score.toFixed(2))}`);
        },
      },
      {
        name: 'status',
        description: 'çalışma alanı, indeks, modeller ve ayarlar',
        run: () => {
          con.out(`${color.bold('Çalışma alanı')}: ${con.workspace ? shortPath(con.workspace) : '-'}`);
          con.out(`${color.bold('Yapılandırma')}: ${shortPath(con.configPath ?? '-')}`);
          con.out(`${color.bold('Modeller')}: ${con.router?.size ?? 0} (${con.probed ? 'ölçülmüş' : 'keşif'}) · ${con.router?.totalCapacity() ?? 0} paralel slot`);
          if (con.index) {
            const s = con.index.stats();
            con.out(`${color.bold('İndeks')}: ${s.files} dosya, ${s.defs} tanım, özetli ${con.index.files.filter((f) => f.summary).length}`);
          }
          con.out(`${color.bold('Ayarlar')}: mod ${con.settings.mode ?? con.config?.orchestrator.defaultMode} · girdi ${con.settings.intent} · dry-run ${con.settings.dryRun ? 'açık' : 'kapalı'} · onaysız uygula ${con.settings.autoApply ? 'açık' : 'kapalı'} · skill ${con.settings.skills.join(', ') || '-'}`);
        },
      },
      {
        name: 'runs',
        ws: true,
        description: 'son görev çalıştırmaları (rapor klasörleri)',
        run: () => {
          if (!existsSync(sessionsDir())) return con.out(color.dim('Henüz oturum yok.'));
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
            con.out(`  ${color.cyan(s)}  ${status}`);
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
          if (!p || !existsSync(p)) return con.out(color.dim('Rapor yok.'));
          con.out(con.md(readFileSync(p, 'utf8')));
        },
      },
      {
        name: 'diff',
        ws: true,
        description: 'son görevin değişiklikleri',
        run: () => {
          const dir = lastSession();
          const p = dir && join(dir, 'changes.diff');
          if (!p || !existsSync(p)) return con.out(color.dim('Diff yok.'));
          const text = readFileSync(p, 'utf8');
          con.out(text.split('\n').map((l) => (l.startsWith('+') && !l.startsWith('+++') ? color.green(l) : l.startsWith('-') && !l.startsWith('---') ? color.red(l) : l.startsWith('@@') ? color.cyan(l) : l)).join('\n') || color.dim('(boş)'));
        },
      },
      { name: 'plan', args: '[on|off]', description: 'plan modu: kod yazılmadan önce planı göster, onay/geri bildirim iste', complete: (a) => ['on', 'off'].filter((x) => x.startsWith(a)).map((x) => ({ value: x, label: x })), run: (a) => {
          con.settings.planApproval = con.onOff(a, con.settings.planApproval);
          con.out(`plan onayı: ${con.settings.planApproval ? 'açık – her görevde plan gösterilir' : 'kapalı'}`);
        } },
      { name: 'continue-run', aliases: ['devam'], ws: true, args: '[numara|oturum]', description: 'yarıda kalan / bütçesi dolan görevi kaldığı yerden sürdür', run: (a) => con.continueRun(a.trim()) },
      {
      name: 'mcp',
      ws: true,
      args: '[restart]',
      description: 'MCP sunucularının araçları (config: mcp.servers); restart = yeniden başlat',
      run: async (a) => {
        if (a.trim() === 'restart') await con.startMcp();
        const specs = con.mcp?.specs() ?? [];
        if (!specs.length) return con.out(color.dim('MCP aracı yok. kurultay.config.json içine "mcp": {"servers": {"ad": {"command": "...", "args": []}}} ekleyin.'));
        for (const t of specs) con.out(`  ${color.cyan(t.function.name)}${con.mcp!.isReadOnly(t.function.name) ? color.dim(' (salt okunur)') : ''}  ${t.function.description}`);
      },
    },
    { name: 'stats', ws: true, description: 'son görevin model başına istek/token/süre tablosu', run: () => con.stats() },
      { name: 'dry-run', args: '[on|off]', description: 'değişiklikleri projeye yazma, yalnızca diff üret', complete: (a) => ['on', 'off'].filter((x) => x.startsWith(a)).map((x) => ({ value: x, label: x })), run: (a) => {
          con.settings.dryRun = con.onOff(a, con.settings.dryRun);
          con.out(`dry-run: ${con.settings.dryRun ? 'açık' : 'kapalı'}`);
        } },
      { name: 'auto-apply', args: '[on|off]', description: 'sonucu onay sormadan projeye uygula', complete: (a) => ['on', 'off'].filter((x) => x.startsWith(a)).map((x) => ({ value: x, label: x })), run: (a) => {
          con.settings.autoApply = con.onOff(a, con.settings.autoApply);
          con.out(`onaysız uygula: ${con.settings.autoApply ? 'açık' : 'kapalı'}`);
        } },
      {
        name: 'verbose',
        args: '[on|off]',
        description: 'LLM istek/yanıt ayrıntılarını göster',
        complete: (a) => ['on', 'off'].filter((x) => x.startsWith(a)).map((x) => ({ value: x, label: x })),
        run: (a) => {
          con.settings.verbose = con.onOff(a, con.settings.verbose);
          if (con.app) {
            con.detachLog?.();
            con.detachLog = attachTerminal(con.bus, { verbose: con.settings.verbose, write: (l) => con.out(l) });
          }
          con.out(`ayrıntılı günlük: ${con.settings.verbose ? 'açık' : 'kapalı'}`);
        },
      },
      {
        name: 'ui',
        args: '[port]',
        description: 'tarayıcıda canlı pano aç (yerel, harici kaynak yok)',
        run: async (a) => {
          if (con.dashboard) return con.out('Pano zaten açık.');
          if (!con.router) return con.out(color.yellow('Model yok.'));
          try {
            const { server, url } = await startDashboard(con.bus, con.router, Number(a) || 7420);
            con.dashboard = server;
            con.out(`Pano: ${url}`);
          } catch (e) {
            con.out(color.red(`Pano açılamadı: ${errorMessage(e)}`));
          }
        },
      },
      { name: 'sessions', ws: true, description: 'kayıtlı konuşma oturumları', run: () => sessions.printConversations(con) },
      {
        name: 'resume',
        aliases: ['continue'],
        ws: true,
        args: '[numara|id]',
        description: 'kayıtlı bir oturuma devam et (soru geçmişi ve ayarlarla)',
        complete: (a) =>
          sessions.conversationList(con)
            .slice(0, 15)
            .map((c, i) => ({ value: String(i + 1), label: `${i + 1}) ${c.title || c.id}`, description: `${c.turns.length} tur · ${relativeTime(c.updatedAt)}` }))
            .filter((x) => !a || x.value.startsWith(a)),
        run: async (a) => {
          if (!a) return sessions.printConversations(con);
          await sessions.resume(con, a);
        },
      },
      { name: 'branch', aliases: ['fork'], ws: true, args: '[başlık]', description: 'konuşmayı buradan dallandır (yeni oturum, öncekisi korunur)', run: (a) => sessions.branch(con, a) },
      { name: 'history', ws: true, description: 'bu oturumun turları', run: () => sessions.history(con) },
      {
        name: 'rewind',
        aliases: ['undo'],
        ws: true,
        args: '[tur]',
        description: 'bir turun öncesine dön: uygulanan değişiklikleri ve sonraki turları geri al',
        complete: (a) => (con.conversation?.turns ?? []).map((t) => ({ value: String(t.n), label: `#${t.n}`, description: t.input.split('\n')[0].slice(0, 60) })).filter((x) => x.value.startsWith(a)).reverse(),
        run: (a) => sessions.rewind(con, a),
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
          if (['diff', 'merge', 'commit', 'remove', 'rm'].includes(parts[0]) && con.app) {
            try {
              return sessions.currentWorktrees(con).filter((w) => w.slug.startsWith(parts[1])).map((w) => ({ value: `${parts[0]} ${w.slug}`, label: w.slug, description: w.branch }));
            } catch {
              return [];
            }
          }
          return [];
        },
        run: (a) => sessions.worktreeCommand(con, a),
      },
      {
        name: 'clear',
        aliases: ['new'],
        description: 'ekranı temizle ve yeni oturum başlat (önceki kayıtlı kalır)',
        run: () => {
          con.askHistory = [];
          con.conversation = undefined;
          if (con.screen.interactive) con.screen.write('\x1b[2J\x1b[H');
          con.out(color.dim('Yeni oturum başladı (öncekine /resume ile dönebilirsiniz).'));
        },
      },
      {
        name: 'exit',
        aliases: ['quit', 'q'],
        description: 'çık',
        run: () => {
          con.exitRequested = true;
        },
      },
    ];
    return list;
}
