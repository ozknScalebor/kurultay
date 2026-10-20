import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

export const LANG_BY_EXT: Record<string, string> = {
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp', '.ipp': 'cpp', '.inl': 'cpp',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala', '.cs': 'csharp',
  '.py': 'python', '.pyi': 'python',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript',
  '.go': 'go', '.rs': 'rust', '.swift': 'swift', '.m': 'objc', '.mm': 'objc',
  '.rb': 'ruby', '.php': 'php', '.lua': 'lua', '.sh': 'shell', '.bash': 'shell', '.ps1': 'powershell',
  '.cmake': 'cmake', '.mk': 'make', '.gradle': 'gradle', '.proto': 'proto', '.sql': 'sql',
  '.yaml': 'yaml', '.yml': 'yaml', '.json': 'json', '.toml': 'toml', '.xml': 'xml', '.ini': 'ini', '.cfg': 'ini',
  '.md': 'markdown', '.rst': 'rst', '.txt': 'text', '.qml': 'qml', '.ui': 'xml', '.dts': 'devicetree', '.dtsi': 'devicetree',
  '.vhd': 'vhdl', '.vhdl': 'vhdl', '.v': 'verilog', '.sv': 'verilog', '.asm': 'asm', '.s': 'asm', '.S': 'asm',
};

const NAME_LANG: Record<string, string> = {
  Makefile: 'make', makefile: 'make', 'CMakeLists.txt': 'cmake', Dockerfile: 'docker', Kconfig: 'kconfig', 'pom.xml': 'xml', 'build.gradle': 'gradle',
};

export const CODE_LANGS = new Set(['c', 'cpp', 'java', 'kotlin', 'scala', 'csharp', 'python', 'javascript', 'typescript', 'go', 'rust', 'swift', 'objc', 'ruby', 'php', 'lua', 'shell', 'qml', 'vhdl', 'verilog', 'proto', 'sql']);

const DEFAULT_IGNORES = [
  '.git', '.hg', '.svn', '.kurultay', 'node_modules', 'bower_components', 'vendor/bundle', 'dist', 'build', 'out', 'target', 'obj',
  '.gradle', '.idea', '.vscode', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', 'coverage', '.next', '.cache',
  'cmake-build-debug', 'cmake-build-release', 'CMakeFiles', '.ccls-cache', '.clangd', 'kurultay.config.json',
];

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.pdf', '.zip', '.gz', '.tgz', '.xz', '.7z', '.rar', '.jar', '.war', '.class', '.o', '.a', '.so', '.dll', '.exe', '.lib', '.obj', '.bin', '.elf', '.hex', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.wav', '.avi', '.mov', '.onnx', '.pt', '.gguf', '.safetensors', '.db', '.sqlite', '.pyc', '.lock']);

export interface ScannedFile {
  path: string; // posix relative path
  abs: string;
  lang: string;
  size: number;
  mtimeMs: number;
}

export interface ScanOptions {
  include?: string[];
  exclude?: string[];
  maxFileBytes?: number;
}

/** Convert a simple glob (*, **, ?) to a RegExp over posix paths. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim();
  if (!g) return /^$/;
  const anchored = g.startsWith('/');
  if (anchored) g = g.slice(1);
  const dirOnly = g.endsWith('/');
  if (dirOnly) g = g.slice(0, -1);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*';
        i++;
        if (g[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const prefix = anchored || g.includes('/') ? '^' : '(^|.*/)';
  return new RegExp(`${prefix}${re}(/.*)?$`);
}

function readGitignore(root: string): RegExp[] {
  const p = join(root, '.gitignore');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
    .map(globToRegExp);
}

export function isProbablyBinary(abs: string): boolean {
  if (BINARY_EXT.has(extname(abs).toLowerCase())) return true;
  let fd: number | undefined;
  try {
    fd = openSync(abs, 'r');
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
  } catch {
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function langOf(path: string): string | undefined {
  const base = path.split('/').pop() ?? path;
  return NAME_LANG[base] ?? LANG_BY_EXT[extname(base)] ?? LANG_BY_EXT[extname(base).toLowerCase()];
}

function gitListFiles(root: string): string[] | undefined {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.toString('utf8').split('\0').filter(Boolean);
  } catch {
    return undefined;
  }
}

/** List indexable source files under root (git-aware, .gitignore-aware). */
export function scanProject(root: string, opts: ScanOptions = {}): ScannedFile[] {
  const maxBytes = opts.maxFileBytes ?? 512 * 1024;
  const excludes = [...DEFAULT_IGNORES.map((d) => globToRegExp(d + '/')), ...(opts.exclude ?? []).map(globToRegExp)];
  const includes = (opts.include ?? []).map(globToRegExp);
  const accept = (rel: string): boolean => {
    if (excludes.some((r) => r.test(rel))) return false;
    if (includes.length && !includes.some((r) => r.test(rel))) return false;
    return true;
  };

  let rels: string[] = gitListFiles(root) ?? [];
  if (!rels.length) {
    const ignores = readGitignore(root);
    const walk = (dir: string) => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = join(dir, e.name);
        const rel = relative(root, abs).split(sep).join('/');
        if (e.isDirectory()) {
          if (DEFAULT_IGNORES.includes(e.name) || ignores.some((r) => r.test(rel + '/'))) continue;
          walk(abs);
        } else if (e.isFile()) {
          if (ignores.some((r) => r.test(rel))) continue;
          rels.push(rel);
        }
      }
    };
    walk(root);
  }

  const out: ScannedFile[] = [];
  for (const rel of rels) {
    if (!accept(rel)) continue;
    const lang = langOf(rel);
    if (!lang) continue;
    const abs = join(root, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue; // deleted but still in git index
    }
    if (!st.isFile() || st.size === 0 || st.size > maxBytes) continue;
    if (isProbablyBinary(abs)) continue;
    out.push({ path: rel, abs, lang, size: st.size, mtimeMs: st.mtimeMs });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
