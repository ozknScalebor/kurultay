import assert from 'node:assert/strict';
import { existsSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { executeTool, type ToolContext } from '../../src/agent/tools.js';
import { Materializer, Overlay } from '../../src/agent/workspace.js';
import { prepareRetrieval, type App } from '../../src/app.js';
import { VectorStore, cosine, normalise, resolveEmbedder, rrf, type Embedder } from '../../src/index/embeddings.js';
import { ProjectIndex } from '../../src/index/project-index.js';
import { Router } from '../../src/llm/router.js';
import { mockEmbedding, startMockServer, type MockServerHandle } from '../../src/mock/server.js';
import { config, recordingBus, tmpProject } from '../helpers.js';

let mock: MockServerHandle;
before(async () => {
  mock = await startMockServer([
    { id: 'chat-a', quality: 'good', tools: true, ctx: 32768 },
    { id: 'mock-embed-small', quality: 'good', tools: false, ctx: 8192, embedding: true },
  ]);
});
after(() => mock.close());

const PROJECT = {
  'src/thermal.c': '#include "thermal.h"\n\nint check_temperature_threshold(int celsius) {\n  return celsius > MAX_TEMPERATURE ? -1 : 0;\n}\n',
  'src/thermal.h': '#define MAX_TEMPERATURE 85\nint check_temperature_threshold(int celsius);\n',
  'src/login.c': 'int authenticate_user(const char *user, const char *password) {\n  return verify(user, password);\n}\n',
  'src/billing.c': 'double invoice_total(double price, int qty) { return price * qty; }\n',
  'src/nerede.c': '/* nerede kontrol ediliyor: logging helpers */\nvoid log_line(const char *s) {}\n',
};

function indexed(files: Record<string, string> = PROJECT) {
  const root = tmpProject(files);
  const index = new ProjectIndex(root, join(root, '.kurultay'));
  index.build();
  return { root, index };
}

const cfgFor = (extra: Record<string, unknown> = {}) => config({ endpoints: [{ name: 'e', baseUrl: mock.url }], ...extra });

describe('embeddings: vector math and storage', () => {
  it('normalises, compares and fuses rankings', () => {
    const a = normalise([3, 4]);
    assert.ok(Math.abs(a[0] - 0.6) < 1e-6);
    assert.equal(normalise([0, 0])[0], 0);
    assert.ok(Math.abs(cosine(a, normalise([3, 4])) - 1) < 1e-6);
    const fused = rrf([['x', 'y', 'z'], ['y', 'w']], (s) => s);
    assert.deepEqual(fused.map((f) => f.item), ['y', 'x', 'w', 'z']);
    assert.ok(cosine(normalise(mockEmbedding('sıcaklık sınırı')), normalise(mockEmbedding('MAX_TEMPERATURE threshold'))) > 0.9, 'mock embeddings know the synonyms');
  });

  it('stores vectors per chunk hash, drops stale ones and resets for another model', () => {
    const file = join(tmpProject({}), 'idx', 'vectors.json');
    const s = new VectorStore(file, 'm@e');
    s.set('h1', normalise([1, 2, 3]));
    s.set('h2', normalise([3, 2, 1]));
    s.save();
    s.save(); // not dirty → no-op
    const again = new VectorStore(file, 'm@e');
    assert.equal(again.size, 2);
    assert.ok(Math.abs(cosine(again.get('h1')!, normalise([1, 2, 3])) - 1) < 1e-6);
    assert.equal(again.get('nope'), undefined);
    assert.equal(again.retain(new Set(['h1'])), 1);
    again.save();
    assert.equal(new VectorStore(file, 'm@e').size, 1);
    assert.equal(new VectorStore(file, 'other@e').size, 0, 'vectors of another model are not mixed');
    writeFileSync(file, 'broken');
    assert.equal(new VectorStore(file, 'm@e').size, 0);
  });
});

describe('embeddings: discovery and hybrid search', () => {
  it('finds the embedding model on the endpoint and never registers it as a chat model', async () => {
    const auto = await resolveEmbedder(cfgFor(), recordingBus());
    assert.equal(auto?.key, 'mock-embed-small@e');
    assert.equal((await resolveEmbedder(cfgFor({ embeddings: { model: 'custom-embed', endpoint: 'e' } })))?.key, 'custom-embed@e');
    assert.equal(await resolveEmbedder(cfgFor({ embeddings: { mode: 'off' } })), undefined);
    assert.equal(await resolveEmbedder(config({ endpoints: [{ name: 'dead', baseUrl: 'http://127.0.0.1:9/v1' }] })), undefined);
    assert.equal(await resolveEmbedder(cfgFor({ embeddings: { endpoint: 'nope' } })), undefined);
    const found = await new Router(cfgFor()).discover();
    assert.deepEqual(found.map((c) => c.model), ['chat-a']);
  });

  it('builds vectors incrementally and finds code by meaning (BM25 + embeddings, RRF)', async () => {
    const { root, index } = indexed();
    const query = 'sıcaklık sınırı nerede kontrol ediliyor';
    const lexical = index.search(query, 3).map((h) => h.path);
    assert.notEqual(lexical[0], 'src/thermal.c', 'BM25 alone misses the Turkish wording');
    // no embedder → plain BM25
    assert.deepEqual((await index.hybridSearch(query, 3)).map((h) => h.path), lexical);
    assert.equal(index.vectorCount, 0);

    index.embedder = (await resolveEmbedder(cfgFor()))!;
    const progress: number[] = [];
    const first = await index.buildVectors({ batch: 2, onProgress: (d) => progress.push(d) });
    assert.equal(first.embedded, 5);
    assert.deepEqual(progress, [2, 4, 5]);
    assert.ok(mock.embedCalls.every((n) => n <= 2));
    assert.equal((await index.buildVectors()).embedded, 0, 'unchanged chunks are not embedded again');
    const hits = (await index.hybridSearch(query, 3)).map((h) => h.path);
    assert.ok(hits.includes('src/thermal.c') && hits.includes('src/thermal.h'), JSON.stringify({ hits, lexical }));
    assert.ok(hits.includes('src/nerede.c'), 'the lexical match stays in the fused list');
    assert.ok(!hits.includes('src/billing.c') && !hits.includes('src/login.c'));
    const semanticOnly = (await index.hybridSearch('sıcaklık eşiği', 1)).map((h) => h.path);
    assert.match(semanticOnly[0], /thermal/, 'no lexical overlap at all: meaning alone finds it');
    assert.deepEqual((await index.hybridSearch('kullanıcı şifre', 2, 'src/login*')).map((h) => h.path), ['src/login.c']);

    // edit one file, delete another → only the changed chunk is embedded, the deleted one dropped
    writeFileSync(join(root, 'src/billing.c'), 'double invoice_total(double price, int qty, double tax) { return price * qty * tax; }\n');
    unlinkSync(join(root, 'src/nerede.c'));
    index.build();
    const upd = await index.buildVectors();
    assert.deepEqual([upd.embedded, upd.removed, upd.total], [1, 2, 4]);
    assert.ok(existsSync(VectorStore.pathFor(join(root, '.kurultay'))));
  });

  it('falls back to BM25 when the embedding model is unreachable', async () => {
    const { index } = indexed();
    index.embedder = (await resolveEmbedder(cfgFor()))!;
    await index.buildVectors();
    const broken: Embedder = { key: index.embedder.key, embed: async () => Promise.reject(new Error('down')) };
    index.embedder = broken;
    const hits = await index.hybridSearch('temperature', 2);
    assert.equal(hits[0].path, index.search('temperature', 2)[0].path);
  });

  it('search_code and prepareRetrieval use it; failures are reported, not fatal', async () => {
    const { root, index } = indexed();
    const bus = recordingBus();
    const app = { config: cfgFor(), bus } as unknown as App;
    const r = await prepareRetrieval(app, index);
    assert.deepEqual([r.model, r.embedded, r.vectors], ['mock-embed-small@e', 5, 5]);
    const ctx: ToolContext = { workerId: 'w', root, overlay: new Overlay('w', root), index, materializer: new Materializer(root, join(root, '.kurultay')), config: app.config, readFiles: new Set(), writtenFiles: new Set(), staleFiles: new Set() };
    const out = await executeTool('search_code', { query: 'sıcaklık eşiği' }, ctx);
    assert.match(out.output.split('\n')[0], /src\/thermal\.(c|h)/);

    const none = await prepareRetrieval({ config: cfgFor({ embeddings: { mode: 'off' } }), bus } as unknown as App, indexed().index);
    assert.deepEqual(none, { embedded: 0, vectors: 0 });
    const bad = indexed().index;
    bad.embedder = { key: 'x@e', embed: async () => Promise.reject(new Error('503')) };
    const failed = await prepareRetrieval(app, bad);
    assert.match(failed.error!, /503/);
    assert.ok(bus.ofType('log.warn').some((e) => /BM25 ile devam/.test(e.message ?? '')));
    rmSync(root, { recursive: true, force: true });
  });
});
