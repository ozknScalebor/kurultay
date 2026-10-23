import { extname } from 'node:path';
import { LANG_BY_EXT } from '../index/scanner.js';
import { stripCommentsAndStrings } from '../index/symbols.js';

/**
 * Cheap, dependency-free post-edit sanity check (offline stand-in for Aider's
 * tree-sitter lint, Crush/Serena LSP diagnostics and omp auto-repair):
 * reports when an edit makes bracket balance worse or breaks JSON.
 * It never blocks an edit – the warning is appended to the tool result so the
 * model can fix it on its next turn.
 */

const BRACKET_LANGS = new Set(['c', 'cpp', 'objc', 'java', 'kotlin', 'scala', 'csharp', 'javascript', 'typescript', 'go', 'rust', 'swift', 'php', 'qml', 'proto']);

interface Balance {
  curly: number;
  paren: number;
  square: number;
}

export function bracketBalance(code: string, lang: string): Balance {
  const clean = stripCommentsAndStrings(code, lang);
  const b: Balance = { curly: 0, paren: 0, square: 0 };
  for (const ch of clean) {
    if (ch === '{') b.curly++;
    else if (ch === '}') b.curly--;
    else if (ch === '(') b.paren++;
    else if (ch === ')') b.paren--;
    else if (ch === '[') b.square++;
    else if (ch === ']') b.square--;
  }
  return b;
}

function langFor(path: string): string | undefined {
  return LANG_BY_EXT[extname(path)] ?? LANG_BY_EXT[extname(path).toLowerCase()];
}

/** Returns a warning text, or '' when the edit looks syntactically fine. */
export function postEditCheck(path: string, before: string | undefined, after: string): string {
  const lang = langFor(path);
  if (!lang) return '';
  if (lang === 'json') {
    const valid = (s: string | undefined) => {
      if (s === undefined) return true;
      try {
        JSON.parse(s);
        return true;
      } catch {
        return false;
      }
    };
    if (valid(before) && !valid(after)) {
      try {
        JSON.parse(after);
      } catch (e) {
        return `⚠ After the edit ${path} is not valid JSON: ${(e as Error).message}. Read the file and fix it.`;
      }
    }
    return '';
  }
  if (!BRACKET_LANGS.has(lang)) return '';
  const a = bracketBalance(after, lang);
  const b = before === undefined ? { curly: 0, paren: 0, square: 0 } : bracketBalance(before, lang);
  const problems: string[] = [];
  const names: Record<keyof Balance, string> = { curly: '{ }', paren: '( )', square: '[ ]' };
  for (const k of Object.keys(a) as Array<keyof Balance>) {
    if (Math.abs(a[k]) > Math.abs(b[k])) problems.push(`${names[k]} balance ${a[k] > 0 ? '+' : ''}${a[k]}`);
  }
  if (!problems.length) return '';
  return `⚠ After the edit the brackets in ${path} are unbalanced (${problems.join(', ')}). Probably a missing/extra bracket: read that region with read_file and fix it.`;
}
