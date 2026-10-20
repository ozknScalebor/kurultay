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

/** Parse SEARCH/REPLACE blocks. The file path is the last non-empty, non-fence line before the block. */
export function parseSearchReplace(text: string, defaultPath?: string): SearchReplaceBlock[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: SearchReplaceBlock[] = [];
  let lastPath = defaultPath ?? '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!SEARCH_RE.test(line.trim())) {
      const t = line.trim().replace(/^[`*#]+|[`*:]+$/g, '').trim();
      if (t && !t.startsWith('```') && /^[\w./\\-]+\.[\w]+$|^[\w./\\-]*\/[\w.-]+$/.test(t)) lastPath = t;
      continue;
    }
    const search: string[] = [];
    const replace: string[] = [];
    let j = i + 1;
    while (j < lines.length && !DIVIDER_RE.test(lines[j].trim())) search.push(lines[j++]);
    if (j >= lines.length) throw new EditError('SEARCH bloğunda ======= ayırıcısı eksik');
    j++;
    while (j < lines.length && !REPLACE_RE.test(lines[j].trim())) replace.push(lines[j++]);
    if (j >= lines.length) throw new EditError('>>>>>>> REPLACE satırı eksik');
    if (!lastPath) throw new EditError('SEARCH/REPLACE bloğundan önce dosya yolu belirtilmemiş');
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
export function applyReplacement(content: string, oldText: string, newText: string, opts: { replaceAll?: boolean; path?: string } = {}): string {
  const label = opts.path ?? 'dosya';
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
    throw new EditError(`${label}: aranan metin ${exact} yerde geçiyor; benzersiz olması için daha fazla bağlam ekleyin veya replace_all kullanın.`);
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
    throw new EditError(`${label}: aranan blok ${matches.length} yerde eşleşiyor; daha fazla bağlam ekleyin.`);
  }
  const near = closestSnippet(content, oldText);
  const hint = near && near.score > 0.5 ? `\nEn yakın eşleşme (satır ${near.line}, benzerlik ${(near.score * 100).toFixed(0)}%):\n${near.snippet}` : '';
  throw new EditError(`${label}: aranan metin dosyada bulunamadı. Dosyayı tekrar okuyup birebir kopyalayın.${hint}`);
}

/** Apply a list of SEARCH/REPLACE blocks to an in-memory file map. */
export function applyBlocks(files: Map<string, string>, blocks: SearchReplaceBlock[]): { changed: string[]; errors: string[] } {
  const changed = new Set<string>();
  const errors: string[] = [];
  for (const b of blocks) {
    const cur = files.get(b.path);
    if (cur === undefined && b.search.trim() !== '') {
      errors.push(`${b.path}: dosya yok (yeni dosya için SEARCH bölümünü boş bırakın)`);
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
