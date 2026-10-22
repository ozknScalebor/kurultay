/**
 * Minimal YAML front-matter parser (no dependency). Supports what SKILL.md /
 * rule files use in practice: scalars, quoted strings, booleans, numbers,
 * inline lists `[a, b]`, block lists (`- a`), folded/literal block scalars
 * (`>` / `|`) and one level of nested maps (e.g. `metadata:`).
 */

export type FmValue = string | number | boolean | null | FmValue[] | { [k: string]: FmValue };

export interface Frontmatter {
  data: Record<string, FmValue>;
  body: string;
  /** true when a `---` block was present */
  present: boolean;
}

function scalar(raw: string): FmValue {
  const v = raw.trim();
  if (v === '') return '';
  if (/^(true|yes|on)$/i.test(v)) return true;
  if (/^(false|no|off)$/i.test(v)) return false;
  if (/^(null|~)$/i.test(v)) return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    const inner = v.slice(1, -1);
    return v.startsWith('"') ? inner.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'");
  }
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    const parts: string[] = [];
    let cur = '';
    let q: string | null = null;
    for (const ch of inner) {
      if (q) {
        if (ch === q) q = null;
        cur += ch;
      } else if (ch === '"' || ch === "'") {
        q = ch;
        cur += ch;
      } else if (ch === ',') {
        parts.push(cur);
        cur = '';
      } else cur += ch;
    }
    parts.push(cur);
    return parts.map((p) => scalar(p));
  }
  // strip trailing comment " # ..."
  return v.replace(/\s+#.*$/, '');
}

export function parseFrontmatter(text: string): Frontmatter {
  const src = text.replace(/^\uFEFF/, '');
  const m = src.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { data: {}, body: src, present: false };
  const lines = m[1].split(/\r?\n/);
  const data: Record<string, FmValue> = {};
  let i = 0;
  const indentOf = (l: string) => l.match(/^\s*/)![0].length;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[1];
    const rest = kv[2];
    i++;
    if (/^[>|][+-]?\s*$/.test(rest)) {
      // block scalar
      const folded = rest.startsWith('>');
      const block: string[] = [];
      while (i < lines.length && (lines[i].trim() === '' || indentOf(lines[i]) > 0)) block.push(lines[i++]);
      const minIndent = Math.min(...block.filter((b) => b.trim()).map(indentOf), Infinity);
      const stripped = block.map((b) => b.slice(Number.isFinite(minIndent) ? minIndent : 0));
      data[key] = (folded ? stripped.join(' ').replace(/\s+/g, ' ') : stripped.join('\n')).trim();
      continue;
    }
    if (rest.trim() === '') {
      // block list or nested map
      const items: FmValue[] = [];
      const map: Record<string, FmValue> = {};
      let isMap = false;
      while (i < lines.length && (lines[i].trim() === '' || indentOf(lines[i]) > 0 || /^\s*-\s/.test(lines[i]))) {
        const l = lines[i].trim();
        i++;
        if (!l) continue;
        if (l.startsWith('- ')) items.push(scalar(l.slice(2)));
        else if (l === '-') items.push('');
        else {
          const sub = l.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
          if (sub) {
            isMap = true;
            map[sub[1]] = scalar(sub[2]);
          }
        }
      }
      data[key] = isMap ? map : items;
      continue;
    }
    data[key] = scalar(rest);
  }
  return { data, body: src.slice(m[0].length), present: true };
}

export function fmString(v: FmValue | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.map(String).join(', ');
  if (typeof v === 'object') return undefined;
  return String(v);
}

export function fmList(v: FmValue | undefined): string[] {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'object') return [];
  // "a, b" or space separated globs
  return String(v)
    .split(/[,\n]/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

export function fmBool(v: FmValue | undefined): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (/^(true|yes|on)$/i.test(v)) return true;
    if (/^(false|no|off)$/i.test(v)) return false;
  }
  return undefined;
}
