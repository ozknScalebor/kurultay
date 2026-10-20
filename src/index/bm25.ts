/** Small BM25 index over code chunks; tokenizer splits camelCase / snake_case. */

export interface Chunk {
  id: number;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*|\d+/g)) {
    const w = m[0];
    const lower = w.toLowerCase();
    if (lower.length > 1) out.push(lower);
    // split identifiers: sensorReadRaw → sensor read raw ; SENSOR_READ → sensor read
    const parts = w
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[_\s]+/)
      .map((p) => p.toLowerCase())
      .filter((p) => p.length > 1);
    if (parts.length > 1) out.push(...parts);
  }
  return out;
}

export function chunkFile(path: string, content: string, linesPerChunk = 60, overlap = 10): Omit<Chunk, 'id'>[] {
  const lines = content.split('\n');
  const chunks: Omit<Chunk, 'id'>[] = [];
  for (let start = 0; start < lines.length; start += linesPerChunk - overlap) {
    const end = Math.min(lines.length, start + linesPerChunk);
    chunks.push({ path, startLine: start + 1, endLine: end, text: lines.slice(start, end).join('\n') });
    if (end >= lines.length) break;
  }
  return chunks;
}

export class Bm25Index {
  private readonly chunks: Chunk[] = [];
  private readonly postings = new Map<string, Array<{ id: number; tf: number }>>();
  private readonly lengths: number[] = [];
  private avgLen = 0;

  constructor(
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {}

  add(chunk: Omit<Chunk, 'id'>, extraText = ''): void {
    const id = this.chunks.length;
    this.chunks.push({ ...chunk, id });
    const toks = tokenize(`${chunk.path} ${extraText} ${chunk.text}`);
    this.lengths.push(toks.length);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, n] of tf) {
      const list = this.postings.get(t) ?? [];
      list.push({ id, tf: n });
      this.postings.set(t, list);
    }
    this.avgLen = this.lengths.reduce((a, b) => a + b, 0) / this.lengths.length;
  }

  get size(): number {
    return this.chunks.length;
  }

  search(query: string, limit = 10, filter?: (c: Chunk) => boolean): Array<Chunk & { score: number }> {
    const qt = [...new Set(tokenize(query))];
    const scores = new Map<number, number>();
    const N = this.chunks.length;
    for (const t of qt) {
      const list = this.postings.get(t);
      if (!list) continue;
      const idf = Math.log(1 + (N - list.length + 0.5) / (list.length + 0.5));
      for (const { id, tf } of list) {
        const len = this.lengths[id];
        const s = idf * ((tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + (this.b * len) / (this.avgLen || 1))));
        scores.set(id, (scores.get(id) ?? 0) + s);
      }
    }
    return [...scores.entries()]
      .map(([id, score]) => ({ ...this.chunks[id], score }))
      .filter((c) => !filter || filter(c))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
