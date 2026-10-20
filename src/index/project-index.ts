import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readProjectFile } from '../agent/workspace.js';
import { estimateTokens } from '../util/text.js';
import { Bm25Index, chunkFile, type Chunk } from './bm25.js';
import { buildGraph, pageRank, type Edge } from './graph.js';
import { CODE_LANGS, scanProject, type ScanOptions } from './scanner.js';
import { extractSymbols, type SymbolDef } from './symbols.js';

export interface IndexedFile {
  path: string;
  lang: string;
  size: number;
  lines: number;
  hash: string;
  mtimeMs: number;
  defs: SymbolDef[];
  refs: Record<string, number>;
  imports: string[];
  /** LLM-written summary (filled by the summarizer) */
  summary?: string;
  summaryHash?: string;
  summaryModel?: string;
}

export interface IndexData {
  version: 1;
  root: string;
  builtAt: string;
  files: IndexedFile[];
  edges: Edge[];
  ranks: Record<string, number>;
}

export interface ModuleGroup {
  name: string; // directory path ('' = root)
  files: string[];
}

export function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

/**
 * Project index: file list, symbols, dependency graph, PageRank, BM25 search,
 * repo map. Persisted under <stateDir>/index/index.json and updated incrementally.
 */
export class ProjectIndex {
  data: IndexData;
  private bm25?: Bm25Index;
  private byPath = new Map<string, IndexedFile>();

  constructor(
    readonly root: string,
    readonly stateDir: string,
    data?: IndexData,
  ) {
    this.data = data ?? { version: 1, root, builtAt: '', files: [], edges: [], ranks: {} };
    this.reindexMaps();
  }

  static indexPath(stateDir: string): string {
    return join(stateDir, 'index', 'index.json');
  }

  static load(root: string, stateDir: string): ProjectIndex | undefined {
    const p = ProjectIndex.indexPath(stateDir);
    if (!existsSync(p)) return undefined;
    try {
      const data = JSON.parse(readFileSync(p, 'utf8')) as IndexData;
      if (data.version !== 1) return undefined;
      return new ProjectIndex(root, stateDir, data);
    } catch {
      return undefined;
    }
  }

  private reindexMaps(): void {
    this.byPath = new Map(this.data.files.map((f) => [f.path, f]));
    this.bm25 = undefined;
  }

  save(): void {
    const p = ProjectIndex.indexPath(this.stateDir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(this.data));
  }

  get files(): IndexedFile[] {
    return this.data.files;
  }

  file(path: string): IndexedFile | undefined {
    return this.byPath.get(path);
  }

  /** (Re)build the index; unchanged files (same hash) keep their symbols and summaries. */
  build(opts: ScanOptions = {}): { added: number; changed: number; removed: number; total: number } {
    const scanned = scanProject(this.root, opts);
    const prev = this.byPath;
    const next: IndexedFile[] = [];
    let added = 0;
    let changed = 0;
    for (const s of scanned) {
      const old = prev.get(s.path);
      if (old && old.mtimeMs === s.mtimeMs && old.size === s.size) {
        next.push(old);
        continue;
      }
      let content: string;
      try {
        content = readFileSync(s.abs, 'utf8');
      } catch {
        continue;
      }
      const hash = sha1(content);
      if (old && old.hash === hash) {
        next.push({ ...old, mtimeMs: s.mtimeMs });
        continue;
      }
      const sym = CODE_LANGS.has(s.lang) ? extractSymbols(content, s.lang) : { defs: [], refs: {}, imports: [] };
      next.push({
        path: s.path,
        lang: s.lang,
        size: s.size,
        lines: content.split('\n').length,
        hash,
        mtimeMs: s.mtimeMs,
        defs: sym.defs,
        refs: sym.refs,
        imports: sym.imports,
        summary: old?.summary,
        summaryHash: old?.summaryHash, // stale summary kept until re-summarized (hash differs)
        summaryModel: old?.summaryModel,
      });
      if (old) changed++;
      else added++;
    }
    const removed = [...prev.keys()].filter((p) => !scanned.some((s) => s.path === p)).length;
    const { edges } = buildGraph(next);
    const ranks = pageRank(next.map((f) => f.path), edges);
    this.data = { version: 1, root: this.root, builtAt: new Date().toISOString(), files: next, edges, ranks: Object.fromEntries(ranks) };
    this.reindexMaps();
    return { added, changed, removed, total: next.length };
  }

  /** Files whose summary is missing or stale. */
  needsSummary(): IndexedFile[] {
    return this.data.files.filter((f) => f.summaryHash !== f.hash);
  }

  /** File content as the project is (never a temporarily applied candidate overlay). */
  read(path: string): string | undefined {
    return readProjectFile(this.root, path);
  }

  private ensureBm25(): Bm25Index {
    if (this.bm25) return this.bm25;
    const idx = new Bm25Index();
    for (const f of this.data.files) {
      const content = this.read(f.path);
      if (content === undefined) continue;
      const defNames = f.defs.map((d) => d.name).join(' ');
      for (const c of chunkFile(f.path, content)) idx.add(c, defNames);
    }
    this.bm25 = idx;
    return idx;
  }

  search(query: string, limit = 8, pathFilter?: string): Array<Chunk & { score: number }> {
    const re = pathFilter ? new RegExp(pathFilter.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')) : undefined;
    return this.ensureBm25().search(query, limit, re ? (c) => re.test(c.path) : undefined);
  }

  /** Locate definitions by (partial) name. */
  findSymbol(name: string, limit = 20): Array<{ path: string; def: SymbolDef }> {
    const out: Array<{ path: string; def: SymbolDef }> = [];
    const lower = name.toLowerCase();
    for (const f of this.data.files) {
      for (const d of f.defs) {
        if (d.name === name || d.name.toLowerCase().includes(lower)) out.push({ path: f.path, def: d });
      }
    }
    return out.sort((a, b) => (a.def.name === name ? -1 : 0) - (b.def.name === name ? -1 : 0)).slice(0, limit);
  }

  /** Files that reference definitions in `path` (who depends on me). */
  dependents(path: string): Array<{ path: string; via: string[] }> {
    return this.data.edges.filter((e) => e.to === path).sort((a, b) => b.weight - a.weight).map((e) => ({ path: e.from, via: e.via }));
  }

  dependencies(path: string): Array<{ path: string; via: string[] }> {
    return this.data.edges.filter((e) => e.from === path).sort((a, b) => b.weight - a.weight).map((e) => ({ path: e.to, via: e.via }));
  }

  /**
   * Aider-style repo map: highest-ranked files with their key definitions,
   * personalized toward focus files / identifiers mentioned in the task.
   */
  repoMap(budgetTokens = 2048, focus: { files?: string[]; identifiers?: string[] } = {}): string {
    let ranks: Map<string, number>;
    if (focus.files?.length || focus.identifiers?.length) {
      const pers = new Map<string, number>();
      for (const f of this.data.files) pers.set(f.path, 0.1);
      for (const p of focus.files ?? []) if (this.byPath.has(p)) pers.set(p, 10);
      for (const id of focus.identifiers ?? []) {
        for (const hit of this.findSymbol(id, 5)) if (hit.def.name.toLowerCase() === id.toLowerCase()) pers.set(hit.path, (pers.get(hit.path) ?? 0) + 5);
      }
      ranks = pageRank(this.data.files.map((f) => f.path), this.data.edges, pers);
    } else {
      ranks = new Map(Object.entries(this.data.ranks));
    }
    const ordered = [...this.data.files].sort((a, b) => (ranks.get(b.path) ?? 0) - (ranks.get(a.path) ?? 0));
    const parts: string[] = [];
    let used = 0;
    for (const f of ordered) {
      const defs = f.defs
        .filter((d) => d.kind !== 'macro' || f.defs.length < 15)
        .slice(0, 25)
        .map((d) => `│ ${d.signature}`);
      const block = `${f.path}${f.summary ? ' — ' + f.summary.split('\n')[0].slice(0, 140) : ''}\n${defs.join('\n')}`.trimEnd();
      const cost = estimateTokens(block) + 1;
      if (used + cost > budgetTokens) {
        // still list the file name if there is room
        const short = estimateTokens(f.path) + 1;
        if (used + short > budgetTokens) break;
        parts.push(f.path);
        used += short;
        continue;
      }
      parts.push(block);
      used += cost;
    }
    return parts.join('\n');
  }

  /** Directory tree overview with file counts (cheap orientation context). */
  tree(maxLines = 120): string {
    const dirs = new Map<string, number>();
    for (const f of this.data.files) {
      const parts = f.path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const d = parts.slice(0, i).join('/');
        dirs.set(d, (dirs.get(d) ?? 0) + 1);
      }
    }
    const rootFiles = this.data.files.filter((f) => !f.path.includes('/')).map((f) => f.path);
    const lines = [...dirs.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([d, n]) => `${'  '.repeat(d.split('/').length - 1)}${d.split('/').pop()}/ (${n})`);
    return [...rootFiles, ...lines].slice(0, maxLines).join('\n');
  }

  /** Group files into modules for hierarchical summaries (aim ~5–60 files each). */
  modules(): ModuleGroup[] {
    const groups = new Map<string, string[]>();
    const keyFor = (path: string, depth: number) => {
      const parts = path.split('/');
      return parts.length <= 1 ? '' : parts.slice(0, Math.min(depth, parts.length - 1)).join('/');
    };
    for (const f of this.data.files) {
      const k = keyFor(f.path, 1);
      const list = groups.get(k) ?? [];
      list.push(f.path);
      groups.set(k, list);
    }
    // Split groups one level deeper when they are too big, or when the project is
    // wrapped in very few top-level folders (e.g. everything under src/) so that
    // module summaries stay meaningful.
    for (let depth = 2; depth <= 4; depth++) {
      const wrapped = [...groups.keys()].filter((k) => k !== '').length <= 2;
      for (const [k, list] of [...groups]) {
        if (k === '' || (list.length <= 60 && !(wrapped && list.length >= 6))) continue;
        const sub = new Map<string, string[]>();
        for (const p of list) {
          const sk = keyFor(p, depth);
          const l = sub.get(sk) ?? [];
          l.push(p);
          sub.set(sk, l);
        }
        if (sub.size > 1) {
          groups.delete(k);
          for (const [sk, l] of sub) groups.set(sk, [...(groups.get(sk) ?? []), ...l]);
        }
      }
    }
    return [...groups.entries()].map(([name, files]) => ({ name, files })).sort((a, b) => a.name.localeCompare(b.name));
  }

  stats(): { files: number; lines: number; defs: number; edges: number; langs: Record<string, number> } {
    const langs: Record<string, number> = {};
    let lines = 0;
    let defs = 0;
    for (const f of this.data.files) {
      langs[f.lang] = (langs[f.lang] ?? 0) + 1;
      lines += f.lines;
      defs += f.defs.length;
    }
    return { files: this.data.files.length, lines, defs, edges: this.data.edges.length, langs };
  }
}
