/** Text helpers: token estimation, JSON extraction from LLM output, truncation. */

/** Rough token estimate (works for code and Latin text without a tokenizer). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.6);
}

export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head - 40;
  return `${text.slice(0, head)}\n…[${text.length - head - Math.max(tail, 0)} characters cut]…\n${text.slice(text.length - Math.max(tail, 0))}`;
}

export function truncateTokens(text: string, maxTokens: number): string {
  return truncateMiddle(text, Math.floor(maxTokens * 3.6));
}

/** Strip <think>…</think> reasoning blocks some local models emit. */
export function stripThinking(text: string): { content: string; thinking: string } {
  let thinking = '';
  let content = text.replace(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi, (_m, t: string) => {
    thinking += t;
    return '';
  });
  // unterminated think block at start (streams cut early)
  const open = content.match(/^\s*<think(?:ing)?>([\s\S]*)$/i);
  if (open) {
    thinking += open[1];
    content = '';
  }
  return { content: content.trim(), thinking: thinking.trim() };
}

function findBalanced(text: string, start: number): number {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function lenientParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // common LLM mistakes: trailing commas, smart quotes, comments
    const repaired = raw
      .replace(/\/\/[^\n"]*$/gm, '')
      .replace(/[“”]/g, '"')
      .replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(repaired);
  }
}

/**
 * Extract the first JSON value from free-form LLM output.
 * Prefers fenced ```json blocks, then the first balanced object/array.
 */
export function extractJson<T = unknown>(text: string): T {
  const { content } = stripThinking(text);
  const src = content || text;
  const fences = [...src.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)```/g)];
  for (const f of fences) {
    try {
      return lenientParse(f[1].trim()) as T;
    } catch {
      /* try next */
    }
  }
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{' || c === '[') {
      const end = findBalanced(src, i);
      if (end > i) {
        try {
          return lenientParse(src.slice(i, end + 1)) as T;
        } catch {
          /* keep scanning */
        }
      }
    }
  }
  throw new Error('no valid JSON in the LLM output');
}

export function tryExtractJson<T = unknown>(text: string): T | undefined {
  try {
    return extractJson<T>(text);
  } catch {
    return undefined;
  }
}

export function slug(s: string): string {
  return s
    .replace(/İ/g, 'i')
    .replace(/ı/g, 'i')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'x';
}

export function indent(text: string, pad = '  '): string {
  return text
    .split('\n')
    .map((l) => (l ? pad + l : l))
    .join('\n');
}

/** Stable short hash (FNV-1a 32-bit) – used for anonymisation labels and caching keys. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** "1 file", "3 files", "2 dependencies" – counts in user-facing text. */
export function plural(n: number, noun: string): string {
  if (n === 1) return `${n} ${noun}`;
  return `${n} ${/[^aeiou]y$/.test(noun) ? noun.slice(0, -1) + 'ies' : noun + 's'}`;
}
