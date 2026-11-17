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
