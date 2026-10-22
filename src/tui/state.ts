import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { kurultayHome } from '../config.js';
import type { Suggestion } from './editor.js';

/** Per-user console state: recent workspaces and input history (~/.kurultay/console.json). */
export interface ConsoleState {
  recent: Array<{ path: string; lastUsed: string }>;
  history: string[];
}

function file(): string {
  return join(kurultayHome(), 'console.json');
}

export function loadState(): ConsoleState {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<ConsoleState>;
    return {
      recent: Array.isArray(raw.recent) ? raw.recent.filter((r) => r && typeof r.path === 'string') : [],
      history: Array.isArray(raw.history) ? raw.history.filter((h) => typeof h === 'string') : [],
    };
  } catch {
    return { recent: [], history: [] };
  }
}

export function saveState(s: ConsoleState): void {
  try {
    mkdirSync(dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify({ recent: s.recent.slice(0, 15), history: s.history.slice(-500) }, null, 2));
  } catch {
    /* state is a convenience; never fail the console because of it */
  }
}

export function rememberWorkspace(s: ConsoleState, path: string): void {
  s.recent = [{ path, lastUsed: new Date().toISOString() }, ...s.recent.filter((r) => r.path !== path)].slice(0, 15);
}

export function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(2)) : p;
}

/** Validate a workspace path. Returns the absolute path or an error message. */
export function checkWorkspace(input: string, cwd: string): { path?: string; error?: string } {
  const raw = input.trim().replace(/^["']|["']$/g, '');
  if (!raw) return { error: 'Bir klasör yolu girin.' };
  const p = resolve(cwd, expandHome(raw));
  if (!existsSync(p)) return { error: `Klasör bulunamadı: ${p}` };
  if (!statSync(p).isDirectory()) return { error: `Bu bir klasör değil: ${p}` };
  if (p === dirname(p)) return { error: 'Dosya sisteminin kökü çalışma alanı olamaz.' };
  if (p === homedir()) return { error: 'Ev klasörünün tamamı çalışma alanı olamaz; proje klasörünü seçin.' };
  return { path: p };
}

/** Does this folder look like a software project? (for the "use current folder" hint) */
export function looksLikeProject(dir: string): boolean {
  try {
    const names = readdirSync(dir);
    return names.some((n) => /^(\.git|package\.json|CMakeLists\.txt|Makefile|pom\.xml|build\.gradle(\.kts)?|Cargo\.toml|go\.mod|pyproject\.toml|setup\.py|meson\.build|.*\.sln|kurultay\.config\.json|src)$/.test(n));
  } catch {
    return false;
  }
}

/** Directory completion for a partially typed path. */
export function completePath(partial: string, cwd: string, dirsOnly = true): Suggestion[] {
  const expanded = expandHome(partial);
  const slash = Math.max(expanded.lastIndexOf('/'), expanded.lastIndexOf(sep));
  const dirPart = slash >= 0 ? expanded.slice(0, slash + 1) : '';
  const prefix = expanded.slice(slash + 1);
  const dir = resolve(cwd, dirPart || '.');
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const typedBase = partial.slice(0, partial.length - prefix.length);
  const isDir = (n: string) => {
    try {
      return statSync(join(dir, n)).isDirectory();
    } catch {
      return false;
    }
  };
  return names
    .filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase()) && (!n.startsWith('.') || prefix.startsWith('.')))
    .map((n) => ({ n, dir: isDir(n) }))
    .filter((x) => x.dir || !dirsOnly)
    .sort((a, b) => a.n.localeCompare(b.n))
    .slice(0, 50)
    .map((x) => ({ value: `${typedBase}${x.n}${x.dir ? '/' : ''}`, label: `${x.n}${x.dir ? '/' : ''}` }));
}

export function shortPath(p: string): string {
  const h = homedir();
  return isAbsolute(p) && (p === h || p.startsWith(h + sep)) ? '~' + p.slice(h.length) : p;
}
