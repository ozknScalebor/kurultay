import { posix } from 'node:path';
import type { SymbolDef } from './symbols.js';

export interface GraphFile {
  path: string;
  lang: string;
  defs: SymbolDef[];
  refs: Record<string, number>;
  imports: string[];
}

export interface Edge {
  from: string;
  to: string;
  weight: number;
  /** identifiers that produced the edge (for flow docs) */
  via: string[];
}

/** Resolve import specifiers to project files (best-effort, language aware). */
export function resolveImports(files: GraphFile[]): Map<string, Set<string>> {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const byBase = new Map<string, string[]>();
  for (const f of files) {
    const base = posix.basename(f.path);
    const list = byBase.get(base) ?? [];
    list.push(f.path);
    byBase.set(base, list);
  }
  const noExt = new Map<string, string>();
  for (const f of files) noExt.set(f.path.replace(/\.[^./]+$/, ''), f.path);

  const out = new Map<string, Set<string>>();
  for (const f of files) {
    const targets = new Set<string>();
    for (const spec of f.imports) {
      let hit: string | undefined;
      if (f.lang === 'c' || f.lang === 'cpp' || f.lang === 'objc') {
        const rel = posix.normalize(posix.join(posix.dirname(f.path), spec));
        if (byPath.has(rel)) hit = rel;
        else {
          const cands = (byBase.get(posix.basename(spec)) ?? []).filter((p) => p.endsWith(spec));
          hit = cands.sort((a, b) => a.length - b.length)[0];
        }
      } else if (f.lang === 'java' || f.lang === 'kotlin' || f.lang === 'scala') {
        const asPath = spec.replace(/\.\*$/, '').replace(/\./g, '/');
        for (const [k, v] of noExt) {
          if (k.endsWith('/' + asPath) || k === asPath) {
            hit = v;
            break;
          }
        }
      } else if (f.lang === 'python') {
        let mod = spec;
        let baseDir = '';
        if (mod.startsWith('.')) {
          const dots = mod.match(/^\.+/)![0].length;
          baseDir = posix.dirname(f.path);
          for (let i = 1; i < dots; i++) baseDir = posix.dirname(baseDir);
          mod = mod.slice(dots);
        }
        const asPath = posix.join(baseDir, mod.replace(/\./g, '/'));
        hit = noExt.get(asPath) ?? noExt.get(asPath + '/__init__');
        if (!hit) for (const [k, v] of noExt) if (k.endsWith('/' + asPath)) { hit = v; break; }
      } else if (f.lang === 'javascript' || f.lang === 'typescript') {
        if (spec.startsWith('.')) {
          const rel = posix.normalize(posix.join(posix.dirname(f.path), spec)).replace(/\.(js|mjs|cjs|jsx)$/, '');
          hit = noExt.get(rel) ?? noExt.get(rel + '/index') ?? (byPath.has(rel) ? rel : undefined);
        }
      } else if (f.lang === 'go' || f.lang === 'rust') {
        const last = spec.split(/[/:]+/).filter(Boolean).pop();
        if (last) for (const p of files) if (posix.dirname(p.path).endsWith('/' + last) || posix.basename(p.path).replace(/\.\w+$/, '') === last) { hit = p.path; break; }
      }
      if (hit && hit !== f.path) targets.add(hit);
    }
    out.set(f.path, targets);
  }
  return out;
}

/** Build the weighted file graph: imports + identifier references to definitions. */
export function buildGraph(files: GraphFile[]): { edges: Edge[]; definers: Map<string, string[]> } {
  const definers = new Map<string, string[]>();
  for (const f of files) {
    for (const d of f.defs) {
      if (d.name.length < 3) continue;
      const list = definers.get(d.name) ?? [];
      if (!list.includes(f.path)) list.push(f.path);
      definers.set(d.name, list);
    }
  }
  const edgeMap = new Map<string, Edge>();
  const add = (from: string, to: string, w: number, via?: string) => {
    if (from === to) return;
    const k = `${from}\u0000${to}`;
    let e = edgeMap.get(k);
    if (!e) {
      e = { from, to, weight: 0, via: [] };
      edgeMap.set(k, e);
    }
    e.weight += w;
    if (via && e.via.length < 12 && !e.via.includes(via)) e.via.push(via);
  };
  const imports = resolveImports(files);
  for (const f of files) {
    for (const t of imports.get(f.path) ?? []) add(f.path, t, 2);
    for (const [ident, count] of Object.entries(f.refs)) {
      const defs = definers.get(ident);
      if (!defs) continue;
      // common names defined in many files carry little signal (Aider does the same)
      const spread = defs.length;
      if (spread > 8) continue;
      for (const target of defs) add(f.path, target, Math.sqrt(count) / spread, ident);
    }
  }
  return { edges: [...edgeMap.values()], definers };
}

/** Weighted PageRank with optional personalization (Aider repo-map style). */
export function pageRank(nodes: string[], edges: Edge[], personalization?: Map<string, number>, iterations = 40, damping = 0.85): Map<string, number> {
  const n = nodes.length;
  const rank = new Map<string, number>();
  if (n === 0) return rank;
  const outW = new Map<string, number>();
  const incoming = new Map<string, Array<{ from: string; w: number }>>();
  for (const e of edges) {
    outW.set(e.from, (outW.get(e.from) ?? 0) + e.weight);
    const list = incoming.get(e.to) ?? [];
    list.push({ from: e.from, w: e.weight });
    incoming.set(e.to, list);
  }
  let pTotal = 0;
  if (personalization) for (const v of personalization.values()) pTotal += v;
  const teleport = (node: string) => (personalization && pTotal > 0 ? (personalization.get(node) ?? 0) / pTotal : 1 / n);
  for (const node of nodes) rank.set(node, 1 / n);
  for (let it = 0; it < iterations; it++) {
    let dangling = 0;
    for (const node of nodes) if (!outW.get(node)) dangling += rank.get(node)!;
    const next = new Map<string, number>();
    let delta = 0;
    for (const node of nodes) {
      let sum = 0;
      for (const { from, w } of incoming.get(node) ?? []) sum += (rank.get(from)! * w) / outW.get(from)!;
      const v = (1 - damping) * teleport(node) + damping * (sum + dangling * teleport(node));
      next.set(node, v);
      delta += Math.abs(v - rank.get(node)!);
    }
    for (const [k, v] of next) rank.set(k, v);
    if (delta < 1e-7) break;
  }
  return rank;
}
