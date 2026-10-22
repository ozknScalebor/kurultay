import { displayWidth, fitWidth } from './keys.js';

/**
 * Terminal Markdown renderer (no dependencies): headings, emphasis, inline
 * code, links, lists (incl. task lists), block quotes, tables, rules and
 * fenced code blocks with light syntax colouring. Paragraphs wrap to the
 * terminal width. With `ansi: false` the output is plain, readable text.
 */
export interface MdOptions {
  width: number;
  ansi: boolean;
}

const SGR = {
  bold: ['\x1b[1m', '\x1b[22m'],
  dim: ['\x1b[2m', '\x1b[22m'],
  italic: ['\x1b[3m', '\x1b[23m'],
  under: ['\x1b[4m', '\x1b[24m'],
  strike: ['\x1b[9m', '\x1b[29m'],
  cyan: ['\x1b[36m', '\x1b[39m'],
  yellow: ['\x1b[33m', '\x1b[39m'],
  green: ['\x1b[32m', '\x1b[39m'],
  magenta: ['\x1b[35m', '\x1b[39m'],
  blue: ['\x1b[34m', '\x1b[39m'],
  gray: ['\x1b[90m', '\x1b[39m'],
} as const;
type Style = keyof typeof SGR;

function paint(o: MdOptions, s: string, ...styles: Style[]): string {
  if (!o.ansi || !s) return s;
  return styles.reduce((acc, st) => `${SGR[st][0]}${acc}${SGR[st][1]}`, s);
}

/** Inline markdown → styled text. Code spans are protected from other rules. */
export function renderInline(text: string, o: MdOptions): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(paint(o, o.ansi ? c : `\`${c}\``, 'cyan'));
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s
    .replace(/<\/?(?:details|summary|br|sub|sup|kbd)\s*\/?>/gi, '')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt: string, url: string) => `[${alt || 'görsel'}: ${url}]`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, t: string, url: string) => (t === url ? paint(o, url, 'under', 'blue') : `${paint(o, t, 'under')} ${paint(o, `(${url})`, 'gray')}`))
    .replace(/\*\*\*([^*]+)\*\*\*/g, (_m, t: string) => paint(o, t, 'bold', 'italic'))
    .replace(/(\*\*|__)(?=\S)([^*]*?\S)\1/g, (_m, _d, t: string) => paint(o, t, 'bold'))
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, (_m, pre: string, t: string) => pre + paint(o, t, 'italic'))
    .replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?![_\w])/g, (_m, pre: string, t: string) => pre + paint(o, t, 'italic'))
    .replace(/~~([^~]+)~~/g, (_m, t: string) => paint(o, t, 'strike'));
   
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

/** Wrap styled text to `width` columns (ANSI aware), continuing lines with `indent`. */
export function wrap(text: string, width: number, indent = '', first = ''): string[] {
  const words = text.split(/(\s+)/).filter((w) => w.length);
  const lines: string[] = [];
  let line = first;
  let lineW = displayWidth(first);
  const lead = displayWidth(indent);
  for (const w of words) {
    if (/^\s+$/.test(w)) {
      if (lineW > displayWidth(lines.length ? indent : first)) {
        line += ' ';
        lineW += 1;
      }
      continue;
    }
    const ww = displayWidth(w);
    if (lineW + ww > width && lineW > (lines.length ? lead : displayWidth(first))) {
      lines.push(line.trimEnd());
      line = indent;
      lineW = lead;
    }
    line += w;
    lineW += ww;
  }
  lines.push(line.trimEnd());
  return lines;
}

const KEYWORDS =
  /\b(if|else|for|while|do|switch|case|break|continue|return|function|const|let|var|class|struct|enum|interface|type|import|export|from|as|new|delete|try|catch|finally|throw|async|await|yield|def|lambda|pass|raise|with|in|is|not|and|or|public|private|protected|static|final|void|int|char|long|short|unsigned|signed|float|double|bool|boolean|string|auto|namespace|using|template|typename|package|func|go|defer|fn|impl|pub|mut|match|use|mod|true|false|null|nil|None|True|False|this|self|extends|implements|sizeof|typedef|volatile|register|extern|inline)\b/g;

/** Light, language-agnostic highlighting: comments, strings, numbers, keywords. */
export function highlight(line: string, lang: string, o: MdOptions): string {
  if (!o.ansi) return line;
  if (/^(diff|patch)$/.test(lang)) {
    if (line.startsWith('+') && !line.startsWith('+++')) return paint(o, line, 'green');
    if (line.startsWith('-') && !line.startsWith('---')) return paint(o, line, 'magenta');
    if (line.startsWith('@@')) return paint(o, line, 'cyan');
    return line;
  }
  const hashComment = /^(py|python|sh|bash|shell|zsh|yaml|yml|toml|ruby|rb|make|makefile|cmake|dockerfile|r|perl|ini|conf)$/i.test(lang);
  const commentRe = hashComment ? /#.*$/ : /\/\/.*$|\/\*.*?\*\/|--\s.*$/;
  const m = line.match(commentRe);
  const code = m ? line.slice(0, m.index) : line;
  const comment = m ? paint(o, m[0], 'gray') : '';
  const parts = code.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/);
  const out = parts
    .map((p, i) =>
      i % 2 === 1
        ? paint(o, p, 'green')
        : p.replace(KEYWORDS, (k) => paint(o, k, 'magenta')).replace(/\b(0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b/g, (n) => paint(o, n, 'yellow')),
    )
    .join('');
  return out + comment;
}

function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\||\|$/g, '');
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (t[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
}

function renderTable(rows: string[][], align: Array<'l' | 'r' | 'c'>, o: MdOptions): string[] {
  const n = Math.max(...rows.map((r) => r.length));
  const cells = rows.map((r) => Array.from({ length: n }, (_, i) => renderInline(r[i] ?? '', o)));
  let widths = Array.from({ length: n }, (_, i) => Math.max(3, ...cells.map((r) => displayWidth(r[i]))));
  const budget = o.width - (3 * n + 1);
  // shrink the widest columns until the table fits
  while (widths.reduce((a, b) => a + b, 0) > budget && Math.max(...widths) > 6) {
    const i = widths.indexOf(Math.max(...widths));
    widths = widths.map((w, k) => (k === i ? w - 1 : w));
  }
  const pad = (s: string, w: number, a: 'l' | 'r' | 'c') => {
    const t = displayWidth(s) > w ? fitWidth(s, w) : s;
    const gap = Math.max(0, w - displayWidth(t));
    if (a === 'r') return ' '.repeat(gap) + t;
    if (a === 'c') return ' '.repeat(Math.floor(gap / 2)) + t + ' '.repeat(Math.ceil(gap / 2));
    return t + ' '.repeat(gap);
  };
  const line = (l: string, m: string, r: string) => paint(o, l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r, 'gray');
  const bar = paint(o, '│', 'gray');
  const out = [line('┌', '┬', '┐')];
  cells.forEach((r, ri) => {
    out.push(`${bar} ${r.map((c, i) => pad(ri === 0 ? paint(o, c, 'bold') : c, widths[i], align[i] ?? 'l')).join(` ${bar} `)} ${bar}`);
    if (ri === 0) out.push(line('├', '┼', '┤'));
  });
  out.push(line('└', '┴', '┘'));
  return out;
}

export function renderMarkdown(md: string, opts: Partial<MdOptions> = {}): string {
  const o: MdOptions = { width: Math.max(20, opts.width ?? 100), ansi: opts.ansi ?? false };
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (!para.length) return;
    out.push(...wrap(renderInline(para.join(' '), o), o.width));
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // fenced code
    const fence = line.match(/^(\s*)(```+|~~~+)\s*([\w+#.-]*)/);
    if (fence) {
      flush();
      const close = fence[2];
      const lang = fence[3] ?? '';
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(close); i++) body.push(lines[i]);
      if (lang === 'mermaid') out.push(paint(o, '  [mermaid diyagramı]', 'gray'));
      out.push(paint(o, `  ┌${lang ? ` ${lang} ` : ''}${'─'.repeat(Math.max(0, Math.min(o.width - 6, 40) - displayWidth(lang) - (lang ? 2 : 0)))}`, 'gray'));
      for (const b of body) out.push(`${paint(o, '  │ ', 'gray')}${highlight(fitWidth(b.replace(/\t/g, '  '), o.width - 4), lang, o)}`);
      out.push(paint(o, '  └', 'gray'));
      continue;
    }
    if (!line.trim()) {
      flush();
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    if (/^\s*<\/?(details|summary)[^>]*>\s*$/i.test(line)) continue;
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      flush();
      const text = renderInline(h[2], o);
      if (h[1].length === 1) out.push(paint(o, text, 'bold', 'cyan'), paint(o, '═'.repeat(Math.min(o.width, displayWidth(text))), 'cyan'));
      else if (h[1].length === 2) out.push(paint(o, text, 'bold', 'cyan'), paint(o, '─'.repeat(Math.min(o.width, displayWidth(text))), 'gray'));
      else out.push(paint(o, text, 'bold'));
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push(paint(o, '─'.repeat(Math.min(o.width, 60)), 'gray'));
      continue;
    }
    // table: header row followed by a separator row
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flush();
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'c' : c.endsWith(':') ? 'r' : 'l')) as Array<'l' | 'r' | 'c'>;
      const rows = [splitRow(line)];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(splitRow(lines[i]));
      i--;
      out.push(...renderTable(rows, align, o));
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flush();
      const bar = paint(o, '│ ', 'gray');
      out.push(...wrap(paint(o, renderInline(quote[1], o), 'italic'), o.width - 2).map((l) => bar + l));
      continue;
    }
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/);
    if (li) {
      flush();
      const depth = Math.floor(li[1].replace(/\t/g, '  ').length / 2);
      const pad = '  '.repeat(depth);
      const task = li[3] ? (/x/i.test(li[3]) ? paint(o, '☑ ', 'green') : '☐ ') : '';
      const bullet = /\d/.test(li[2]) ? `${li[2]} ` : paint(o, depth % 2 ? '◦ ' : '• ', 'cyan');
      const first = `${pad}${bullet}${task}`;
      let text = li[4];
      // lazy continuation lines belong to the item
      while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i + 1])) text += ' ' + lines[++i].trim();
      out.push(...wrap(renderInline(text, o), o.width, ' '.repeat(displayWidth(first)), first));
      continue;
    }
    para.push(line.trim());
  }
  flush();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}
