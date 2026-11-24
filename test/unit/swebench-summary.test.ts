import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { tmpProject } from '../helpers.js';

// the script lives outside src/ (CI uses it); load it from the repository root
const script = pathToFileURL(join(process.cwd(), 'scripts', 'swebench-summary.mjs')).href;

describe('SWE-bench summary for CI and release notes', () => {
  it('tables two agents, names the instances only one solved and merges into release notes', async () => {
    const { summarise, mergeNotes } = (await import(script)) as { summarise: (d: string) => string; mergeNotes: (b: string, r: string, s: string) => string };
    const res = (resolved: string[]) => JSON.stringify({ submitted_instances: 3, resolved_instances: resolved.length, empty_patch_instances: 1, error_instances: 0, submitted_ids: ['a__x-1', 'a__x-2', 'b__y-3'], resolved_ids: resolved });
    const dir = join(tmpProject({
      'run1/results-kurultay.json': res(['a__x-1', 'b__y-3']),
      'run1/results-qwen-code.json': res(['a__x-1']),
      'run1/runs-kurultay.jsonl': '{"seconds":600,"requests":30}\n{"seconds":1200,"requests":50}\n',
      'run1/meta.json': '{"dataset":"princeton-nlp/SWE-bench_Verified","note":"seed 42"}',
      'empty/x.txt': '',
    }), 'run1');
    const md = summarise(dir);
    assert.match(md, /\| kurultay \| 2 \/ 3 \| 66\.7% \| 1 \| 0 \| 15 min \| 40\.0 \|/);
    assert.match(md, /\| qwen-code \| 1 \/ 3 \| 33\.3% \| 1 \| 0 \| - \| - \|/);
    assert.match(md, /only \*\*kurultay\*\*: b__y-3/);
    assert.match(md, /\| b__y-3 \| ✅ \| ❌ \|/);
    assert.match(md, /SWE-bench_Verified · 3 instances · seed 42/);
    assert.match(summarise(join(dir, '..', 'empty')), /No results yet/);
    const once = mergeNotes('## Changes\n- x', 'run1', 'TABLE 1');
    assert.match(once, /- x\n\n<!-- swebench:run1 -->\nTABLE 1\n<!-- \/swebench:run1 -->/);
    const twice = mergeNotes(once, 'run1', 'TABLE 2');
    assert.ok(twice.includes('TABLE 2') && !twice.includes('TABLE 1'), 'a rerun replaces its section');
    assert.match(mergeNotes(twice, 'run2', 'OTHER'), /TABLE 2[\s\S]*OTHER/);
  });
});

describe('bench scripts', () => {
  it('reads Qwen Code stats, renders the head-to-head table and picks a Gemini model', async () => {
    const bench = (await import(pathToFileURL(join(process.cwd(), 'scripts', 'bench.mjs')).href)) as { qwenStats: (s: string) => { requests: number; tokens: number; toolCalls: number }; renderBench: (b: unknown) => string };
    const cfg = (await import(pathToFileURL(join(process.cwd(), 'scripts', 'bench-config.mjs')).href)) as { pick: (ids: string[], prefer: RegExp[]) => string | undefined; family: (id: string) => string; PROVIDERS: Record<string, { prefer: RegExp[] }> };
    assert.deepEqual(bench.qwenStats('[{"type":"x"},{"stats":{"models":{"a":{"api":{"totalRequests":3},"tokens":{"total":10}},"b":{"api":{"totalRequests":2},"tokens":{"total":5}}},"tools":{"totalCalls":4}}}]'), { requests: 5, tokens: 15, toolCalls: 4 });
    assert.deepEqual(bench.qwenStats('not json'), { requests: 0, tokens: 0, toolCalls: 0 });
    const b2 = bench as unknown as { renderBench: (b: unknown) => string; orderFor: (i: number, k: string[]) => string[] };
    const md = b2.renderBench({
      name: 'v1',
      models: 'm',
      tasks: [
        { suite: 'java', id: 'K1', kurultay: { passed: true, seconds: 150, requests: 20, tokens: 5000, rateLimitWait: 6, multiModelSeconds: 30 }, solo: { passed: true, seconds: 90, requests: 12, tokens: 3000, rateLimitWait: 0 }, qwen: { passed: false, seconds: 60, requests: 9, tokens: 2000 } },
        { suite: 'cpp', id: 'K2', kurultay: { passed: false, seconds: 60, requests: 10, tokens: 1000 } },
      ],
    });
    assert.match(md, /\| Kurultay \(all models\) \| 1 \/ 2 \| 50% \| 3\.5 min \| 30 \| 6 K \| 0\.1 min \| 0\.5 min \|/);
    assert.match(md, /\| Kurultay \(main model only\) \| 1 \/ 1 \| 100% \| 1\.5 min \| 12 \| 3 K \| 0\.0 min \| - \|/);
    assert.match(md, /\| Qwen Code \| 0 \/ 1 \| 0% \| 1\.0 min \| 9 \| 2 K \| - \| - \|/);
    assert.match(md, /Multi-model slowdown:\*\* with all models Kurultay took 1\.0 min \(67%\) longer/);
    assert.match(md, /\| java\/K1 \| ✅ 2\.5 min \| ✅ 1\.5 min \| ❌ 1\.0 min \|/);
    assert.match(md, /\| cpp\/K2 \| ❌ 1\.0 min \| - \| - \|/);
    const both = b2.renderBench({ name: 'v', models: 'm', tasks: [{ suite: 's', id: 'K1', kurultay: { passed: false, seconds: 1200.1, status: 'timeout' }, solo: { passed: false, seconds: 1200, status: 'timeout' } }] });
    assert.doesNotMatch(both, /slowdown|faster|as fast/, 'two runs stopped by the budget say nothing about speed');
    const same = b2.renderBench({ name: 'v', models: 'm', tasks: [{ suite: 's', id: 'K1', kurultay: { passed: true, seconds: 610 }, solo: { passed: true, seconds: 600 } }] });
    assert.match(same, /about as fast/);
    assert.deepEqual(b2.orderFor(0, ['k', 's', 'q']), ['k', 's', 'q']);
    assert.deepEqual(b2.orderFor(1, ['k', 's', 'q']), ['s', 'q', 'k']);
    assert.deepEqual(b2.orderFor(5, ['k', 'q']), ['q', 'k']);
    const nv = cfg.PROVIDERS.nvidia.prefer;
    assert.equal(cfg.pick(['meta/llama-3.1-8b', 'moonshotai/kimi-k2-thinking', 'moonshotai/kimi-k2.6', 'moonshotai/kimi-k2.5', 'deepseek-ai/deepseek-v4.1-flash'], nv), 'moonshotai/kimi-k2.6', 'newest non-thinking Kimi');
    assert.equal(cfg.pick(['deepseek-ai/deepseek-v4.1-flash', 'nvidia/nv-embed-v2'], nv), 'deepseek-ai/deepseek-v4.1-flash');
    assert.equal(cfg.pick(['mistral-small-latest', 'codestral-latest', 'devstral-medium-2507', 'devstral-small-2507'], cfg.PROVIDERS.mistral.prefer), 'devstral-medium-2507');
    assert.equal(cfg.pick(['x'], nv), undefined);
    assert.equal(cfg.family('moonshotai/kimi-k2.6'), 'kimi');
    assert.equal(cfg.family('deepseek-ai/deepseek-v4.1-flash'), 'deepseek');
    const c2 = cfg as unknown as { candidates: (ids: string[], p: RegExp[]) => string[]; ping: (b: string, k: string, id: string, t: number, f: unknown) => Promise<{ ok: boolean; error?: string }> };
    assert.deepEqual(c2.candidates(['z-ai/glm-5.3-flash', 'moonshotai/kimi-k2.6', 'deepseek-ai/deepseek-v4.1-flash', 'meta/llama-3.1-8b'], nv), ['moonshotai/kimi-k2.6', 'deepseek-ai/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash']);
    assert.equal((await c2.ping('b', 'k', 'm', 1000, async () => ({ ok: true, json: async () => ({}) }))).ok, true);
    assert.equal((await c2.ping('b', 'k', 'm', 1000, async () => ({ ok: false, status: 429 }))).error, 'HTTP 429');
    assert.equal((await c2.ping('b', 'k', 'm', 1000, async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); })).error, 'no answer in time');
    // Z.AI: the known ids when /models is not available, a fast variant first
    const z = (cfg as unknown as { PROVIDERS: Record<string, { prefer: RegExp[]; fallbackIds: string[] }> }).PROVIDERS.zai;
    assert.equal(cfg.pick(z.fallbackIds, z.prefer), 'glm-5.2-fast');
    assert.equal(cfg.pick(['glm-5.4', 'glm-5.3-turbo'], z.prefer), 'glm-5.3-turbo');
    assert.equal(cfg.family('glm-5.4'), 'glm');
    // the second NIM slot prefers another family
    assert.equal(cfg.pick(['deepseek-ai/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash'], cfg.PROVIDERS.nvidia2.prefer), 'deepseek-ai/deepseek-v4.1-flash');
  });
});
