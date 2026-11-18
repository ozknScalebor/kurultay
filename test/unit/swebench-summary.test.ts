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
    const cfg = (await import(pathToFileURL(join(process.cwd(), 'scripts', 'bench-config.mjs')).href)) as { pickGemini: (ids: string[]) => string | undefined };
    assert.deepEqual(bench.qwenStats('[{"type":"x"},{"stats":{"models":{"a":{"api":{"totalRequests":3},"tokens":{"total":10}},"b":{"api":{"totalRequests":2},"tokens":{"total":5}}},"tools":{"totalCalls":4}}}]'), { requests: 5, tokens: 15, toolCalls: 4 });
    assert.deepEqual(bench.qwenStats('not json'), { requests: 0, tokens: 0, toolCalls: 0 });
    const md = bench.renderBench({
      name: 'v1',
      models: 'm',
      tasks: [
        { suite: 'java', id: 'K1', kurultay: { passed: true, seconds: 120, requests: 20 }, qwen: { passed: false, seconds: 60, requests: 9 } },
        { suite: 'cpp', id: 'K2', kurultay: { passed: false, seconds: 60, requests: 10 } },
      ],
    });
    assert.match(md, /\| Kurultay \| 1 \/ 2 \| 50% \| 3\.0 min \| 30 \|/);
    assert.match(md, /\| Qwen Code \| 0 \/ 2 \| 0% \| 1\.0 min \| 9 \|/);
    assert.match(md, /\| java\/K1 \| ✅ \| ❌ \| 2\.0 min \| 1\.0 min \|/);
    assert.match(md, /\| cpp\/K2 \| ❌ \| - \| 1\.0 min \| - \|/);
    assert.equal(cfg.pickGemini(['models/gemini-2.5-flash', 'models/gemini-3.8-flash', 'gemini-3.8-pro']), 'gemini-3.8-flash');
    assert.equal(cfg.pickGemini(['gemini-2.5-flash']), 'gemini-2.5-flash');
    assert.equal(cfg.pickGemini(['x']), undefined);
  });
});
