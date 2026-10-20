import { spawn } from 'node:child_process';
import type { KurultayConfig } from '../config.js';
import type { ProjectIndex } from '../index/project-index.js';
import type { ToolSpec } from '../llm/types.js';
import type { EventBus } from '../util/events.js';
import { truncateMiddle } from '../util/text.js';
import { EditError, applyReplacement } from './edits.js';
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
      const path = safeRelPath(ctx.root, str(a.path, 'path'));
      const content = ctx.overlay.read(path);
      if (content === undefined) return { output: `Dosya yok: ${path}`, isError: true };
      const total = content.split('\n').length;
      const start = optNum(a.start_line) ?? 1;
      const end = optNum(a.end_line) ?? Math.min(total, start + 399);
      const body = numbered(content, start, end);
      const more = end < total ? `\n… (${total} satırın ${start}-${end} arası gösterildi; devamı için start_line=${end + 1})` : '';
      return { output: `${path} (${total} satır)\n${body}${more}` };
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
      const existed = ctx.overlay.read(path) !== undefined;
      ctx.overlay.write(path, content);
      ctx.bus?.emitEvent('tool.write', { source: ctx.workerId, data: { path } });
      return { output: `${existed ? 'Güncellendi' : 'Oluşturuldu'}: ${path} (${content.split('\n').length} satır)` };
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
      const path = safeRelPath(ctx.root, str(a.path, 'path'));
      const cur = ctx.overlay.read(path);
      const oldText = str(a.old_text, 'old_text');
      if (cur === undefined && oldText.trim()) return { output: `Dosya yok: ${path}. Yeni dosya için write_file kullanın.`, isError: true };
      try {
        const next = applyReplacement(cur ?? '', oldText, str(a.new_text, 'new_text'), { replaceAll: !!a.replace_all, path });
        ctx.overlay.write(path, next);
        ctx.bus?.emitEvent('tool.edit', { source: ctx.workerId, data: { path } });
        return { output: `Düzenlendi: ${path}` };
      } catch (e) {
        if (e instanceof EditError) return { output: e.message, isError: true };
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
      ctx.overlay.delete(path);
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

export function toolSpecs(allowed?: Set<string>): ToolSpec[] {
  return Object.entries(TOOLS)
    .filter(([n]) => !allowed || allowed.has(n))
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
export function toolCatalogue(allowed?: Set<string>): string {
  return toolSpecs(allowed)
    .map((s) => {
      const props = (s.function.parameters as { properties?: Record<string, { type?: string }>; required?: string[] }).properties ?? {};
      const req = new Set((s.function.parameters as { required?: string[] }).required ?? []);
      const args = Object.entries(props).map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${v.type ?? 'any'}`).join(', ');
      return `- ${s.function.name}(${args}) — ${s.function.description}`;
    })
    .join('\n');
}
