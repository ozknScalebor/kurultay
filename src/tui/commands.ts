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
import { plural } from '../util/text.js';

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
      { name: 'help', aliases: ['h', '?'], description: 'show commands and shortcuts', run: () => con.out(helpText(con.commands)) },
      {
        name: 'models',
        aliases: ['m'],
        description: 'LLM panel: endpoint health, models, capabilities, capacity',
        run: async () => {
          await con.refreshModels();
          con.out(llmPanel({ config: con.config!, configPath: con.configPath, router: con.router!, probed: con.probed, health: con.health, width: con.screen.columns }));
        },
      },
      {
        name: 'llm',
        args: '[set <key> <value>]',
        description: 'show or change timeout / failover settings',
        complete: (a) => {
          const parts = a.split(/\s+/);
          if (parts.length <= 1) return 'set'.startsWith(parts[0]) ? [{ value: 'set ', label: 'set', description: 'change a setting' }] : [];
          if (parts.length === 2) return llmKeys.filter((k) => k.startsWith(parts[1])).map((k) => ({ value: `set ${k} `, label: k, description: String(con.config?.llm[k]) }));
          return [];
        },
        run: (a) => {
          const m = a.match(/^set\s+(\w+)\s+(\S+)$/);
          if (m) {
            const key = m[1] as keyof LlmConfig;
            if (!llmKeys.includes(key)) return con.out(color.yellow(`Unknown setting: ${m[1]}. Valid: ${llmKeys.join(', ')}`));
            const value = key === 'stickyFailover' ? con.onOff(m[2], true) : Number(m[2]);
            try {
              con.writeConfig((raw) => {
                raw.llm = { ...((raw.llm as object) ?? {}), [key]: value };
              });
            } catch (e) {
              return con.out(color.red(errorMessage(e)));
            }
            con.out(color.dim('The new setting applies from the next request (workspace reloaded).'));
            if (con.app) return con.reloadModels();
            return;
          }
          const l = con.config!.llm;
          con.out(`${color.bold('LLM settings')} ${color.dim(shortPath(con.configPath ?? '-'))}`);
          for (const k of llmKeys) con.out(`  ${k.padEnd(20)} ${String(l[k])}`);
          for (const e of con.config!.endpoints) {
            con.out(`  ${color.cyan(e.name.padEnd(12))} ${e.baseUrl}${e.disabled ? color.dim(' (disabled)') : ''}${e.firstTokenTimeoutMs || e.idleTimeoutMs || e.timeoutMs ? color.dim(` · first token ${e.firstTokenTimeoutMs ?? '-'} · idle ${e.idleTimeoutMs ?? '-'} · total ${e.timeoutMs ?? '-'}`) : ''}`);
          }
          con.out(color.dim('To change: /llm set firstTokenTimeoutMs 120000'));
        },
      },
      {
        name: 'endpoint',
        args: 'add <name> <url> [apiKey] | remove <name>',
        description: 'add / remove an LLM endpoint',
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
              if (!con.config!.endpoints.some((e) => e.name === name)) return con.out(color.yellow(`No endpoint named ${name}`));
              con.writeConfig((raw) => {
                raw.endpoints = ((raw.endpoints as Array<Record<string, unknown>>) ?? []).filter((e) => e.name !== name);
              });
            } else return con.out(color.yellow('Usage: /endpoint add <name> <url> [apiKey]  |  /endpoint remove <name>'));
          } catch (e) {
            return con.out(color.red(errorMessage(e)));
          }
          await con.reloadModels();
        },
      },
      {
        name: 'model',
        args: 'add <name> [apiKey] | remove <name>',
        description: 'add or remove a model on the main endpoint (uses the main API key unless given)',
        complete: (a) => {
          const parts = a.split(/\s+/);
          if (parts.length <= 1) return ['add', 'remove'].filter((x) => x.startsWith(parts[0])).map((x) => ({ value: `${x} `, label: x }));
          if (parts[0] === 'remove' && parts.length === 2) return (con.config?.endpoints[0]?.models ?? []).filter((m) => m.startsWith(parts[1])).map((m) => ({ value: `remove ${m}`, label: m }));
          return [];
        },
        run: async (a) => {
          const [sub, name, key] = a.split(/\s+/);
          if (!(sub === 'add' || sub === 'remove') || !name) return con.out(color.yellow('Usage: /model add <name> [apiKey]  |  /model remove <name>'));
          try {
            con.writeConfig((raw) => editModelList(raw, sub, name, key, (con.health ?? []).find((h) => h.name === con.config?.endpoints[0]?.name)?.models ?? []));
          } catch (e) {
            return con.out(color.red(errorMessage(e)));
          }
          await con.reloadModels();
          if (sub === 'add') con.out(color.dim(`  run /probe ${name} to measure it now (otherwise it is probed when a workspace opens)`));
        },
      },
      {
        name: 'probe',
        args: '[--deep|--quick] [model…]',
        description: 'measure models again and save the profile (all models, or the ones named)',
        complete: (a) => ['--quick', '--deep'].filter((x) => x.startsWith(a)).map((x) => ({ value: x, label: x, description: x === '--deep' ? 'up to 256K context, 16 parallel requests' : 'no coding benchmark' })),
        run: async (a) => {
          const words = a.split(/\s+/).filter(Boolean);
          const models = words.filter((w) => !w.startsWith('--'));
          await con.probe({ quick: words.includes('--quick'), deep: words.includes('--deep'), models: models.length ? models : undefined });
          con.out(llmPanel({ config: con.config!, configPath: con.configPath, router: con.router!, probed: con.probed, health: con.health, width: con.screen.columns }));
        },
      },
      {
        name: 'workspace',
        aliases: ['ws', 'cd'],
        args: '[folder]',
        description: 'show / change the workspace',
        complete: (a) => {
          const recent = con.state.recent.filter((r) => existsSync(r.path) && r.path.startsWith(a)).map((r) => ({ value: r.path, label: shortPath(r.path), description: 'recent' }));
          return a && !recent.length ? completePath(a, con.cwd) : [...recent, ...(a ? completePath(a, con.cwd) : [])];
        },
        run: async (a) => {
          if (!a) {
            con.out(`Workspace: ${con.workspace ? shortPath(con.workspace) : '-'}`);
            const others = con.state.recent.filter((r) => r.path !== con.workspace && existsSync(r.path));
            if (others.length) con.out(color.dim(`Recent: ${others.slice(0, 5).map((r) => shortPath(r.path)).join(', ')}`));
            return;
          }
          const c = checkWorkspace(a, con.workspace ?? con.cwd);
          if (!c.path) return con.out(color.red(c.error!));
          await con.openWorkspace(c.path);
        },
      },
      { name: 'index', ws: true, description: 'update the static index (no LLM needed)', run: () => con.reindex() },
      { name: 'analyze', ws: true, args: '[--force]', description: 'architecture analysis: file summaries, ARCHITECTURE.md, flows, project notes', complete: (a) => ('--force'.startsWith(a) ? [{ value: '--force', label: '--force', description: 'summarise every file again' }] : []), run: (a) => con.analyze(a.includes('--force')) },
      { name: 'ask', aliases: ['a'], ws: true, args: '<question>', description: 'ask a question (the council answers, no code changes)', run: (a) => con.ask(a) },
      { name: 'run', aliases: ['r', 'do'], ws: true, args: '<task>', description: 'plan the task, spread it over the models, verify, review, apply', run: (a) => con.runTask(a) },
      {
        name: 'mode',
        args: '[auto|single|split|race|council]',
        description: 'task run mode',
        complete: (a) => MODES.filter((m) => m.startsWith(a)).map((m) => ({ value: m, label: m, description: MODE_HELP[m] })),
        run: (a) => {
          if (!a) return con.out(`Mode: ${con.settings.mode ?? `${con.config?.orchestrator.defaultMode} (default)`}\n${MODES.map((m) => `  ${m.padEnd(8)} ${MODE_HELP[m]}`).join('\n')}`);
          if (!MODES.includes(a as RunMode)) return con.out(color.yellow(`Invalid mode: ${a}`));
          con.settings.mode = a as RunMode;
          con.out(`Mod: ${a}`);
        },
      },
      {
        name: 'intent',
        args: '[auto|ask|run]',
        description: 'treat plain text as a question or a task',
        complete: (a) => ['auto', 'ask', 'run'].filter((x) => x.startsWith(a)).map((x) => ({ value: x, label: x, description: x === 'auto' ? 'guess from the text' : x === 'ask' ? 'always a question' : 'always a task' })),
        run: (a) => {
          if (a && !['auto', 'ask', 'run'].includes(a)) return con.out(color.yellow('auto, ask or run'));
          if (a) con.settings.intent = a as 'auto' | 'ask' | 'run';
          con.out(`Input is treated as: ${con.settings.intent}`);
        },
      },
      {
        name: 'skills',
        ws: true,
        args: '[ad]',
        description: 'list skills; with a name, preload/unload it for the next tasks',
        complete: (a) => {
          if (!con.app) return [];
          const reg = SkillRegistry.discover(con.app.root, { includeUser: con.app.config.skills.includeUser, extraPaths: con.app.config.skills.paths });
          return reg.skills.filter((s) => s.name.startsWith(a)).map((s) => ({ value: s.name, label: s.name, description: s.description }));
        },
        run: (a) => {
          const reg = SkillRegistry.discover(con.app!.root, { includeUser: con.app!.config.skills.includeUser, extraPaths: con.app!.config.skills.paths, disabled: con.app!.config.skills.disabled });
          if (a) {
            if (!reg.get(a)) return con.out(color.yellow(`Skill not found: ${a}`));
            const name = reg.get(a)!.name;
            con.settings.skills = con.settings.skills.includes(name) ? con.settings.skills.filter((s) => s !== name) : [...con.settings.skills, name];
            return con.out(`Preloaded skills: ${con.settings.skills.join(', ') || '-'}`);
          }
          if (!reg.size) return con.out(color.dim('No skills. Create .kurultay/skills/<name>/SKILL.md (kurultay skills new <name>).'));
          for (const s of reg.skills) con.out(`  ${con.settings.skills.includes(s.name) ? color.green('●') : ' '} ${color.cyan(s.name)}  ${s.description}${s.hidden ? color.dim(' (only when selected)') : ''}`);
        },
      },
      { name: 'map', ws: true, args: '[focus]', description: 'repo map (important files and symbols)', run: (a) => con.out(con.index!.repoMap(1200, { identifiers: a ? a.split(/[\s,]+/) : [], files: a ? a.split(/[\s,]+/) : [] })) },
      {
        name: 'search',
        aliases: ['s'],
        ws: true,
        args: '<query>',
        description: 'BM25 search in the code',
        run: (a) => {
          if (!a) return con.out(color.yellow('Usage: /search <query>'));
          const hits = con.index!.search(a, 10);
          if (!hits.length) return con.out(color.dim('No results.'));
          for (const h of hits) con.out(`  ${color.cyan(`${h.path}:${h.startLine}-${h.endLine}`)} ${color.dim(h.score.toFixed(2))}`);
        },
      },
      {
        name: 'status',
        description: 'workspace, index, models and settings',
        run: () => {
          con.out(`${color.bold('Workspace')}: ${con.workspace ? shortPath(con.workspace) : '-'}`);
          con.out(`${color.bold('Config')}: ${shortPath(con.configPath ?? '-')}`);
          con.out(`${color.bold('Models')}: ${con.router?.size ?? 0} (${con.probed ? 'probed' : 'discovered'}) · ${con.router?.totalCapacity() ?? 0} parallel slots`);
          if (con.index) {
            const s = con.index.stats();
            con.out(`${color.bold('Index')}: ${plural(s.files, 'file')}, ${plural(s.defs, 'definition')}, summarised ${con.index.files.filter((f) => f.summary).length}`);
          }
          con.out(`${color.bold('Settings')}: mode ${con.settings.mode ?? con.config?.orchestrator.defaultMode} · input ${con.settings.intent} · dry-run ${con.settings.dryRun ? 'on' : 'off'} · auto-apply ${con.settings.autoApply ? 'on' : 'off'} · skills ${con.settings.skills.join(', ') || '-'}`);
        },
      },
      {
        name: 'runs',
        ws: true,
        description: 'recent task runs (report folders)',
        run: () => {
          if (!existsSync(sessionsDir())) return con.out(color.dim('No runs yet.'));
          const list = readdirSync(sessionsDir()).sort().slice(-10);
          for (const s of list) {
            let status = '';
            try {
              const j = JSON.parse(readFileSync(join(sessionsDir(), s, 'session.json'), 'utf8')) as { task?: string };
              const rep = existsSync(join(sessionsDir(), s, 'REPORT.md')) ? readFileSync(join(sessionsDir(), s, 'REPORT.md'), 'utf8') : '';
              const st = rep.match(/\*\*(?:Status|Durum):\*\* (\S+)/)?.[1] ?? 'unfinished';
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
        description: 'show the last task report',
        run: () => {
          const dir = lastSession();
          const p = dir && join(dir, 'REPORT.md');
          if (!p || !existsSync(p)) return con.out(color.dim('No report.'));
          con.out(con.md(readFileSync(p, 'utf8')));
        },
      },
      {
        name: 'diff',
        ws: true,
        description: 'changes of the last task',
        run: () => {
          const dir = lastSession();
          const p = dir && join(dir, 'changes.diff');
          if (!p || !existsSync(p)) return con.out(color.dim('No diff.'));
          const text = readFileSync(p, 'utf8');
          con.out(text.split('\n').map((l) => (l.startsWith('+') && !l.startsWith('+++') ? color.green(l) : l.startsWith('-') && !l.startsWith('---') ? color.red(l) : l.startsWith('@@') ? color.cyan(l) : l)).join('\n') || color.dim('(empty)'));
        },
      },
      { name: 'plan', args: '[on|off]', description: 'plan mode: show the plan before code is written and ask for approval/feedback', complete: (a) => ['on', 'off'].filter((x) => x.startsWith(a)).map((x) => ({ value: x, label: x })), run: (a) => {
          con.settings.planApproval = con.onOff(a, con.settings.planApproval);
          con.out(`plan approval: ${con.settings.planApproval ? 'on – the plan is shown for every task' : 'off'}`);
        } },
      { name: 'continue-run', aliases: ['resume-run'], ws: true, args: '[number|session]', description: 'continue an unfinished task (stopped or out of budget) where it left off', run: (a) => con.continueRun(a.trim()) },
      {
      name: 'mcp',
      ws: true,
      args: '[restart]',
      description: 'tools of the MCP servers (config: mcp.servers); restart = restart them',
      run: async (a) => {
        if (a.trim() === 'restart') await con.startMcp();
        const specs = con.mcp?.specs() ?? [];
        if (!specs.length) return con.out(color.dim('No MCP tools. Add "mcp": {"servers": {"name": {"command": "...", "args": []}}} to kurultay.config.json.'));
        for (const t of specs) con.out(`  ${color.cyan(t.function.name)}${con.mcp!.isReadOnly(t.function.name) ? color.dim(' (read-only)') : ''}  ${t.function.description}`);
      },
    },
    { name: 'stats', aliases: ['context', 'tokens'], args: '[reset]', description: 'tokens spent, requests and context use per model (session + last task)', complete: (a) => ('reset'.startsWith(a) ? [{ value: 'reset', label: 'reset', description: 'reset the session counters' }] : []), run: (a) => con.stats(a) },
      { name: 'dry-run', args: '[on|off]', description: 'do not write changes to the project, only produce a diff', complete: (a) => ['on', 'off'].filter((x) => x.startsWith(a)).map((x) => ({ value: x, label: x })), run: (a) => {
          con.settings.dryRun = con.onOff(a, con.settings.dryRun);
          con.out(`dry-run: ${con.settings.dryRun ? 'on' : 'off'}`);
        } },
      { name: 'auto-apply', args: '[on|off]', description: 'apply the result to the project without asking', complete: (a) => ['on', 'off'].filter((x) => x.startsWith(a)).map((x) => ({ value: x, label: x })), run: (a) => {
          con.settings.autoApply = con.onOff(a, con.settings.autoApply);
          con.out(`auto-apply: ${con.settings.autoApply ? 'on' : 'off'}`);
        } },
      {
        name: 'verbose',
        args: '[on|off]',
        description: 'show LLM request/response details',
        complete: (a) => ['on', 'off'].filter((x) => x.startsWith(a)).map((x) => ({ value: x, label: x })),
        run: (a) => {
          con.settings.verbose = con.onOff(a, con.settings.verbose);
          if (con.app) {
            con.detachLog?.();
            con.detachLog = attachTerminal(con.bus, { verbose: con.settings.verbose, write: (l) => con.out(l) });
          }
          con.out(`verbose log: ${con.settings.verbose ? 'on' : 'off'}`);
        },
      },
      {
        name: 'ui',
        args: '[port]',
        description: 'open a live dashboard in the browser (local, no external resources)',
        run: async (a) => {
          if (con.dashboard) return con.out('The dashboard is already open.');
          if (!con.router) return con.out(color.yellow('No model.'));
          try {
            const { server, url } = await startDashboard(con.bus, con.router, Number(a) || 7420);
            con.dashboard = server;
            con.out(`Dashboard: ${url}`);
          } catch (e) {
            con.out(color.red(`Could not open the dashboard: ${errorMessage(e)}`));
          }
        },
      },
      { name: 'sessions', ws: true, description: 'saved conversation sessions', run: () => sessions.printConversations(con) },
      {
        name: 'resume',
        aliases: ['continue'],
        ws: true,
        args: '[number|id]',
        description: 'continue a saved session (question history and settings)',
        complete: (a) =>
          sessions.conversationList(con)
            .slice(0, 15)
            .map((c, i) => ({ value: String(i + 1), label: `${i + 1}) ${c.title || c.id}`, description: `${plural(c.turns.length, 'turn')} · ${relativeTime(c.updatedAt)}` }))
            .filter((x) => !a || x.value.startsWith(a)),
        run: async (a) => {
          if (!a) return sessions.printConversations(con);
          await sessions.resume(con, a);
        },
      },
      { name: 'branch', aliases: ['fork'], ws: true, args: '[title]', description: 'branch the conversation from here (new session, the old one is kept)', run: (a) => sessions.branch(con, a) },
      { name: 'history', ws: true, description: 'turns of this session', run: () => sessions.history(con) },
      {
        name: 'rewind',
        aliases: ['undo'],
        ws: true,
        args: '[turn]',
        description: 'go back before a turn: undo the applied changes and the later turns',
        complete: (a) => (con.conversation?.turns ?? []).map((t) => ({ value: String(t.n), label: `#${t.n}`, description: t.input.split('\n')[0].slice(0, 60) })).filter((x) => x.value.startsWith(a)).reverse(),
        run: (a) => sessions.rewind(con, a),
      },
      {
        name: 'worktree',
        aliases: ['wt'],
        ws: true,
        args: '[new <ad>|list|diff|merge|commit|exit|remove <ad>]',
        description: 'git worktree: work on a separate branch, see the diff, merge',
        complete: (a) => {
          const parts = a.split(/\s+/);
          const subs: Array<[string, string]> = [['new ', 'new worktree + branch'], ['list', 'list'], ['diff ', 'show the diff'], ['merge ', 'merge into the main branch'], ['commit ', 'commit the changes'], ['exit', 'back to the main repo'], ['remove ', 'remove']];
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
        description: 'clear the screen and start a new session (the old one stays saved)',
        run: () => {
          con.askHistory = [];
          con.conversation = undefined;
          if (con.screen.interactive) con.screen.write('\x1b[2J\x1b[H');
          con.out(color.dim('New session started (/resume returns to the previous one).'));
        },
      },
      {
        name: 'exit',
        aliases: ['quit', 'q'],
        description: 'quit',
        run: () => {
          con.exitRequested = true;
        },
      },
    ];
    return list;
}

/**
 * Add/remove a model in a raw config file. Works on the short form ({ baseUrl, models })
 * and on a single-endpoint config. A config without a model list uses every model the
 * endpoint reports, so the first "add" starts the list from those (`discovered`).
 */
export function editModelList(raw: Record<string, unknown>, sub: 'add' | 'remove', name: string, apiKey: string | undefined, discovered: string[]): void {
  const holder: Record<string, unknown> | undefined =
    typeof raw.baseUrl === 'string' ? raw : Array.isArray(raw.endpoints) && raw.endpoints.length >= 1 ? (raw.endpoints[0] as Record<string, unknown>) : undefined;
  if (!holder) throw new Error('No endpoint configured – run the setup first (delete the config or use /endpoint add).');
  const id = (m: unknown) => (typeof m === 'string' ? m : (m as { id?: string })?.id);
  let list = Array.isArray(holder.models) && holder.models.length ? [...(holder.models as unknown[])] : [...discovered];
  list = list.filter((m) => id(m) !== name);
  if (sub === 'add') list.push(apiKey ? { id: name, apiKey } : name);
  else if (list.length === (Array.isArray(holder.models) ? holder.models.length : discovered.length)) throw new Error(`No model named ${name}`);
  holder.models = list;
}
