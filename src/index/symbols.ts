/**
 * Dependency-free symbol extraction. Regex/heuristic based (no native tree-sitter
 * build needed on the offline machine). Produces definitions with signatures,
 * identifier references and import edges – enough for an Aider-style repo map.
 */

export type DefKind = 'function' | 'method' | 'class' | 'struct' | 'interface' | 'enum' | 'type' | 'namespace' | 'macro' | 'const' | 'module';

export interface SymbolDef {
  name: string;
  kind: DefKind;
  line: number; // 1-based
  signature: string;
  /** enclosing class/namespace if known */
  parent?: string;
}

export interface FileSymbols {
  defs: SymbolDef[];
  /** identifier → occurrence count (top-N) */
  refs: Record<string, number>;
  /** raw import specifiers (#include "x.h", import a.b.C, from x import y, './foo') */
  imports: string[];
}

const KEYWORDS = new Set(
  (
    'if else for while do switch case default break continue return goto sizeof typeof alignof new delete throw try catch finally ' +
    'class struct enum union namespace template typename using public private protected static const constexpr volatile extern inline virtual ' +
    'override final explicit friend operator this super true false null nullptr void int char short long float double bool unsigned signed auto ' +
    'import package from as def lambda pass yield with async await let var function export interface type implements extends abstract ' +
    'synchronized native transient instanceof boolean byte string String Object self None True False and or not in is elif except raise del ' +
    'global nonlocal assert func go defer chan map range select fallthrough struct impl trait mod pub fn mut ref crate use where loop match ' +
    'typedef include define ifdef ifndef endif pragma undef elif error line std size_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t ' +
    'val object companion data sealed internal open lateinit when is fun get set value println printf main args'
  ).split(/\s+/),
);

const CONTROL = /^(if|for|while|switch|return|sizeof|else|catch|do|case|throw|new|delete|defined|elif|assert|typeof|await)$/;

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Remove comments and string contents (keeps line structure so line numbers stay valid). */
export function stripCommentsAndStrings(src: string, lang: string): string {
  const hashComments = lang === 'python' || lang === 'shell' || lang === 'ruby' || lang === 'cmake' || lang === 'make' || lang === 'yaml' || lang === 'toml';
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    // block comment
    if (!hashComments && c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const chunk = src.slice(i, end < 0 ? n : end + 2);
      out += chunk.replace(/[^\n]/g, ' ');
      i += chunk.length;
      continue;
    }
    // line comment
    if ((!hashComments && c === '/' && d === '/') || (hashComments && c === '#' && !(lang === 'python' && false))) {
      const end = src.indexOf('\n', i);
      const chunk = src.slice(i, end < 0 ? n : end);
      out += ' '.repeat(chunk.length);
      i += chunk.length;
      continue;
    }
    // python triple-quoted strings (docstrings)
    if (lang === 'python' && (src.startsWith('"""', i) || src.startsWith("'''", i))) {
      const q = src.slice(i, i + 3);
      const end = src.indexOf(q, i + 3);
      const chunk = src.slice(i, end < 0 ? n : end + 3);
      out += chunk.replace(/[^\n]/g, ' ');
      i += chunk.length;
      continue;
    }
    if (c === '"' || c === "'" || (c === '`' && (lang === 'javascript' || lang === 'typescript' || lang === 'go'))) {
      // C char literal / string – keep the quotes, blank the content (but keep #include "x" intact)
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') j++;
        j++;
      }
      if (c === '`') {
        j = i + 1;
        while (j < n && src[j] !== '`') {
          if (src[j] === '\\') j++;
          j++;
        }
      }
      const body = src.slice(i + 1, j);
      out += c + body.replace(/[^\n]/g, ' ') + (j < n ? src[j] : '');
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function sig(line: string): string {
  return line.trim().replace(/\s*\{\s*$/, '').replace(/\s+/g, ' ').slice(0, 160);
}

function extractImports(src: string, lang: string): string[] {
  const out: string[] = [];
  const push = (s?: string) => s && out.push(s.trim());
  let m: RegExpExecArray | null;
  switch (lang) {
    case 'c':
    case 'cpp':
    case 'objc': {
      const re = /^\s*#\s*(?:include|import)\s*["<]([^">]+)[">]/gm;
      while ((m = re.exec(src))) push(m[1]);
      break;
    }
    case 'java':
    case 'kotlin':
    case 'scala': {
      const re = /^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)/gm;
      while ((m = re.exec(src))) push(m[1]);
      break;
    }
    case 'csharp': {
      const re = /^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm;
      while ((m = re.exec(src))) push(m[1]);
      break;
    }
    case 'python': {
      const re = /^\s*(?:from\s+([.\w]+)\s+import|import\s+([\w.]+))/gm;
      while ((m = re.exec(src))) push(m[1] ?? m[2]);
      break;
    }
    case 'javascript':
    case 'typescript': {
      const re = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*|export\s[^'"]*?from\s*)['"]([^'"]+)['"]/g;
      while ((m = re.exec(src))) push(m[1]);
      break;
    }
    case 'go': {
      const block = src.match(/import\s*\(([\s\S]*?)\)/);
      if (block) for (const l of block[1].matchAll(/"([^"]+)"/g)) push(l[1]);
      const re = /^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm;
      while ((m = re.exec(src))) push(m[1]);
      break;
    }
    case 'rust': {
      const re = /^\s*(?:pub\s+)?(?:use|mod)\s+([\w:]+)/gm;
      while ((m = re.exec(src))) push(m[1]);
      break;
    }
  }
  return [...new Set(out)];
}

function cLike(clean: string, raw: string, lang: string): SymbolDef[] {
  const defs: SymbolDef[] = [];
  const lines = clean.split('\n');
  const rawLines = raw.split('\n');
  const typeRe = /^\s*(?:typedef\s+)?(?:template\s*<[^>]*>\s*)?(class|struct|union|enum(?:\s+class)?|namespace)\s+(?:[A-Z_]+\s+)?([A-Za-z_]\w*)\s*(?:final\s*)?(?:[:{]|$)/;
  const macroRe = /^\s*#\s*define\s+([A-Za-z_]\w*)/;
  const typedefRe = /^\s*typedef\s+.*?\b([A-Za-z_]\w*)\s*;\s*$/;
  const usingRe = /^\s*using\s+([A-Za-z_]\w*)\s*=/;
  const scope: string[] = [];
  let typedefOpen = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m: RegExpMatchArray | null;
    if (/^\s*typedef\s+(struct|enum|union)\b[^;]*$/.test(l)) typedefOpen = true;
    if (typedefOpen && (m = l.match(/^\s*\}\s*(?:\*\s*)?([A-Za-z_]\w*)\s*(?:,[^;]*)?;/))) {
      defs.push({ name: m[1], kind: 'type', line: i + 1, signature: `typedef … ${m[1]}` });
      typedefOpen = false;
      continue;
    }
    // K&R / GNU style: return type on the previous line, name at column 0, "{" on next line
    if ((m = l.match(/^([A-Za-z_]\w*)\s*\(([^;]*)\)\s*$/)) && /^\s*\{/.test(lines[i + 1] ?? '') && !CONTROL.test(m[1])) {
      const prev = (lines[i - 1] ?? '').trim();
      if (prev && /^[\w\s*]+$/.test(prev) && !/;$/.test(prev)) {
        defs.push({ name: m[1], kind: 'function', line: i + 1, signature: sig(`${rawLines[i - 1].trim()} ${rawLines[i]}`) });
        continue;
      }
    }
    if ((m = l.match(macroRe))) {
      defs.push({ name: m[1], kind: 'macro', line: i + 1, signature: sig(rawLines[i]) });
      continue;
    }
    if ((m = l.match(typeRe))) {
      const kw = m[1];
      const kind: DefKind = kw === 'namespace' ? 'namespace' : kw.startsWith('enum') ? 'enum' : kw === 'class' ? 'class' : 'struct';
      // forward declarations like "class Foo;" are skipped by the regex end anchor
      defs.push({ name: m[2], kind, line: i + 1, signature: sig(rawLines[i]) });
      if (kind === 'class' || kind === 'struct') scope.push(m[2]);
      continue;
    }
    if ((m = l.match(typedefRe)) && !/\(/.test(l)) {
      defs.push({ name: m[1], kind: 'type', line: i + 1, signature: sig(rawLines[i]) });
      continue;
    }
    if (lang === 'cpp' && (m = l.match(usingRe))) {
      defs.push({ name: m[1], kind: 'type', line: i + 1, signature: sig(rawLines[i]) });
      continue;
    }
    // function definitions: "<type> name(args) [const] {" possibly with "{" on the next line
    const joined = l + ' ' + (lines[i + 1] ?? '');
    const fm = l.match(/^[\t ]*(?:[\w:<>,*&~\s]+?[\s*&])?((?:[A-Za-z_]\w*::)*~?[A-Za-z_]\w*)\s*\(([^;]*)$/) ?? l.match(/^[\t ]*(?:[\w:<>,*&~\s]+?[\s*&])?((?:[A-Za-z_]\w*::)*~?[A-Za-z_]\w*)\s*\((.*)\)\s*(?:const)?\s*(?:noexcept)?\s*(?:override|final)?\s*(?:->\s*[\w:<>*& ]+)?\s*\{/);
    if (fm && !/^\s*(?:return|else|case|#)/.test(l) && !/[=;]\s*$/.test(l.trim())) {
      const name = fm[1];
      const bare = name.split('::').pop()!.replace('~', '');
      if (CONTROL.test(bare) || KEYWORDS.has(bare) && bare !== 'main') continue;
      // must be a definition: body opens on this or next line, and not a call statement
      const opensBody = /\)\s*(?:const)?\s*(?:noexcept)?\s*(?:override|final)?\s*(?:->[^{;]*)?\s*(?::[^;{]*)?\{/.test(joined) || (/\)\s*(?:const)?\s*$/.test(l.trim()) && /^\s*\{/.test(lines[i + 1] ?? ''));
      const hasReturnType = /^[\t ]*[\w:<>,*&~]+[\s*&]+[\w:~]/.test(l) || name.includes('::');
      if (!opensBody || (!hasReturnType && lang === 'c')) continue;
      const parent = name.includes('::') ? name.split('::').slice(-2, -1)[0] : scope[scope.length - 1];
      defs.push({ name: bare, kind: name.includes('::') || (lang === 'cpp' && parent && /^\s{2,}/.test(l)) ? 'method' : 'function', line: i + 1, signature: sig(rawLines[i] + (opensBody && !/\{/.test(rawLines[i]) ? '' : '')), parent });
    }
  }
  return defs;
}

function javaLike(clean: string, raw: string): SymbolDef[] {
  const defs: SymbolDef[] = [];
  const lines = clean.split('\n');
  const rawLines = raw.split('\n');
  const typeRe = /\b(class|interface|enum|record|struct|object|trait)\s+([A-Z_a-z]\w*)/;
  const methodRe = /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:public|private|protected|internal|static|final|abstract|synchronized|native|override|virtual|async|default|sealed|open|suspend|inline|operator|partial|extern|unsafe|new)\s+)*(?:fun\s+|(?:<[^>]*>\s+)?[\w<>[\],.?]+(?:\s*<[^>]*>)?\s+)([a-zA-Z_]\w*)\s*\(([^;]*)\)?\s*(?:throws\s+[\w., ]+)?\s*(?::\s*[\w<>?,. ]+)?\s*(?:\{|=|$)/;
  let currentClass: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(package|import|using|return)\b/.test(l)) continue;
    const t = l.match(typeRe);
    if (t && !/^\s*\/\//.test(l) && /^[\s\w@<>,.()]*\b(class|interface|enum|record|struct|object|trait)\s/.test(l)) {
      const kind: DefKind = t[1] === 'interface' || t[1] === 'trait' ? 'interface' : t[1] === 'enum' ? 'enum' : t[1] === 'struct' ? 'struct' : 'class';
      defs.push({ name: t[2], kind, line: i + 1, signature: sig(rawLines[i]) });
      currentClass = t[2];
      continue;
    }
    const m = l.match(methodRe);
    if (m && !CONTROL.test(m[1]) && !KEYWORDS.has(m[1]) && !/^\s*(new|else|throw)\b/.test(l) && !/\.\s*\w+\s*\(/.test(l.split('(')[0])) {
      // require body start on this line or the next
      const next = lines[i + 1] ?? '';
      if (/[{=]\s*$/.test(l.trim()) || /\)\s*$/.test(l.trim()) && /^\s*\{/.test(next) || /\)\s*(throws[^{]*)?\{/.test(l) || /;\s*$/.test(l.trim()) && /\babstract\b|^\s*(?:public\s+)?(?:default\s+)?[\w<>[\]]+\s+\w+\s*\([^)]*\)\s*;/.test(l) && !!currentClass) {
        defs.push({ name: m[1], kind: currentClass ? 'method' : 'function', line: i + 1, signature: sig(rawLines[i]), parent: currentClass });
      }
    }
  }
  return defs;
}

function python(clean: string, raw: string): SymbolDef[] {
  const defs: SymbolDef[] = [];
  const lines = clean.split('\n');
  const rawLines = raw.split('\n');
  const classStack: Array<{ name: string; indent: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const indent = l.match(/^\s*/)![0].length;
    while (classStack.length && indent <= classStack[classStack.length - 1].indent && l.trim()) classStack.pop();
    let m = l.match(/^\s*class\s+([A-Za-z_]\w*)/);
    if (m) {
      defs.push({ name: m[1], kind: 'class', line: i + 1, signature: sig(rawLines[i]).replace(/:$/, '') });
      classStack.push({ name: m[1], indent });
      continue;
    }
    m = l.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (m) {
      const parent = classStack[classStack.length - 1]?.name;
      defs.push({ name: m[1], kind: parent ? 'method' : 'function', line: i + 1, signature: sig(rawLines[i]).replace(/:$/, ''), parent });
      continue;
    }
    m = l.match(/^([A-Z][A-Z0-9_]+)\s*[:=]/);
    if (m) defs.push({ name: m[1], kind: 'const', line: i + 1, signature: sig(rawLines[i]).slice(0, 100) });
  }
  return defs;
}

function jsLike(clean: string, raw: string): SymbolDef[] {
  const defs: SymbolDef[] = [];
  const lines = clean.split('\n');
  const rawLines = raw.split('\n');
  let currentClass: string | undefined;
  let classIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const indent = l.match(/^\s*/)![0].length;
    if (currentClass && l.trim() === '}' && indent <= classIndent) currentClass = undefined;
    let m = l.match(/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (m) {
      defs.push({ name: m[1], kind: 'class', line: i + 1, signature: sig(rawLines[i]) });
      currentClass = m[1];
      classIndent = indent;
      continue;
    }
    m = l.match(/^\s*(?:export\s+)?(?:declare\s+)?(interface|type|enum)\s+([A-Za-z_$][\w$]*)/);
    if (m) {
      defs.push({ name: m[2], kind: m[1] === 'interface' ? 'interface' : m[1] === 'enum' ? 'enum' : 'type', line: i + 1, signature: sig(rawLines[i]) });
      continue;
    }
    m = l.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/);
    if (m) {
      defs.push({ name: m[1], kind: 'function', line: i + 1, signature: sig(rawLines[i]) });
      continue;
    }
    m = l.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/);
    if (m) {
      defs.push({ name: m[1], kind: 'function', line: i + 1, signature: sig(rawLines[i]) });
      continue;
    }
    if (currentClass) {
      m = l.match(/^\s+(?:(?:public|private|protected|static|readonly|async|override|get|set|abstract)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)?\s*(?::\s*[^{]+)?\{?\s*$/);
      if (m && !CONTROL.test(m[1]) && m[1] !== 'constructor' && !KEYWORDS.has(m[1])) {
        defs.push({ name: m[1], kind: 'method', line: i + 1, signature: sig(rawLines[i]), parent: currentClass });
      }
    }
    m = l.match(/^\s*export\s+const\s+([A-Za-z_$][\w$]*)/);
    if (m) defs.push({ name: m[1], kind: 'const', line: i + 1, signature: sig(rawLines[i]).slice(0, 120) });
  }
  return defs;
}

function golang(clean: string, raw: string): SymbolDef[] {
  const defs: SymbolDef[] = [];
  const lines = clean.split('\n');
  const rawLines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m = l.match(/^func\s+(?:\(\s*\w*\s*\*?\s*([A-Za-z_]\w*)[^)]*\)\s*)?([A-Za-z_]\w*)\s*[[(]/);
    if (m) {
      defs.push({ name: m[2], kind: m[1] ? 'method' : 'function', line: i + 1, signature: sig(rawLines[i]), parent: m[1] });
      continue;
    }
    m = l.match(/^\s*type\s+([A-Za-z_]\w*)\s+(struct|interface)?/);
    if (m) defs.push({ name: m[1], kind: m[2] === 'interface' ? 'interface' : m[2] === 'struct' ? 'struct' : 'type', line: i + 1, signature: sig(rawLines[i]) });
  }
  return defs;
}

function rust(clean: string, raw: string): SymbolDef[] {
  const defs: SymbolDef[] = [];
  const lines = clean.split('\n');
  const rawLines = raw.split('\n');
  let impl: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m = l.match(/^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([A-Za-z_]\w*)/);
    if (m) {
      impl = m[1];
      continue;
    }
    if (/^\}/.test(l)) impl = undefined;
    m = l.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z_]\w*)/);
    if (m) {
      defs.push({ name: m[1], kind: impl ? 'method' : 'function', line: i + 1, signature: sig(rawLines[i]), parent: impl });
      continue;
    }
    m = l.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|type|mod)\s+([A-Za-z_]\w*)/);
    if (m) defs.push({ name: m[2], kind: m[1] === 'trait' ? 'interface' : m[1] === 'mod' ? 'module' : (m[1] as DefKind), line: i + 1, signature: sig(rawLines[i]) });
  }
  return defs;
}

function generic(clean: string, raw: string): SymbolDef[] {
  // last resort: "function name", "def name", "proc name", "sub name"
  const defs: SymbolDef[] = [];
  const re = /^\s*(?:function|def|proc|sub|fn|func|entity|module|component|message|service|rpc)\s+([A-Za-z_]\w*)/gm;
  let m: RegExpExecArray | null;
  const rawLines = raw.split('\n');
  while ((m = re.exec(clean))) {
    const line = lineOf(clean, m.index);
    defs.push({ name: m[1], kind: 'function', line, signature: sig(rawLines[line - 1] ?? m[0]) });
  }
  return defs;
}

function collectRefs(clean: string, defs: SymbolDef[], limit = 400): Record<string, number> {
  const counts = new Map<string, number>();
  const own = new Map(defs.map((d) => [d.name, 1]));
  for (const m of clean.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
    const id = m[0];
    if (KEYWORDS.has(id)) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  // a definition's own declaration is not a reference
  for (const [name] of own) {
    const c = counts.get(name);
    if (c !== undefined) {
      if (c <= 1) counts.delete(name);
      else counts.set(name, c - 1);
    }
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit));
}

export function extractSymbols(content: string, lang: string): FileSymbols {
  const clean = stripCommentsAndStrings(content, lang);
  let defs: SymbolDef[];
  switch (lang) {
    case 'c':
    case 'cpp':
    case 'objc':
      defs = cLike(clean, content, lang);
      break;
    case 'java':
    case 'kotlin':
    case 'scala':
    case 'csharp':
    case 'swift':
      defs = javaLike(clean, content);
      break;
    case 'python':
      defs = python(clean, content);
      break;
    case 'javascript':
    case 'typescript':
      defs = jsLike(clean, content);
      break;
    case 'go':
      defs = golang(clean, content);
      break;
    case 'rust':
      defs = rust(clean, content);
      break;
    default:
      defs = generic(clean, content);
  }
  // de-duplicate (e.g. declaration + definition on adjacent lines)
  const seen = new Set<string>();
  defs = defs.filter((d) => {
    const k = `${d.kind}:${d.parent ?? ''}:${d.name}:${d.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { defs, refs: collectRefs(clean, defs), imports: extractImports(content, lang) };
}
