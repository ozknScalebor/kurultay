import { spawn } from 'node:child_process';
import type { KurultayConfig } from '../config.js';
import type { ProjectIndex } from '../index/project-index.js';
import type { SkillRegistry } from '../skills/skills.js';
import type { ToolSpec } from '../llm/types.js';
import type { EventBus } from '../util/events.js';
import { truncateMiddle } from '../util/text.js';
import { EditError, applyReplacement } from './edits.js';
import { postEditCheck } from './syntax.js';
import { safeRelPath, type Materializer, type Overlay } from './workspace.js';

export interface ToolContext {
  workerId: string;
  root: string;
  overlay: Overlay;
  index?: ProjectIndex;
  materializer: Materializer;
  config: KurultayConfig;
  bus?: EventBus;
  signal?: AbortSignal;
  /** tool names this worker may use (read-only reviewers get a subset) */
  allowed?: Set<string>;
  skills?: SkillRegistry;
  /** hidden skills the user selected explicitly may be loaded */
  explicitSkills?: Set<string>;
  /** names already loaded into this worker (avoid duplicates) */
  loadedSkills?: Set<string>;
  /** files this worker has read (read-before-edit guard – Qwen/Crush/OMO) */
  readFiles?: Set<string>;
  /** files this worker created or modified */
  writtenFiles?: Set<string>;
  /** files whose last edit failed to match – must be re-read before the next edit */
  staleFiles?: Set<string>;
}

/** Read-before-edit: an existing file may only be modified after the worker read it. */
function guardUnread(path: string, ctx: ToolContext, verb: string): ToolOutcome | undefined {
  if (!ctx.config.tools.requireReadBeforeEdit || !ctx.readFiles) return undefined;
  if (ctx.staleFiles?.has(path)) {
    return { output: `${path} için son düzenleme eşleşmedi; ${verb} önce dosyayı read_file ile yeniden okuyun.`, isError: true };
  }
  if (ctx.readFiles.has(path) || ctx.writtenFiles?.has(path)) return undefined;
  if (ctx.overlay.read(path) === undefined) return undefined;
  return { output: `${path} dosyasını ${verb} önce read_file ile okumalısınız (gerçek içeriği görmeden yapılan düzenlemeler genellikle başarısız olur).`, isError: true };
}

/**
 * Aider-style path resolution: when a model names a file that does not exist
 * but exactly one indexed file has that suffix/basename, use it.
 */
function resolveExisting(ctx: ToolContext, path: string): { path: string; note: string } {
  if (ctx.overlay.read(path) !== undefined || !ctx.index) return { path, note: '' };
  const files = ctx.index.files.map((f) => f.path);
  const suffix = files.filter((f) => f.endsWith('/' + path));
  const base = path.split('/').pop()!;
  const cands = suffix.length ? suffix : files.filter((f) => f.split('/').pop() === base);
  if (cands.length === 1) return { path: cands[0], note: `(not: "${path}" bulunamadı, "${cands[0]}" kullanıldı)\n` };
  return { path, note: '' };
}

export interface ToolOutcome {
  output: string;
  /** set by finish */
  finished?: { summary: string; status: 'done' | 'blocked' };
  isError?: boolean;
}

type Executor = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutcome>;

interface ToolDef {
  spec: ToolSpec;
  readOnly: boolean;
  run: Executor;
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new Error(`"${name}" parametresi metin olmalı`);
  return v;
};
const optNum = (v: unknown): number | undefined => (v === undefined || v === null || v === '' ? undefined : Number(v));

function numbered(content: string, start: number, end: number): string {
  const lines = content.split('\n');
  const s = Math.max(1, start);
  const e = Math.min(lines.length, end);
  const width = String(e).length;
  const out: string[] = [];
  for (let i = s; i <= e; i++) out.push(`${String(i).padStart(width)}│ ${lines[i - 1]}`);
  return out.join('\n');
}

export function runShell(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    // On Windows let Node build the cmd.exe invocation itself (correct quoting of the whole command line)
    const child = spawn(isWin ? command : 'bash', isWin ? [] : ['-lc', command], {
      shell: isWin ? true : false,
      windowsHide: true,
      cwd,
      env: { ...process.env, CI: '1', TERM: 'dumb', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const cap = 400_000;
    const onData = (d: Buffer) => {
      if (out.length < cap) out += d.toString('utf8');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, output: out, timedOut });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `komut başlatılamadı: ${e.message}`, timedOut: false });
    });
  });
}

const TOOLS: Record<string, ToolDef> = {
  read_file: {
    readOnly: true,
    spec: {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a text file (with line numbers). Use start_line/end_line for large files.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } },
          required: ['path'],
        },
      },
    },
    async run(a, ctx) {
      const r = resolveExisting(ctx, safeRelPath(ctx.root, str(a.path, 'path')));
      const path = r.path;
      const content = ctx.overlay.read(path);
      if (content === undefined) {
        const near = ctx.index?.files.map((f) => f.path).filter((f) => f.includes(path.split('/').pop()!.replace(/\.[^.]+$/, ''))).slice(0, 5) ?? [];
        return { output: `Dosya yok: ${path}${near.length ? `. Benzer dosyalar: ${near.join(', ')}` : ''}`, isError: true };
      }
      ctx.readFiles?.add(path);
      ctx.staleFiles?.delete(path);
      const total = content.split('\n').length;
      const start = optNum(a.start_line) ?? 1;
      const end = optNum(a.end_line) ?? Math.min(total, start + 399);
      const body = numbered(content, start, end);
      const more = end < total ? `\n… (${total} satırın ${start}-${end} arası gösterildi; devamı için start_line=${end + 1})` : '';
      return { output: `${r.note}${path} (${total} satır)\n${body}${more}` };
    },
  },
  list_dir: {
    readOnly: true,
    spec: {
      type: 'function',
      function: {
        name: 'list_dir',
        description: 'List a directory of the project ("." for root).',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: [] },
      },
    },
    async run(a, ctx) {
      const raw = typeof a.path === 'string' && a.path.trim() && a.path.trim() !== '.' ? safeRelPath(ctx.root, a.path) : '';
      const items = ctx.overlay.list(raw).filter((e) => !/^(\.git|\.kurultay|node_modules)$/.test(e.name));
      if (!items.length) return { output: `Boş ya da bulunamadı: ${raw || '.'}` };
      return { output: items.slice(0, 300).map((e) => (e.dir ? `${e.name}/` : e.name)).join('\n') };
    },
  },
  search_code: {
    readOnly: true,
    spec: {
      type: 'function',
      function: {
        name: 'search_code',
        description: 'Ranked semantic-ish search (BM25 over code, identifiers split) – use natural words or identifiers.',
        parameters: { type: 'object', properties: { query: { type: 'string' }, path_filter: { type: 'string', description: 'optional path glob like src/net/*' } }, required: ['query'] },
      },
    },
    async run(a, ctx) {
      if (!ctx.index) return { output: 'İndeks yok; grep kullanın.', isError: true };
      const hits = ctx.index.search(str(a.query, 'query'), 8, typeof a.path_filter === 'string' ? a.path_filter : undefined);
      if (!hits.length) return { output: 'Sonuç yok.' };
      return {
        output: hits
          .map((h) => {
            const lines = h.text.split('\n');
            const q = new Set(String(a.query).toLowerCase().split(/\W+/).filter(Boolean));
            let best = 0;
            lines.forEach((l, i) => {
              if ([...q].some((w) => l.toLowerCase().includes(w)) && best === 0) best = i;
            });
            const from = Math.max(0, best - 3);
            const snippet = lines.slice(from, from + 12).map((l, i) => `${h.startLine + from + i}│ ${l}`).join('\n');
            return `## ${h.path}:${h.startLine}-${h.endLine} (skor ${h.score.toFixed(2)})\n${snippet}`;
          })
          .join('\n\n'),
      };
    },
  },
  grep: {
    readOnly: true,
    spec: {
      type: 'function',
      function: {
        name: 'grep',
        description: 'Regex search across project files. Returns path:line: text.',
        parameters: { type: 'object', properties: { pattern: { type: 'string' }, path_filter: { type: 'string' }, ignore_case: { type: 'boolean' } }, required: ['pattern'] },
      },
    },
    async run(a, ctx) {
      let re: RegExp;
      try {
        re = new RegExp(str(a.pattern, 'pattern'), a.ignore_case ? 'i' : '');
      } catch (e) {
        return { output: `Geçersiz regex: ${(e as Error).message}`, isError: true };
      }
      const filter = typeof a.path_filter === 'string' && a.path_filter ? new RegExp(a.path_filter.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')) : undefined;
      const paths = new Set<string>(ctx.index?.files.map((f) => f.path) ?? []);
      for (const p of ctx.overlay.changedFiles()) paths.add(p);
      const out: string[] = [];
      for (const p of paths) {
        if (filter && !filter.test(p)) continue;
        const c = ctx.overlay.read(p);
        if (!c) continue;
        const lines = c.split('\n');
        for (let i = 0; i < lines.length && out.length < 120; i++) if (re.test(lines[i])) out.push(`${p}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        if (out.length >= 120) break;
      }
      return { output: out.length ? out.join('\n') + (out.length >= 120 ? '\n… (ilk 120 sonuç)' : '') : 'Eşleşme yok.' };
    },
  },
  find_symbol: {
    readOnly: true,
    spec: {
      type: 'function',
      function: {
        name: 'find_symbol',
        description: 'Find where a function/class/type/macro is defined and which files depend on that file.',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      },
    },
    async run(a, ctx) {
      if (!ctx.index) return { output: 'İndeks yok.', isError: true };
      const hits = ctx.index.findSymbol(str(a.name, 'name'));
      if (!hits.length) return { output: 'Tanım bulunamadı.' };
      return {
        output: hits
          .map((h) => {
            const users = ctx.index!.dependents(h.path).slice(0, 6).map((d) => d.path);
            return `${h.path}:${h.def.line} [${h.def.kind}] ${h.def.signature}${users.length ? `\n   kullananlar: ${users.join(', ')}` : ''}`;
          })
          .join('\n'),
      };
    },
  },
  repo_map: {
    readOnly: true,
    spec: {
      type: 'function',
      function: {
        name: 'repo_map',
        description: 'Ranked map of the most relevant files and their definitions, optionally focused on files/identifiers.',
        parameters: {
          type: 'object',
          properties: { focus_files: { type: 'array', items: { type: 'string' } }, focus_identifiers: { type: 'array', items: { type: 'string' } }, max_tokens: { type: 'integer' } },
          required: [],
        },
      },
    },
    async run(a, ctx) {
      if (!ctx.index) return { output: 'İndeks yok.', isError: true };
      const files = Array.isArray(a.focus_files) ? (a.focus_files as string[]) : [];
      const ids = Array.isArray(a.focus_identifiers) ? (a.focus_identifiers as string[]) : [];
      return { output: ctx.index.repoMap(optNum(a.max_tokens) ?? 1500, { files, identifiers: ids }) };
    },
  },
  write_file: {
    readOnly: false,
    spec: {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create a new file or completely overwrite an existing one. Prefer edit_file for small changes.',
        parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      },
    },
    async run(a, ctx) {
      const path = safeRelPath(ctx.root, str(a.path, 'path'));
      const content = str(a.content, 'content');
      const before = ctx.overlay.read(path);
      const blocked = guardUnread(path, ctx, 'üzerine yazmadan');
      if (blocked) return blocked;
      ctx.overlay.write(path, content);
      ctx.writtenFiles?.add(path);
      ctx.bus?.emitEvent('tool.write', { source: ctx.workerId, data: { path } });
      const warn = postEditCheck(path, before, content);
      return { output: `${before !== undefined ? 'Güncellendi' : 'Oluşturuldu'}: ${path} (${content.split('\n').length} satır)${warn ? '\n' + warn : ''}` };
    },
  },
  edit_file: {
    readOnly: false,
    spec: {
      type: 'function',
      function: {
        name: 'edit_file',
        description: 'Replace an exact snippet in a file. old_text must match the file (copy it from read_file without line numbers) and be unique unless replace_all=true.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } },
          required: ['path', 'old_text', 'new_text'],
        },
      },
    },
    async run(a, ctx) {
      const r = resolveExisting(ctx, safeRelPath(ctx.root, str(a.path, 'path')));
      const path = r.path;
      const cur = ctx.overlay.read(path);
      const oldText = str(a.old_text, 'old_text');
      const newText = str(a.new_text, 'new_text');
      if (cur === undefined && oldText.trim()) return { output: `Dosya yok: ${path}. Yeni dosya için write_file kullanın.`, isError: true };
      if (oldText === newText) return { output: 'old_text ve new_text aynı; değişiklik yok.', isError: true };
      // old_text must match the real content exactly, which already proves the model knows the file
      // (Aider SEARCH/REPLACE); only a file whose previous edit missed must be re-read first.
      const blocked = ctx.staleFiles?.has(path) ? guardUnread(path, ctx, 'düzenlemeden') : undefined;
      if (blocked) return blocked;
      try {
        const next = applyReplacement(cur ?? '', oldText, newText, { replaceAll: !!a.replace_all, path });
        ctx.overlay.write(path, next);
        ctx.writtenFiles?.add(path);
        ctx.bus?.emitEvent('tool.edit', { source: ctx.workerId, data: { path } });
        const warn = postEditCheck(path, cur, next);
        return { output: `${r.note}Düzenlendi: ${path}${warn ? '\n' + warn : ''}` };
      } catch (e) {
        if (e instanceof EditError) {
          // OMO edit-error-recovery: force a re-read before the next attempt
          if (ctx.readFiles && ctx.config.tools.requireReadBeforeEdit) ctx.staleFiles?.add(path);
          return { output: `${e.message}\nÖnce dosyayı read_file ile yeniden okuyun; varsayımınız dosyanın gerçek içeriğiyle uyuşmuyor.`, isError: true };
        }
        throw e;
      }
    },
  },
  delete_file: {
    readOnly: false,
    spec: {
      type: 'function',
      function: { name: 'delete_file', description: 'Delete a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    },
    async run(a, ctx) {
      const path = safeRelPath(ctx.root, str(a.path, 'path'));
      if (ctx.overlay.read(path) === undefined) return { output: `Dosya yok: ${path}`, isError: true };
      const blocked = guardUnread(path, ctx, 'silmeden');
      if (blocked) return blocked;
      ctx.overlay.delete(path);
      ctx.writtenFiles?.add(path);
      return { output: `Silindi: ${path}` };
    },
  },
  run_command: {
    readOnly: false,
    spec: {
      type: 'function',
      function: {
        name: 'run_command',
        description: 'Run a shell command (build, tests, linters, scripts) in the project root with your pending changes applied. Non-interactive only.',
        parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_sec: { type: 'integer' } }, required: ['command'] },
      },
    },
    async run(a, ctx) {
      const cmd = str(a.command, 'command');
      if (!ctx.config.tools.allowCommands) return { output: 'Komut çalıştırma yapılandırmada kapalı.', isError: true };
      for (const pat of ctx.config.tools.denyPatterns) {
        if (new RegExp(pat, 'i').test(cmd)) return { output: `Komut güvenlik kuralı nedeniyle reddedildi (${pat}).`, isError: true };
      }
      const timeout = Math.min(ctx.config.tools.commandTimeoutMs, (optNum(a.timeout_sec) ?? 600) * 1000);
      ctx.bus?.emitEvent('tool.command', { source: ctx.workerId, message: cmd });
      const r = await ctx.materializer.withApplied(ctx.overlay, () => runShell(cmd, ctx.root, timeout, ctx.signal), ctx.signal);
      const status = r.timedOut ? 'ZAMAN AŞIMI' : `çıkış kodu ${r.code}`;
      return { output: `$ ${cmd}\n[${status}]\n${truncateMiddle(r.output, 12_000)}`, isError: r.code !== 0 };
    },
  },
  skill: {
    readOnly: true,
    spec: {
      type: 'function',
      function: {
        name: 'skill',
        description: 'Load a project skill (specialised procedure) by name and follow its instructions. Call it BEFORE doing work that matches a skill description.',
        parameters: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'string', description: 'optional arguments for the skill' } }, required: ['name'] },
      },
    },
    async run(a, ctx) {
      const reg = ctx.skills;
      if (!reg || reg.size === 0) return { output: 'Bu projede skill yok.', isError: true };
      const s = reg.get(str(a.name, 'name'));
      const available = reg.visible().map((x) => x.name).join(', ') || '-';
      if (!s) return { output: `Skill bulunamadı: ${a.name}. Mevcut skill'ler: ${available}`, isError: true };
      if (s.hidden && !ctx.explicitSkills?.has(s.name)) return { output: `"${s.name}" yalnızca kullanıcı açıkça seçtiğinde kullanılabilir.`, isError: true };
      if (ctx.loadedSkills?.has(s.name)) return { output: `"${s.name}" zaten yüklü; talimatlarını izlemeye devam edin.` };
      ctx.loadedSkills?.add(s.name);
      ctx.bus?.emitEvent('skill.load', { source: ctx.workerId, data: { name: s.name, how: 'tool' } });
      return { output: reg.render(s, typeof a.args === 'string' ? a.args : undefined) };
    },
  },
  skill_file: {
    readOnly: true,
    spec: {
      type: 'function',
      function: {
        name: 'skill_file',
        description: 'Read a supporting file (references/, scripts/, assets/ …) that belongs to a skill.',
        parameters: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' } }, required: ['name', 'path'] },
      },
    },
    async run(a, ctx) {
      const s = ctx.skills?.get(str(a.name, 'name'));
      if (!s) return { output: `Skill bulunamadı: ${a.name}`, isError: true };
      return { output: `${s.name}/${a.path}\n${ctx.skills!.readFile(s, str(a.path, 'path'))}` };
    },
  },
  finish: {
    readOnly: true,
    spec: {
      type: 'function',
      function: {
        name: 'finish',
        description: 'Call when the task is complete (or truly blocked). Give a concise summary of what you changed and how you verified it.',
        parameters: { type: 'object', properties: { summary: { type: 'string' }, status: { type: 'string', enum: ['done', 'blocked'] } }, required: ['summary'] },
      },
    },
    async run(a) {
      const status = a.status === 'blocked' ? 'blocked' : 'done';
      return { output: 'tamam', finished: { summary: typeof a.summary === 'string' ? a.summary : '', status } };
    },
  },
};

export const READ_ONLY_TOOLS = Object.entries(TOOLS).filter(([, t]) => t.readOnly).map(([n]) => n);
export const ALL_TOOLS = Object.keys(TOOLS);

export function toolSpecs(allowed?: Set<string>, opts: { skills?: boolean } = {}): ToolSpec[] {
  return Object.entries(TOOLS)
    .filter(([n]) => !allowed || allowed.has(n))
    .filter(([n]) => opts.skills !== false || (n !== 'skill' && n !== 'skill_file'))
    .map(([, t]) => t.spec);
}

export async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const def = TOOLS[name];
  if (!def) return { output: `Bilinmeyen araç: ${name}. Kullanılabilir: ${[...(ctx.allowed ?? new Set(ALL_TOOLS))].join(', ')}`, isError: true };
  if (ctx.allowed && !ctx.allowed.has(name)) return { output: `Bu çalışan için izin verilmeyen araç: ${name}`, isError: true };
  try {
    return await def.run(args, ctx);
  } catch (e) {
    return { output: `Araç hatası (${name}): ${(e as Error).message}`, isError: true };
  }
}

/** Human-readable tool catalogue for prompt-based tool calling. */
export function toolCatalogue(allowed?: Set<string>, opts: { skills?: boolean } = {}): string {
  return toolSpecs(allowed, opts)
    .map((s) => {
      const props = (s.function.parameters as { properties?: Record<string, { type?: string }>; required?: string[] }).properties ?? {};
      const req = new Set((s.function.parameters as { required?: string[] }).required ?? []);
      const args = Object.entries(props).map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${v.type ?? 'any'}`).join(', ');
      return `- ${s.function.name}(${args}) — ${s.function.description}`;
    })
    .join('\n');
}
