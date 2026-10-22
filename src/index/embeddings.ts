import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EmbeddingsConfig, EndpointConfig, KurultayConfig } from '../config.js';
import { OpenAICompatClient } from '../llm/client.js';
import type { EventBus } from '../util/events.js';
import type { Chunk } from './bm25.js';

/**
 * Semantic retrieval with a local embedding model (bge, e5, nomic-embed, gte,
 * Qwen3-Embedding … served by vLLM / llama.cpp / Ollama / TEI). Vectors are
 * stored per chunk hash in <stateDir>/index/vectors.json (Float32 as base64),
 * so re-indexing only embeds chunks that changed. Search combines BM25 and
 * cosine similarity with Reciprocal Rank Fusion – identifiers still win through
 * BM25 while "where is the temperature limit checked?" finds code that never
 * uses those words.
 */

/** Model ids that are embedding / reranking / audio models, not chat models. */
export const NON_CHAT_MODEL = /embed|rerank|bge-|\be5-|nomic-embed|gte-|minilm|whisper|tts/i;
const EMBED_MODEL = /embed|bge-|\be5-|gte-|minilm/i;

export interface Embedder {
  /** "model@endpoint" */
  key: string;
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

/** Normalised Float32 vectors from any OpenAI-compatible endpoint. */
export function clientEmbedder(ep: EndpointConfig, model: string, timeoutMs?: number): Embedder {
  const client = new OpenAICompatClient(ep);
  return {
    key: `${model}@${ep.name}`,
    async embed(texts, signal) {
      const out = await client.embed(model, texts, signal, timeoutMs);
      return out.map(normalise);
    },
  };
}

export function normalise(v: number[] | Float32Array): Float32Array {
  const f = Float32Array.from(v);
  let n = 0;
  for (const x of f) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < f.length; i++) f[i] /= n;
  return f;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/**
 * Find the embedding model: config.embeddings.model (on .endpoint or the first
 * endpoint), or in "auto" mode the first model whose id looks like an embedding
 * model in any endpoint's /models list.
 */
export async function resolveEmbedder(config: KurultayConfig, bus?: EventBus, signal?: AbortSignal): Promise<Embedder | undefined> {
  const ec: EmbeddingsConfig = config.embeddings ?? {};
  if (ec.mode === 'off') return undefined;
  const endpoints = config.endpoints.filter((e) => !e.disabled);
  if (ec.model) {
    const ep = (ec.endpoint ? endpoints.find((e) => e.name === ec.endpoint) : endpoints[0]) ?? endpoints[0];
    return ep ? clientEmbedder(ep, ec.model, ec.timeoutMs) : undefined;
  }
  for (const ep of ec.endpoint ? endpoints.filter((e) => e.name === ec.endpoint) : endpoints) {
    try {
      const ids = await new OpenAICompatClient(ep).listModels(signal ?? AbortSignal.timeout(5000));
      const m = ids.find((x) => EMBED_MODEL.test(x.id) && !/rerank/i.test(x.id));
      if (m) {
        bus?.info('embeddings', `anlamsal arama modeli: ${m.id}@${ep.name}`);
        return clientEmbedder(ep, m.id, ec.timeoutMs);
      }
    } catch {
      /* endpoint down: lexical search still works */
    }
  }
  return undefined;
}

interface VectorFile {
  version: 1;
  model: string;
  dims: number;
  vectors: Record<string, string>;
}

/** Persistent chunk-hash → vector store. */
export class VectorStore {
  private data: VectorFile;
  private decoded = new Map<string, Float32Array>();
  dirty = false;

  constructor(
    private readonly file: string,
    readonly model: string,
  ) {
    let d: VectorFile | undefined;
    if (existsSync(file)) {
      try {
        d = JSON.parse(readFileSync(file, 'utf8')) as VectorFile;
      } catch {
        d = undefined;
      }
    }
    // another embedding model → incomparable vectors, start over
    this.data = d && d.version === 1 && d.model === model ? d : { version: 1, model, dims: 0, vectors: {} };
  }

  static pathFor(stateDir: string): string {
    return join(stateDir, 'index', 'vectors.json');
  }

  get size(): number {
    return Object.keys(this.data.vectors).length;
  }

  has(hash: string): boolean {
    return hash in this.data.vectors;
  }

  get(hash: string): Float32Array | undefined {
    let v = this.decoded.get(hash);
    if (!v && this.data.vectors[hash]) {
      const buf = Buffer.from(this.data.vectors[hash], 'base64');
      v = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      this.decoded.set(hash, v);
    }
    return v;
  }

  set(hash: string, v: Float32Array): void {
    this.data.dims = v.length;
    this.data.vectors[hash] = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
    this.decoded.set(hash, v);
    this.dirty = true;
  }

  /** Drop vectors of chunks that no longer exist. */
  retain(hashes: Set<string>): number {
    let n = 0;
    for (const h of Object.keys(this.data.vectors)) {
      if (!hashes.has(h)) {
        delete this.data.vectors[h];
        this.decoded.delete(h);
        n++;
      }
    }
    if (n) this.dirty = true;
    return n;
  }

  save(): void {
    if (!this.dirty) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
    this.dirty = false;
  }
}

/** Reciprocal Rank Fusion of several ranked lists (k = 60, as in the original paper). */
export function rrf<T>(lists: T[][], key: (x: T) => string, k = 60): Array<{ item: T; score: number }> {
  const acc = new Map<string, { item: T; score: number }>();
  for (const list of lists) {
    list.forEach((x, rank) => {
      const id = key(x);
      const e = acc.get(id) ?? { item: x, score: 0 };
      e.score += 1 / (k + rank + 1);
      acc.set(id, e);
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score);
}

/** Text that is embedded for a chunk (path gives the model useful context). */
export function chunkText(c: Pick<Chunk, 'path' | 'text'>, maxChars = 6000): string {
  return `${c.path}\n${c.text}`.slice(0, maxChars);
}
