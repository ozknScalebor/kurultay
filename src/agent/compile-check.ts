import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { runShell } from './tools.js';
import type { Materializer, Overlay } from './workspace.js';

/**
 * Compiler-backed check right after an edit (Aider lint-after-edit, Serena/Crush
 * LSP diagnostics – done offline with the compilers already on the machine):
 *
 *  - C/C++: `-fsyntax-only` with the exact flags from compile_commands.json when
 *    the project has one; otherwise the local compiler with common include dirs.
 *  - Java: `javac -sourcepath <source root>` (Java 8 compatible flags).
 *  - Anything else: a configured command per extension ("{file}" placeholder).
 *
 * Only errors located in the edited file are reported, and "header not found"
 * style environment problems are ignored – the goal is to catch the model's
 * own mistakes immediately, not to require a fully configured build.
 */

export type SyntaxCheckConfig = 'auto' | 'off' | Record<string, string>;

const C_EXT = new Set(['.c']);
const CXX_EXT = new Set(['.cc', '.cpp', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h', '.ipp', '.tpp']);
const HEADER_EXT = new Set(['.h', '.hh', '.hpp', '.hxx', '.ipp', '.tpp']);
/** Errors that stay meaningful when some headers were replaced by empty stubs. */
const SYNTAX_ONLY = /expected|stray|missing terminating|unterminated|extraneous|before .* token|unbalanced|#error/;

const toolCache = new Map<string, boolean>();
export function hasTool(cmd: string): boolean {
  if (!toolCache.has(cmd)) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'ignore', timeout: 5000 });
      toolCache.set(cmd, true);
    } catch {
      toolCache.set(cmd, false);
    }
  }
  return toolCache.get(cmd)!;
}

interface CompileEntry {
  directory: string;
  file: string;
  command?: string;
  arguments?: string[];
}

/** compile_commands.json in the usual places (root, build dirs). */
export function findCompileCommands(root: string): { path: string; entries: CompileEntry[] } | undefined {
  const candidates = ['compile_commands.json', 'build/compile_commands.json', 'out/compile_commands.json', 'cmake-build-debug/compile_commands.json', 'cmake-build-release/compile_commands.json', 'build/debug/compile_commands.json', 'build/release/compile_commands.json'];
  for (const c of candidates) {
    const p = join(root, c);
    if (!existsSync(p)) continue;
    try {
      const entries = JSON.parse(readFileSync(p, 'utf8')) as CompileEntry[];
      if (Array.isArray(entries) && entries.length) return { path: p, entries };
    } catch {
      /* broken file → ignore */
    }
  }
  return undefined;
}

/**
 * Split a shell command line (enough for compile_commands "command" strings).
 * On Windows a backslash is a path separator, not an escape (except before a quote).
 */
export function splitCommand(cmd: string, windows = process.platform === 'win32'): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  let any = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) {
      if (ch === q) q = null;
      else if (ch === '\\' && q === '"' && i + 1 < cmd.length && (!windows || cmd[i + 1] === '"')) cur += cmd[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      any = true;
    } else if (/\s/.test(ch)) {
      if (cur || any) out.push(cur);
      cur = '';
      any = false;
    } else if (ch === '\\' && i + 1 < cmd.length && (!windows || cmd[i + 1] === '"')) cur += cmd[++i];
    else cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

/** Turn a compile command into a syntax-only check of `file` (paths remapped into `cwdRoot`). */
export function syntaxOnlyArgs(entry: CompileEntry, root: string, cwdRoot: string, file: string): { cmd: string; args: string[]; cwd: string } {
  // paths may be bare or glued to a flag (-I/p/inc, -isystem/p/x, --sysroot=/p)
  const remap = (p: string) => {
    const m = /^(-[A-Za-z-]+=?)?(.*)$/s.exec(p)!;
    const [pre = '', rest] = [m[1], m[2]];
    if (rest === root || rest.startsWith(root + '/') || rest.startsWith(root + '\\')) return pre + cwdRoot + rest.slice(root.length);
    return p;
  };
  const argv = (entry.arguments?.length ? entry.arguments : splitCommand(entry.command ?? '')).map(remap);
  const [cmd, ...rest] = argv;
  const args: string[] = [];
  const entryFile = remap(isAbsolute(entry.file) ? entry.file : resolve(entry.directory, entry.file));
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-o' || a === '-MF' || a === '-MT' || a === '-MQ') {
      i++;
      continue;
    }
    if (a === '-c' || a === '-MD' || a === '-MMD' || a.startsWith('-o') && a.length > 2) continue;
    const abs = isAbsolute(a) ? a : resolve(remap(entry.directory), a);
    if (abs === entryFile || a === entry.file) continue; // the TU is passed explicitly below
    args.push(a);
  }
  args.push('-fsyntax-only', file);
  return { cmd, args, cwd: remap(entry.directory) };
}

/** Keep only compiler errors that point at the edited file and are not environment problems. */
export function relevantErrors(output: string, file: string, lang: 'c' | 'java'): string[] {
  const name = basename(file);
  const rel = file.split('\\').join('/');
  const esc = name.replace(/[.+]/g, '\\$&');
  const lines = output.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    // absolute / sandbox / 8.3 paths → the project-relative path; another file with the same name is skipped
    const at = new RegExp(`^(.*?)${esc}:\\d`).exec(l);
    if (at && at[1]) {
      const full = `${at[1]}${name}`.split('\\').join('/');
      if (!full.endsWith(`/${rel}`) && full !== rel) continue;
      l = rel + l.slice(at[1].length + name.length);
    }
    const isErr = lang === 'java' ? new RegExp(`${name.replace(/[.]/g, '\\.')}:\\d+: error:`).test(l) : new RegExp(`${name.replace(/[.+]/g, '\\$&')}:\\d+(:\\d+)?: (fatal )?error:`).test(l);
    if (!isErr) continue;
    if (/file not found|No such file or directory|cannot open source file/i.test(l)) continue;
    if (lang === 'java' && /package .* does not exist|cannot access /.test(l)) continue;
    // keep the error with its source excerpt (the indented lines that follow)
    const ctx = lines.slice(i + 1, i + 3).filter((x) => /^\s/.test(x) && !/error:/.test(x));
    out.push([l, ...ctx].join('\n'));
  }
  return out;
}

/** Java source root from the package declaration (…/src/main/java for com.x.Y). */
export function javaSourceRoot(file: string, content: string): string {
  const pkg = content.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
  let dir = dirname(file);
  if (pkg) for (let i = 0; i < pkg.split('.').length; i++) dir = dirname(dir);
  return dir;
}

export interface SyntaxCheckResult {
  checked: boolean;
  tool?: string;
  errors: string[];
}

/**
 * Check one edited file inside the worker's sandbox view. Never throws; a
 * missing compiler or timeout just means "not checked".
 */
export async function syntaxCheck(path: string, overlay: Overlay, materializer: Materializer, cfg: SyntaxCheckConfig, signal?: AbortSignal): Promise<SyntaxCheckResult> {
  if (cfg === 'off') return { checked: false, errors: [] };
  const ext = extname(path).toLowerCase();
  const root = materializer.root;
  try {
    if (typeof cfg === 'object') {
      const tpl = cfg[ext] ?? cfg[ext.slice(1)];
      if (!tpl) return { checked: false, errors: [] };
      return await materializer.execute(
        overlay,
        async (cwd) => {
          const r = await runShell(tpl.split('{file}').join(path), cwd, 60_000, signal);
          return { checked: true, tool: tpl.split(/\s+/)[0], errors: r.code === 0 ? [] : [materializer.rewriteOutput(r.output).trim().split('\n').slice(0, 20).join('\n')] };
        },
        signal,
      );
    }
    if (C_EXT.has(ext) || CXX_EXT.has(ext)) return await checkC(path, ext, overlay, materializer, root, signal);
    if (ext === '.java') return await checkJava(path, overlay, materializer, signal);
  } catch {
    return { checked: false, errors: [] };
  }
  return { checked: false, errors: [] };
}

async function checkC(path: string, ext: string, overlay: Overlay, materializer: Materializer, root: string, signal?: AbortSignal): Promise<SyntaxCheckResult> {
  const db = findCompileCommands(root);
  const isHeader = HEADER_EXT.has(ext);
  return materializer.execute(
    overlay,
    async (cwd) => {
      const abs = join(cwd, path);
      let cmd: string;
      let args: string[];
      let dir = cwd;
      let entry: CompileEntry | undefined;
      if (db) {
        const target = resolve(root, path);
        entry = db.entries.find((e) => resolve(e.directory, e.file) === target);
        // a header: check it through a translation unit that includes it
        if (!entry && isHeader) {
          const name = basename(path);
          entry = db.entries.find((e) => {
            const tu = relative(root, resolve(e.directory, e.file)).split('\\').join('/');
            const src = overlay.read(tu) ?? '';
            return new RegExp(`#\\s*include\\s*[<"]([^>"]*/)?${name.replace(/[.]/g, '\\.')}[>"]`).test(src);
          });
        }
      }
      if (entry) {
        const tuAbs = join(cwd, relative(root, resolve(entry.directory, entry.file)));
        ({ cmd, args, cwd: dir } = syntaxOnlyArgs(entry, root, cwd, tuAbs));
        mkdirSync(dir, { recursive: true }); // build dirs are not copied into sandboxes
      } else {
        const cxx = CXX_EXT.has(ext) && !(ext === '.h' && !isCppHeaderContent(overlay.read(path) ?? ''));
        const candidates = cxx ? ['c++', 'g++', 'clang++'] : ['cc', 'gcc', 'clang'];
        const found = candidates.find(hasTool);
        if (!found) return { checked: false, errors: [] };
        cmd = found;
        const inc = [dirname(abs), cwd, join(cwd, 'include'), join(cwd, 'src'), join(cwd, 'inc')].filter((d) => existsSync(d)).map((d) => `-I${d}`);
        args = [...(cxx ? ['-std=c++17', '-x', 'c++'] : ['-std=c11']), ...inc, '-fsyntax-only', abs];
        if (isHeader && !cxx) args.splice(args.length - 2, 0, '-x', 'c-header');
      }
      // A missing header is a *fatal* error: the compiler stops before reaching the
      // model's code. Replace missing headers with empty stubs and retry; with stubs
      // in play only pure syntax errors are trusted (undeclared names are expected).
      const stubDir = mkdtempSync(join(tmpdir(), 'kurultay-stub-'));
      let stubbed = 0;
      try {
        for (let round = 0; ; round++) {
          const allArgs = stubbed ? [...args.slice(0, -2), `-I${stubDir}`, ...args.slice(-2)] : args;
          const r = await runShell([cmd, ...allArgs].map(shellQuote).join(' '), dir, 30_000, signal);
          if (r.timedOut) return { checked: false, errors: [] };
          const output = materializer.rewriteOutput(r.output);
          // gcc: "fatal error: x.h: No such file or directory", clang: "fatal error: 'x.h' file not found"
          const missing = [...output.matchAll(/fatal error: '?([^\s:']+)'?:? (?:No such file or directory|file not found)/g)].map((x) => x[1]).filter((h) => !h.includes('..') && !isAbsolute(h));
          if (missing.length && round < 8) {
            let added = false;
            for (const h of missing) {
              const p = join(stubDir, h);
              if (existsSync(p)) continue;
              mkdirSync(dirname(p), { recursive: true });
              writeFileSync(p, '');
              added = true;
              stubbed++;
            }
            if (added) continue;
          }
          let errors = relevantErrors(output, path, 'c');
          if (stubbed) errors = errors.filter((e) => SYNTAX_ONLY.test(e.split('\n')[0]));
          return { checked: true, tool: `${basename(cmd)}${entry ? ' (compile_commands.json)' : ''}`, errors };
        }
      } finally {
        rmSync(stubDir, { recursive: true, force: true });
      }
    },
    signal,
  );
}

function isCppHeaderContent(s: string): boolean {
  return /\b(class|namespace|template\s*<|std::|public:|private:|nullptr|constexpr)\b/.test(s);
}

async function checkJava(path: string, overlay: Overlay, materializer: Materializer, signal?: AbortSignal): Promise<SyntaxCheckResult> {
  if (!hasTool('javac')) return { checked: false, errors: [] };
  return materializer.execute(
    overlay,
    async (cwd) => {
      const abs = join(cwd, path);
      const srcRoot = javaSourceRoot(abs, overlay.read(path) ?? '');
      const out = mkdtempSync(join(tmpdir(), 'kurultay-javac-'));
      const libs = ['lib', 'libs'].map((d) => join(cwd, d)).filter((d) => existsSync(d));
      const cp = libs.length ? ['-cp', libs.map((d) => join(d, '*')).join(process.platform === 'win32' ? ';' : ':')] : [];
      try {
        const args = ['-proc:none', '-nowarn', '-encoding', 'UTF-8', '-d', out, '-sourcepath', srcRoot, ...cp, abs];
        const r = await runShell(['javac', ...args].map(shellQuote).join(' '), cwd, 60_000, signal);
        if (r.timedOut) return { checked: false, errors: [] };
        return { checked: true, tool: 'javac', errors: relevantErrors(materializer.rewriteOutput(r.output), path, 'java') };
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },
    signal,
  );
}

function shellQuote(s: string): string {
  if (/^[\w@%+=:,./\\-]+$/.test(s)) return s;
  return process.platform === 'win32' ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Text appended to edit tool results. */
export function renderSyntaxResult(path: string, r: SyntaxCheckResult): string {
  if (!r.checked || !r.errors.length) return '';
  return `⚠ ${r.tool} ${path} için derleme hatası buldu (düzeltin):\n${r.errors.slice(0, 8).join('\n')}`;
}
