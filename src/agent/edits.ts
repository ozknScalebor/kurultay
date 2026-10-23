/**
 * Robust text edits for LLM output.
 *  - SEARCH/REPLACE blocks (Aider style) for models without native tools
 *  - old_text/new_text replacement used by the edit_file tool
 * Matching cascade: exact → trailing-whitespace-insensitive → indentation-insensitive
 * (re-indenting the replacement) → fails with a "closest match" hint so the
 * model can correct itself on the next turn.
 */

export interface SearchReplaceBlock {
  path: string;
  search: string;
  replace: string;
}

export class EditError extends Error {}

const SEARCH_RE = /^<{5,9} ?SEARCH\s*$/;
const DIVIDER_RE = /^={5,9}\s*$/;
const REPLACE_RE = /^>{5,9} ?REPLACE\s*$/;

const PATH_RE = /^[\w.\\/-]*[\w-]\.[A-Za-z0-9]{1,8}$|^[\w.\\/-]*\/[\w.-]+$/;

/**
 * Extract a file path from a line preceding a SEARCH block. Accepts a bare path,
 * markdown decorations (`path`, **path**, ### path) and prose such as
 * "Edit `src/a.c`:" or "In file src/a.c:".
 */
export function pathFromLine(line: string): string | undefined {
  const t = line.trim();
  if (!t || t.startsWith('```')) return undefined;
  const bare = t.replace(/^[#>*\-\s]+|[`*:]+$/g, '').replace(/^[`*]+/, '').trim();
  if (PATH_RE.test(bare)) return bare;
  if (/^(?:[\w.-]+\/)*(?:Makefile|makefile|GNUmakefile|Dockerfile|Kconfig|Jenkinsfile|Rakefile|Gemfile)$/.test(bare)) return bare;
  const ticked = [...t.matchAll(/`([^`\s]+)`|\*\*([^*\s]+)\*\*/g)].map((m) => m[1] ?? m[2]).filter((x) => PATH_RE.test(x));
  if (ticked.length) return ticked[ticked.length - 1];
  const words = t.split(/\s+/).map((w) => w.replace(/^[("'`]+|[)"'`:,;.]+$/g, '')).filter((w) => PATH_RE.test(w) && /[/\\]|\.[a-z]{1,5}$/i.test(w) && !/^\d+(\.\d+)+$/.test(w));
  return words.length ? words[words.length - 1] : undefined;
}

/** Parse SEARCH/REPLACE blocks. The file path is the last non-empty, non-fence line before the block. */
export function parseSearchReplace(text: string, defaultPath?: string): SearchReplaceBlock[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: SearchReplaceBlock[] = [];
  let lastPath = defaultPath ?? '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!SEARCH_RE.test(line.trim())) {
      const p = pathFromLine(line);
      if (p) lastPath = p;
      continue;
    }
    const search: string[] = [];
    const replace: string[] = [];
    let j = i + 1;
    while (j < lines.length && !DIVIDER_RE.test(lines[j].trim())) search.push(lines[j++]);
    if (j >= lines.length) throw new EditError('SEARCH block is missing the ======= separator');
    j++;
    while (j < lines.length && !REPLACE_RE.test(lines[j].trim())) replace.push(lines[j++]);
    if (j >= lines.length) throw new EditError('>>>>>>> REPLACE line is missing');
    if (!lastPath) throw new EditError('no file path before the SEARCH/REPLACE block');
    blocks.push({ path: lastPath, search: search.join('\n'), replace: replace.join('\n') });
    i = j;
  }
  return blocks;
}

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) {
    n++;
    i += needle.length;
  }
  return n;
}

function leadingWs(s: string): string {
  return s.match(/^[ \t]*/)![0];
}

/** Line-based search with a normalisation function. Returns start line indices of matches. */
function findLineMatches(fileLines: string[], searchLines: string[], norm: (s: string) => string): number[] {
  const out: number[] = [];
  const target = searchLines.map(norm);
  outer: for (let i = 0; i + target.length <= fileLines.length; i++) {
    for (let k = 0; k < target.length; k++) {
      if (norm(fileLines[i + k]) !== target[k]) continue outer;
    }
    out.push(i);
  }
  return out;
}

function similarity(a: string, b: string): number {
  // Dice coefficient on bigrams – cheap and good enough for hints.
  const grams = (s: string) => {
    const m = new Map<string, number>();
    const t = s.replace(/\s+/g, ' ');
    for (let i = 0; i < t.length - 1; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  let total = 0;
  for (const [g, n] of ga) {
    inter += Math.min(n, gb.get(g) ?? 0);
    total += n;
  }
  for (const n of gb.values()) total += n;
  return total ? (2 * inter) / total : 0;
}

export function closestSnippet(content: string, search: string): { line: number; snippet: string; score: number } | undefined {
  const fileLines = content.split('\n');
  const n = Math.max(1, search.split('\n').length);
  let best: { line: number; snippet: string; score: number } | undefined;
  for (let i = 0; i + n <= fileLines.length; i++) {
    const snippet = fileLines.slice(i, i + n).join('\n');
    const score = similarity(snippet, search);
    if (!best || score > best.score) best = { line: i + 1, snippet, score };
  }
  return best;
}

/**
 * Replace `oldText` with `newText` inside `content`.
 * Throws EditError with an actionable hint when it cannot apply unambiguously.
 */
/** Smart quotes, dashes, NBSP and friends → ASCII (Pi edit-diff, Codex seek_sequence). */
export function normalizeUnicode(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2007\u202F\u2009\u200A]/g, ' ')
    .replace(/\u2026/g, '...');
}

export function applyReplacement(content: string, oldText: string, newText: string, opts: { replaceAll?: boolean; path?: string } = {}): string {
  // Preserve Windows line endings: match on LF, write back CRLF (Pi edit-diff).
  if (content.includes('\r\n')) {
    const lf = (t: string) => t.replace(/\r\n/g, '\n');
    return applyReplacementLF(lf(content), lf(oldText), lf(newText), opts).replace(/\n/g, '\r\n');
  }
  return applyReplacementLF(content, oldText.replace(/\r\n/g, '\n'), newText.replace(/\r\n/g, '\n'), opts);
}

function applyReplacementLF(content: string, oldText: string, newText: string, opts: { replaceAll?: boolean; path?: string }): string {
  const label = opts.path ?? 'file';
  if (oldText === '') {
    // empty search: append (or create)
    return content ? content.replace(/\n?$/, '\n') + newText : newText;
  }
  // 1) exact
  const exact = countOccurrences(content, oldText);
  if (exact === 1 || (exact > 1 && opts.replaceAll)) {
    return opts.replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, () => newText);
  }
  if (exact > 1) {
    throw new EditError(`${label}: the search text occurs ${exact} times; add more context to make it unique or use replace_all.`);
  }

  const fileLines = content.split('\n');
  const searchLines = oldText.replace(/\n$/, '').split('\n');
  const replLines = newText.replace(/\n$/, '').split('\n');

  // 2) trailing whitespace insensitive
  let matches = findLineMatches(fileLines, searchLines, (s) => s.trimEnd());
  let reindent = false;
  // 3) indentation insensitive
  if (matches.length === 0) {
    matches = findLineMatches(fileLines, searchLines, (s) => s.trim());
    reindent = matches.length > 0;
  }
  // 4) unicode punctuation insensitive (smart quotes / dashes typed by the model)
  if (matches.length === 0) {
    matches = findLineMatches(fileLines, searchLines, (s) => normalizeUnicode(s).trim());
    reindent = matches.length > 0;
  }
  if (matches.length === 1 || (matches.length > 1 && opts.replaceAll)) {
    const targets = opts.replaceAll ? matches : [matches[0]];
    // apply from the bottom so indices stay valid
    for (const start of [...targets].reverse()) {
      let repl = replLines;
      if (reindent) {
        const firstNonEmpty = searchLines.findIndex((l) => l.trim());
        const fileIndent = leadingWs(fileLines[start + Math.max(0, firstNonEmpty)]);
        const searchIndent = leadingWs(searchLines[Math.max(0, firstNonEmpty)]);
        repl = replLines.map((l) => {
          if (!l.trim()) return l;
          if (l.startsWith(searchIndent)) return fileIndent + l.slice(searchIndent.length);
          return fileIndent + l.trimStart();
        });
      }
      fileLines.splice(start, searchLines.length, ...repl);
    }
    return fileLines.join('\n');
  }
  if (matches.length > 1) {
    throw new EditError(`${label}: the search block matches ${matches.length} places; add more context.`);
  }
  const near = closestSnippet(content, oldText);
  const hint = near && near.score > 0.5 ? `\nClosest match (line ${near.line}, ${(near.score * 100).toFixed(0)}% similar):\n${near.snippet}` : '';
  throw new EditError(`${label}: the search text was not found in the file. Read the file again and copy the lines exactly.${hint}`);
}

/** Apply a list of SEARCH/REPLACE blocks to an in-memory file map. */
export function applyBlocks(files: Map<string, string>, blocks: SearchReplaceBlock[]): { changed: string[]; errors: string[] } {
  const changed = new Set<string>();
  const errors: string[] = [];
  for (const b of blocks) {
    const cur = files.get(b.path);
    if (cur === undefined && b.search.trim() !== '') {
      errors.push(`${b.path}: no such file (leave SEARCH empty for a new file)`);
      continue;
    }
    try {
      files.set(b.path, applyReplacement(cur ?? '', b.search, b.replace, { path: b.path }));
      changed.add(b.path);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return { changed: [...changed], errors };
}
