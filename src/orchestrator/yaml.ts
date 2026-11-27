/**
 * A small YAML reader – enough for CI pipeline files (.gitlab-ci.yml, GitHub/Gitea workflows,
 * azure-pipelines.yml, bitbucket-pipelines.yml): block maps and lists, plain and quoted scalars,
 * literal (|) and folded (>) blocks, flow lists, comments, anchors with aliases and `<<` merges.
 * Tags (!reference, !!str) are dropped; anything it cannot read becomes a string. No dependency.
 */

type Yaml = string | number | boolean | null | Yaml[] | { [k: string]: Yaml };

interface Line {
  indent: number;
  text: string;
}

/** Remove a comment that starts with " #" outside quotes. */
function stripComment(s: string): string {
  let q: string | undefined;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q && s[i - 1] !== '\\') q = undefined;
    } else if (c === '"' || c === "'") {
      // a quote only opens a string at the start of a value
      if (i === 0 || /[\s:,[{-]/.test(s[i - 1])) q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

const KEY = /^((?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"{[\]][^#]*?))\s*:(?:\s+|$)/;

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(["\\/nt])/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

export function parseYaml(text: string): Yaml {
  const anchors = new Map<string, Yaml>();
  const raw = text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n');
  // kept with their raw text: literal blocks need the lines as they are
  const lines: Array<Line & { raw: string }> = [];
  for (const r of raw) {
    if (/^(---|\.\.\.)\s*$/.test(r)) continue;
    const indent = r.length - r.trimStart().length;
    lines.push({ indent, text: stripComment(r.trim()), raw: r });
  }
  let i = 0;
  const skipBlank = () => {
    while (i < lines.length && !lines[i].text) i++;
  };

  /** A scalar or flow value written after "key:" or "- ". */
  const scalar = (v: string): Yaml => {
    let s = v.trim();
    s = s.replace(/^!\S+\s*/, ''); // tags
    const anchor = /^&(\S+)\s*(.*)$/.exec(s);
    if (anchor) s = anchor[2];
    const alias = /^\*(\S+)$/.exec(s);
    if (alias) return anchors.get(alias[1]) ?? null;
    if (s.startsWith('[') && s.endsWith(']')) {
      const inner = s.slice(1, -1).trim();
      return inner ? splitFlow(inner).map((x) => scalar(x)) : [];
    }
    if (/^(?:~|null)$/i.test(s) || s === '') return s === '' ? '' : null;
    if (/^(?:true|false)$/i.test(s)) return s.toLowerCase() === 'true';
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    return unquote(s);
  };

  /** Lines of a | or > block after the line at index `at` (indent > parent). */
  const blockScalar = (parent: number, style: string): string => {
    const out: string[] = [];
    let base = -1;
    while (i < lines.length) {
      const l = lines[i];
      if (l.raw.trim() && l.indent <= parent) break;
      if (l.raw.trim()) {
        if (base < 0) base = l.indent;
        out.push(l.raw.replace(/\t/g, '  ').slice(base));
      } else out.push('');
      i++;
    }
    while (out.length && !out[out.length - 1]) out.pop();
    const keep = style.includes('+');
    const body = style.startsWith('>') ? out.join('\n').replace(/([^\n])\n(?=[^\n ])/g, '$1 ') : out.join('\n');
    return keep || style.includes('-') ? body : body + (body ? '\n' : '');
  };

  /** The value after "key:" / "- ": inline, a block scalar, or a nested block on the next lines. */
  const valueAfter = (rest: string, ownIndent: number, allowSameIndentList: boolean): Yaml => {
    const anchor = /^&(\S+)\s*(.*)$/.exec(rest.trim());
    const r = anchor ? anchor[2] : rest.trim();
    let v: Yaml;
    if (/^[|>][+-]?\d*$/.test(r)) v = blockScalar(ownIndent, r);
    else if (r) {
      v = scalar(r);
      // a plain scalar may go on in more indented lines
      if (typeof v === 'string' && !/^["']/.test(r)) {
        while (i < lines.length && lines[i].text && lines[i].indent > ownIndent && !KEY.test(lines[i].text) && !lines[i].text.startsWith('- ')) {
          v += ` ${lines[i].text}`;
          i++;
        }
      }
    } else {
      skipBlank();
      const next = lines[i];
      if (next && (next.indent > ownIndent || (allowSameIndentList && next.indent === ownIndent && /^-(\s|$)/.test(next.text)))) v = block(next.indent);
      else v = null;
    }
    if (anchor) anchors.set(anchor[1], v);
    return v;
  };

  const block = (indent: number): Yaml => {
    skipBlank();
    if (i >= lines.length) return null;
    return /^-(\s|$)/.test(lines[i].text) ? list(indent) : map(indent);
  };

  const list = (indent: number): Yaml[] => {
    const out: Yaml[] = [];
    for (;;) {
      skipBlank();
      const l = lines[i];
      if (!l || l.indent !== indent || !/^-(\s|$)/.test(l.text)) break;
      i++;
      const rest = l.text.replace(/^-\s*/, '');
      const itemIndent = indent + (l.text.length - rest.length);
      if (/^-(\s|$)/.test(rest)) {
        // "- - x": a list inside the list
        lines.splice(i, 0, { indent: itemIndent, text: rest, raw: ' '.repeat(itemIndent) + rest });
        out.push(list(itemIndent));
      } else if (rest && KEY.test(rest) && !/^["'].*["']$/.test(rest)) {
        // "- key: value" starts a map whose keys sit at itemIndent
        lines.splice(i, 0, { indent: itemIndent, text: rest, raw: ' '.repeat(itemIndent) + rest });
        out.push(map(itemIndent));
      } else out.push(valueAfter(rest, indent, false));
    }
    return out;
  };

  const map = (indent: number): { [k: string]: Yaml } => {
    const out: { [k: string]: Yaml } = {};
    for (;;) {
      skipBlank();
      const l = lines[i];
      if (!l || l.indent !== indent || /^-(\s|$)/.test(l.text)) break;
      const m = KEY.exec(l.text);
      if (!m) {
        i++; // not a key: skip the line
        continue;
      }
      i++;
      const key = unquote(m[1].trim());
      const v = valueAfter(l.text.slice(m[0].length), indent, true);
      if (key === '<<') {
        for (const src of Array.isArray(v) ? v : [v]) if (src && typeof src === 'object' && !Array.isArray(src)) for (const [k, x] of Object.entries(src)) if (!(k in out)) out[k] = x;
      } else out[key] = v;
    }
    return out;
  };

  skipBlank();
  return i < lines.length ? block(lines[i].indent) : null;
}

/** Split a flow list "a, 'b, c', d" at the commas outside quotes and brackets. */
function splitFlow(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let q: string | undefined;
  let cur = '';
  for (const c of s) {
    if (q) {
      if (c === q) q = undefined;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export type { Yaml };
