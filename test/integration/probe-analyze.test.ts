import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ProjectAnalyzer } from '../../src/analyze/summarizer.js';
import { ProjectIndex } from '../../src/index/project-index.js';
import { startMockServer, type MockModel, type MockServerHandle } from '../../src/mock/server.js';
import { probeAll, writeCapabilities } from '../../src/probe/probe.js';
import { startDashboard } from '../../src/ui/dashboard.js';
import { attachTerminal } from '../../src/ui/terminal.js';
import { caps, config, lastUser, recordingBus, routerFor, tmpProject } from '../helpers.js';

const servers: MockServerHandle[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});
async function mock(models: MockModel[]) {
  const s = await startMockServer(models);
  servers.push(s);
  return s;
}

describe('probe – edge cases', () => {
  it('finds the real context window with the ladder when the server does not report it', async () => {
    const s = await mock([
      { id: 'hidden16k', quality: 'good', tools: true, ctx: 16_384, hideCtx: true },
      { id: 'hidden-big', quality: 'good', tools: true, ctx: 200_000, hideCtx: true },
    ]);
    const file = await probeAll(config({ endpoints: [{ name: 'e', baseUrl: s.url }] }), recordingBus(), { quick: true });
    const by = Object.fromEntries(file.models.map((m) => [m.model, m]));
    assert.equal(by.hidden16k.contextWindow, 16_384);
    assert.equal(by['hidden-big'].contextWindow, 32_768, 'non-deep ladder stops at 32k');
    assert.ok(by['hidden-big'].notes.some((n) => /--deep/.test(n)));
    const deep = await probeAll(config({ endpoints: [{ name: 'e', baseUrl: s.url, models: ['hidden-big'] }] }), undefined, { quick: true, deep: true });
    assert.equal(deep.models[0].contextWindow, 131_072, 'deep ladder climbs to the last rung that fits');
  });

  it('skips embedding models, honours preset concurrency and quick mode', async () => {
    const s = await mock([
      { id: 'coder', quality: 'good', tools: true, ctx: 32_768 },
      { id: 'nomic-embed-text', quality: 'good', tools: true, ctx: 8192 },
      { id: 'bge-reranker', quality: 'good', tools: true, ctx: 8192 },
    ]);
    const file = await probeAll(config({ endpoints: [{ name: 'e', baseUrl: s.url, maxConcurrency: 6 }] }), undefined, { quick: true });
    assert.deepEqual(file.models.map((m) => m.model), ['coder']);
    assert.equal(file.models[0].maxConcurrency, 6);
    const prompts = s.log.map((l) => lastUser(l.body.messages as Array<{ role: string; content: string }>));
    assert.ok(!prompts.some((p) => /rivers/.test(p)), 'no concurrency ramp when preset');
    assert.ok(!prompts.some((p) => /toRoman/.test(p)), 'no benchmark in quick mode');
  });

  it('marks unreachable endpoints and models, keeps probing the rest', async () => {
    const s = await mock([
      { id: 'ok', quality: 'good', tools: true, ctx: 32_768 },
      { id: 'broken', quality: 'good', tools: true, ctx: 32_768, handler: () => ({ status: 401, error: 'no' }) },
    ]);
    const bus = recordingBus();
    const cfg = config({ endpoints: [{ name: 'e', baseUrl: s.url }, { name: 'gone', baseUrl: 'http://127.0.0.1:9/v1' }, { name: 'listed', baseUrl: 'http://127.0.0.1:9/v1', models: ['ghost'] }] });
    const t0 = Date.now();
    const file = await probeAll(cfg, bus, { quick: true, retryDelayMs: 5 });
    assert.ok(Date.now() - t0 < 5000);
    const by = Object.fromEntries(file.models.map((m) => [m.key, m]));
    assert.equal(by['ok@e'].reachable, true);
    assert.equal(by['broken@e'].reachable, false);
    assert.equal(by['ghost@listed'].reachable, false, 'configured models are tried even without /models');
    assert.deepEqual(Object.values(by['broken@e'].roleScores), [0, 0, 0, 0, 0, 0]);
    assert.ok(bus.ofType('log.error').some((e) => /gone/.test(e.source ?? '')));
  });

  it('scores weak instruction followers lower and detects missing JSON mode', async () => {
    const s = await mock([
      { id: 'strong', quality: 'good', tools: true, ctx: 32_768 },
      { id: 'weak', quality: 'bad', tools: false, ctx: 32_768 },
    ]);
    const file = await probeAll(config({ endpoints: [{ name: 'e', baseUrl: s.url, maxConcurrency: 2 }] }), undefined, {});
    const by = Object.fromEntries(file.models.map((m) => [m.model, m]));
    assert.equal(by.strong.jsonMode, true);
    assert.equal(by.weak.jsonMode, false);
    assert.ok(by.strong.instructionScore > by.weak.instructionScore);
    assert.equal(by.strong.editScore, 1);
    assert.equal(by.weak.editScore, 0);
    assert.ok(by.strong.roleScores.planner > by.weak.roleScores.planner);
    const root = tmpProject({});
    const paths = writeCapabilities(join(root, '.kurultay'), file);
    assert.equal(JSON.parse(readFileSync(paths.json, 'utf8')).models.length, 2);
  });
});

describe('analyze – batching, failures, incrementality', () => {
  function project(n: number): Record<string, string> {
    const files: Record<string, string> = { 'README.md': '# Demo\nA demo project.' };
    for (let i = 0; i < n; i++) files[`src/mod${i % 3}/f${i}.c`] = `#include "common.h"\nint f${i}(int x) {\n  return x + ${i}; /* ${'padding '.repeat(300)} */\n}\n`;
    files['src/main.c'] = 'int main(void) {\n  return f1(0) + f2(0);\n}\n';
    return files;
  }

  it('splits work into batches that fit the smallest model and spreads it across models', async () => {
    const s = await mock([
      { id: 'a', quality: 'good', tools: true, ctx: 4000 },
      { id: 'b', quality: 'good', tools: true, ctx: 4000 },
    ]);
    const root = tmpProject(project(12));
    const cfg = config({ endpoints: [{ name: 'e', baseUrl: s.url }] });
    const router = routerFor(cfg, [caps('a', 'e', { contextWindow: 4000, maxConcurrency: 4 }), caps('b', 'e', { contextWindow: 4000 })]);
    const idx = new ProjectIndex(root, join(root, '.kurultay'));
    idx.build();
    const r = await new ProjectAnalyzer(idx, router, cfg).run({ architectureDrafts: 2 });
    const batches = s.log.filter((l) => /Summarize each source file/.test(lastUser(l.body.messages as Array<{ role: string; content: string }>))).length;
    assert.ok(batches >= 3, `expected several batches, got ${batches}`);
    assert.equal(r.failures, 0);
    assert.equal(Object.keys(r.modelsUsed).length, 2, 'both models did work');
    assert.ok(idx.files.filter((f) => f.lang === 'c').every((f) => f.summary));
    const arch = readFileSync(r.architecturePath, 'utf8');
    assert.match(arch, /m_src_mod0/);
    assert.ok(readdirSync(join(root, '.kurultay', 'modules')).length >= 3);
    assert.match(readFileSync(join(root, '.kurultay', 'INDEX.md'), 'utf8'), /src\/main\.c/);
  });

  it('tolerates failing batches, then only re-summarizes what is missing or changed', async () => {
    let failSummaries = true;
    const s = await mock([{ id: 'm', quality: 'good', tools: true, ctx: 65536, handler: (q) => (failSummaries && /Summarize each source file/.test(lastUser(q.messages)) && /f1\.c/.test(lastUser(q.messages)) ? { status: 400, error: 'bad batch' } : undefined) }]);
    const root = tmpProject(project(4));
    const cfg = config({ endpoints: [{ name: 'e', baseUrl: s.url }] });
    const router = routerFor(cfg, [caps('m', 'e', { contextWindow: 65536 })]);
    const bus = recordingBus();
    const idx = new ProjectIndex(root, join(root, '.kurultay'));
    idx.build();
    const first = await new ProjectAnalyzer(idx, router, cfg, bus).run({});
    assert.ok(first.failures >= 1);
    assert.ok(existsSync(first.architecturePath), 'architecture still produced');
    assert.ok(bus.ofType('log.warn').some((e) => /summary batch failed/.test(e.message ?? '')));
    const missing = idx.needsSummary().length;
    assert.ok(missing > 0);
    failSummaries = false;
    const second = await new ProjectAnalyzer(idx, router, cfg).run({ architectureDrafts: 1 });
    assert.equal(second.filesSummarized, missing, 'only the files without summary are redone');
    const third = await new ProjectAnalyzer(idx, router, cfg).run({ architectureDrafts: 1 });
    assert.equal(third.filesSummarized, 0);
    const forced = await new ProjectAnalyzer(idx, router, cfg).run({ force: true, architectureDrafts: 1 });
    assert.ok(forced.filesSummarized >= 5);
  });
});

describe('UI', () => {
  it('dashboard serves the page, model stats and a live event stream', async () => {
    const bus = recordingBus();
    bus.info('test', 'before-connect');
    const router = routerFor(config({ endpoints: [{ name: 'e', baseUrl: 'http://127.0.0.1:1/v1' }] }), [caps('m', 'e')]);
    const { server, url } = await startDashboard(bus, router, 0);
    try {
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.doesNotMatch(url, /:0$/);
      const page = await (await fetch(url)).text();
      assert.match(page, /KURULTAY/);
      assert.doesNotMatch(page, /https?:\/\/(?!127\.0\.0\.1)/, 'no external resources');
      const stats = (await (await fetch(`${url}/stats`)).json()) as Array<{ key: string; limit: number }>;
      assert.equal(stats[0].key, 'm@e');
      const events = await new Promise<string>((resolve, reject) => {
        let buf = '';
        const req = request(`${url}/events`, (res) => {
          res.setEncoding('utf8');
          res.on('data', (d: string) => {
            buf += d;
            if (buf.includes('after-connect')) {
              req.destroy();
              resolve(buf);
            }
          });
        });
        req.on('error', (e) => (buf.includes('after-connect') ? resolve(buf) : reject(e)));
        req.end();
        setTimeout(() => bus.info('test', 'after-connect'), 50);
        bus.emitEvent('worker.token', { data: { t: 'x' } });
      });
      assert.match(events, /before-connect/, 'history replayed');
      assert.match(events, /after-connect/, 'live events streamed');
      assert.doesNotMatch(events, /worker\.token/, 'token events are not streamed');
    } finally {
      server.close();
    }
  });

  it('terminal renderer prints human-readable lines for key events', () => {
    const bus = recordingBus();
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      lines.push(String(s));
      return true;
    };
    try {
      const detach = attachTerminal(bus, { verbose: true });
      bus.emitEvent('run.start', { data: { models: 3, sessionId: 's1' } });
      bus.emitEvent('run.plan', { data: { mode: 'race', subtasks: ['one', 'two'] } });
      bus.emitEvent('subtask.start', { source: 'T1', data: { title: 'one', models: ['a@e'] } });
      bus.emitEvent('worker.tool', { source: 'T1-1', data: { tool: 'read_file', args: { path: 'x' } } });
      bus.emitEvent('worker.end', { source: 'T1-1', data: { status: 'done', steps: 3, files: 1, models: ['a@e'] } });
      bus.emitEvent('llm.request', { source: 'a@e', data: { purpose: 'p', attempt: 2 } });
      bus.emitEvent('llm.error', { source: 'a@e', message: 'boom', data: { kind: 'server' } });
      bus.emitEvent('run.verify', { data: { ok: false, skipped: false } });
      bus.emitEvent('run.requirements', { data: { complete: false, missing: ['m1'] } });
      bus.emitEvent('run.merge', { data: { written: ['a'], conflicts: [] } });
      bus.emitEvent('unknown.event', {});
      detach();
      bus.info('x', 'after-detach');
    } finally {
      (process.stderr as unknown as { write: typeof orig }).write = orig;
    }
    const out = lines.join('');
    for (const want of ['Kurultay – 3 models', '1. one', 'read_file', 'done', 'attempt 2', 'LLM error [server]', 'failed', 'missing:', '- m1', 'Applied to the project']) assert.ok(out.includes(want), want);
    assert.ok(!out.includes('after-detach'));
  });
});

describe('saved capability profile', () => {
  it('is measured once, reused, extended for new models and re-measured on request; per-model keys are sent', async () => {
    const s = await mock([
      { id: 'p1', quality: 'good', tools: true, ctx: 16_384 },
      { id: 'p2', quality: 'good', tools: true, ctx: 16_384 },
    ]);
    const home = tmpProject({});
    const prev = process.env.KURULTAY_HOME;
    process.env.KURULTAY_HOME = home;
    try {
      const { loadProfile, profilePath, runProbe } = await import('../../src/probe/profile.js');
      const steps: string[] = [];
      const cfg1 = config({ baseUrl: s.url, apiKey: 'main-key', models: ['p1'] });
      const first = await runProbe(cfg1, undefined, { quick: true, onStep: (key, step) => steps.push(`${key}:${step}`) });
      assert.deepEqual(first!.measured.models.map((m) => m.key), ['p1@main']);
      assert.ok(steps.some((x) => x.startsWith('p1@main:')), 'progress reported per step');
      assert.ok(existsSync(profilePath()));
      assert.equal(await runProbe(cfg1, undefined, { quick: true }), undefined, 'nothing new to measure');
      // a model added later (with its own key) is probed on its own
      const before = s.log.length;
      const cfg2 = config({ baseUrl: s.url, apiKey: 'main-key', models: ['p1', { id: 'p2', apiKey: 'own-key' }] });
      const second = await runProbe(cfg2, undefined, { quick: true });
      assert.deepEqual(second!.measured.models.map((m) => m.key), ['p2@main']);
      assert.deepEqual(second!.profile.models.map((m) => m.key).sort(), ['p1@main', 'p2@main']);
      const auth = new Set(s.log.slice(before).filter((l) => l.model === 'p2').map((l) => l.auth));
      assert.deepEqual([...auth], ['Bearer own-key'], 'the model-specific key overrides the main key');
      assert.ok(s.log.some((l) => l.model === 'p1' && l.auth === 'Bearer main-key'));
      // explicit re-measure of one model, by name
      const again = await runProbe(cfg2, undefined, { quick: true, models: ['p1'] });
      assert.deepEqual(again!.measured.models.map((m) => m.key), ['p1@main']);
      assert.equal(loadProfile()!.models.length, 2);
      const all = await runProbe(cfg2, undefined, { quick: true, scope: 'all' });
      assert.equal(all!.measured.models.length, 2);
    } finally {
      if (prev === undefined) delete process.env.KURULTAY_HOME;
      else process.env.KURULTAY_HOME = prev;
    }
  });
});
