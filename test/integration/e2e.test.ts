import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import { ProjectAnalyzer } from '../../src/analyze/summarizer.js';
import { createApp, loadOrBuildIndex } from '../../src/app.js';
import { Router } from '../../src/llm/router.js';
import { parseConfig } from '../../src/config.js';
import { startMockServer } from '../../src/mock/server.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { probeAll, writeCapabilities } from '../../src/probe/probe.js';
import { EventBus } from '../../src/util/events.js';

// learned model statistics and caches go to a throwaway home, not the developer's
const prevHome = process.env.KURULTAY_HOME;
process.env.KURULTAY_HOME = mkdtempSync(join(tmpdir(), 'k-home-'));
after(() => {
  if (prevHome === undefined) delete process.env.KURULTAY_HOME;
  else process.env.KURULTAY_HOME = prevHome;
});

/**
 * End-to-end: two mock "GPU servers" with different models (a strong coder with
 * native tools, a weak coder without tools, a flaky one that returns 503 first)
 * run the full pipeline: probe → index → analyze → run (race + council + verify).
 */
describe('end-to-end with mock LLM servers', () => {
  let s1: { server: Server; url: string; requests: () => number };
  let s2: { server: Server; url: string; requests: () => number };
  let root: string;

  before(async () => {
    s1 = await startMockServer([
      { id: 'strong', quality: 'good', tools: true, ctx: 65_536, thinks: true },
      { id: 'weak', quality: 'bad', tools: false, ctx: 16_384 },
    ]);
    s2 = await startMockServer([{ id: 'flaky', quality: 'good', tools: true, ctx: 32_768, failFirst: 2 }]);
    root = mkdtempSync(join(tmpdir(), 'k-e2e-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'mathutil.js'), '// math utilities\nexport function clamp(value, min, max) {\n  throw new Error("TODO");\n}\n');
    writeFileSync(join(root, 'test.js'), "import { clamp } from './src/mathutil.js';\nimport assert from 'node:assert';\nassert.strictEqual(clamp(5,0,10),5);\nassert.strictEqual(clamp(-3,0,10),0);\nassert.strictEqual(clamp(42,0,10),10);\n");
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'review_rules.md'), '- clamp must handle both bounds');
    writeFileSync(
      join(root, 'kurultay.config.json'),
      JSON.stringify({
        endpoints: [
          { name: 'gpu1', baseUrl: s1.url, apiKey: 'k1' },
          { name: 'gpu2', baseUrl: s2.url },
        ],
        verify: { test: 'node test.js' },
      }),
    );
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
    } catch {
      /* git optional */
    }
  });

  after(() => {
    s1.server.close();
    s2.server.close();
  });

  it('probes all endpoints in parallel and scores roles', async () => {
    const cfg = parseConfig(JSON.parse(readFileSync(join(root, 'kurultay.config.json'), 'utf8')));
    const file = await probeAll(cfg, new EventBus(), { quick: false });
    const by = Object.fromEntries(file.models.map((m) => [m.model, m]));
    assert.equal(file.models.length, 3);
    assert.equal(by.flaky.reachable, true, 'flaky model recovers after 503s');
    assert.equal(by.strong.nativeTools, true);
    assert.equal(by.weak.nativeTools, false);
    assert.equal(by.strong.thinking, true);
    assert.equal(by.weak.contextWindow, 16_384);
    assert.ok(by.strong.codingScore > by.weak.codingScore);
    assert.ok(by.strong.roleScores.coder > by.weak.roleScores.coder);
    writeCapabilities(join(root, '.kurultay'), file);
    assert.ok(existsSync(join(root, '.kurultay', 'CAPABILITIES.md')));
  });

  it('analyzes the project using every model and writes ARCHITECTURE.md', async () => {
    const app = await createApp({ root });
    assert.equal(app.router.size, 3);
    const { index } = loadOrBuildIndex(app);
    const r = await new ProjectAnalyzer(index, app.router, app.config, app.bus).run({ architectureDrafts: 3 });
    assert.ok(r.filesSummarized >= 2);
    assert.equal(r.failures, 0);
    const arch = readFileSync(r.architecturePath, 'utf8');
    assert.match(arch, /# Architecture Summary/);
    assert.match(arch, /```mermaid/);
    assert.ok(Object.keys(r.modelsUsed).length >= 2, 'architecture drafts come from several models');
    assert.ok(index.files.find((f) => f.path === 'src/mathutil.js')?.summary);
  });

  it('runs a task: race on all models, council picks the verified winner, merges', async () => {
    const app = await createApp({ root });
    const { index } = loadOrBuildIndex(app);
    const orch = new Orchestrator(app.root, app.config, app.router, app.materializer, index, app.bus);
    const report = await orch.run('Implement clamp in src/mathutil.js correctly');
    assert.equal(report.status, 'completed', JSON.stringify(report.requirementCheck));
    assert.equal(report.mode, 'race');
    const st = report.subtasks[0];
    assert.equal(st.candidates.length, 3, 'all three models raced');
    assert.ok(!st.winner!.models.includes('weak@gpu1'), 'weak wrong answer did not win');
    assert.ok(report.modelsUsed.length >= 3);
    const code = readFileSync(join(root, 'src', 'mathutil.js'), 'utf8');
    assert.match(code, /Math\.min\(Math\.max\(value, min\), max\)/);
    execFileSync('node', ['test.js'], { cwd: root });
    assert.ok(existsSync(report.reportPath));
    assert.match(readFileSync(report.diffPath, 'utf8'), /Math\.min/);
    assert.ok(!existsSync(join(root, '.kurultay', 'journal.json')), 'journal cleaned up');
  });

  it('falls back to another model when one endpoint dies', async () => {
    const cfg = parseConfig({ endpoints: [{ name: 'dead', baseUrl: 'http://127.0.0.1:9/v1', models: ['ghost'] }, { name: 'gpu1', baseUrl: s1.url }] });
    const router = new Router(cfg);
    router.register(await router.discover());
    const r = await router.chat({ messages: [{ role: 'user', content: 'Reply with exactly the word PONG and nothing else.' }] }, { prefer: ['ghost@dead'], attemptsPerModel: 1, recoveryWaitMs: 0 });
    assert.equal(r.content, 'PONG');
    assert.notEqual(r.model, 'ghost@dead');
  });

  it('dry-run keeps the project untouched', async () => {
    writeFileSync(join(root, 'src', 'mathutil.js'), '// math utilities\nexport function clamp(value, min, max) {\n  throw new Error("TODO");\n}\n');
    const app = await createApp({ root });
    const { index } = loadOrBuildIndex(app);
    const report = await new Orchestrator(app.root, app.config, app.router, app.materializer, index, app.bus).run('Implement clamp in src/mathutil.js', { dryRun: true, mode: 'single' });
    assert.equal(report.status, 'dry-run');
    assert.match(readFileSync(join(root, 'src', 'mathutil.js'), 'utf8'), /TODO/);
    assert.match(readFileSync(report.diffPath, 'utf8'), /Math\.min/);
  });
});
