import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Materializer } from '../../src/agent/workspace.js';
import { ProjectIndex } from '../../src/index/project-index.js';
import { PLAN_SCHEMA } from '../../src/llm/schemas.js';
import { ModelStats, PRIOR_WEIGHT } from '../../src/llm/stats.js';
import { startMockServer, type MockServerHandle } from '../../src/mock/server.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { CLAMP_PROJECT, caps, config, recordingBus, routerFor, tmpProject } from '../helpers.js';

const servers: MockServerHandle[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

describe('learned model quality', () => {
  it('blends the probe prior with observed outcomes and merges concurrent writers', () => {
    const file = join(tmpProject({}), 'stats.json');
    const a = new ModelStats(file);
    assert.equal(a.quality('m@e', 'coder', 0.8), 0.8, 'no data → prior');
    for (let i = 0; i < 6; i++) a.record('m@e', 'coder', false);
    a.record('m@e', 'coder', 0.5);
    assert.deepEqual(a.get('m@e', 'coder'), { n: 7, ok: 0.5 });
    assert.equal(a.quality('m@e', 'coder', 0.8), (0.8 * PRIOR_WEIGHT + 0.5) / (PRIOR_WEIGHT + 7));
    assert.equal(a.summary('m@e')!.n, 7);
    assert.equal(a.summary('nobody'), undefined);
    // another process saved meanwhile – both contributions survive
    const b = new ModelStats(file);
    b.record('m@e', 'coder', true);
    b.record('x@e', 'reviewer', true);
    b.save();
    a.save();
    const c = new ModelStats(file);
    assert.deepEqual(c.get('m@e', 'coder'), { n: 8, ok: 1.5 });
    assert.deepEqual(c.get('x@e', 'reviewer'), { n: 1, ok: 1 });
    a.save(); // nothing pending → no change
    assert.deepEqual(new ModelStats(file).get('m@e', 'coder'), { n: 8, ok: 1.5 });
    writeFileSync(file, 'broken');
    assert.deepEqual(new ModelStats(file).get('m@e', 'coder'), { n: 0, ok: 0 });
    new ModelStats().save();
    const clamp = new ModelStats();
    clamp.record('q', 'judge', 7);
    assert.deepEqual(clamp.get('q', 'judge'), { n: 1, ok: 1 });
  });

  it('the router ranks a model that keeps failing below an equal one', () => {
    const cfg = config({ endpoints: [{ name: 'e', baseUrl: 'http://127.0.0.1:1/v1' }, { name: 'f', baseUrl: 'http://127.0.0.1:2/v1' }] });
    const bus = recordingBus();
    const r = routerFor(cfg, [caps('a', 'e'), caps('b', 'f')], bus);
    r.learned = new ModelStats();
    const first = r.best('coder')!.caps.key;
    const other = first === 'a@e' ? 'b@f' : 'a@e';
    for (let i = 0; i < 5; i++) r.recordOutcome(first, 'coder', false);
    r.recordOutcome(other, 'coder', true);
    r.recordOutcome('ghost@x', 'coder', true);
    assert.equal(r.best('coder')!.caps.key, other);
    assert.equal(r.best('planner')!.caps.key, first === 'a@e' ? 'a@e' : 'b@f', 'other roles unaffected');
    assert.equal(bus.ofType('model.outcome').length, 6, 'unknown models are ignored');
  });

  it('records planner, coder, reviewer and judge outcomes during a run', async () => {
    const s = await startMockServer([
      { id: 'one', quality: 'good', tools: true, ctx: 65536 },
      { id: 'two', quality: 'good', tools: true, ctx: 65536 },
    ]);
    servers.push(s);
    const root = tmpProject({ ...CLAMP_PROJECT });
    const cfg = config({ endpoints: [{ name: 'e', baseUrl: s.url }], verify: { test: 'node test.js' } });
    const router = routerFor(cfg, [caps('one', 'e'), caps('two', 'e')]);
    const file = join(root, 'stats.json');
    router.learned = new ModelStats(file);
    const index = new ProjectIndex(root, join(root, '.kurultay'));
    index.build();
    await new Orchestrator(root, cfg, router, new Materializer(root, join(root, '.kurultay')), index, recordingBus()).run('Implement clamp in src/mathutil.js', { mode: 'race' });
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { models: Record<string, { roles: Record<string, { n: number; ok: number }> }> };
    const roles = new Set(Object.values(saved.models).flatMap((m) => Object.keys(m.roles)));
    for (const role of ['planner', 'coder', 'reviewer', 'judge']) assert.ok(roles.has(role), `${role} outcome recorded: ${JSON.stringify(saved)}`);
    const coder = Object.values(saved.models).map((m) => m.roles.coder).filter(Boolean);
    assert.ok(coder.some((c) => c.ok > 0), 'the verified winner counts as a success');
    const prompts = s.log.map((l) => JSON.stringify(l.body));
    assert.ok(prompts.some((p) => p.includes('TESTING (required)') && p.includes('node test.js')), 'workers get test-first guidance with the test command');
    const quiet = { ...cfg, orchestrator: { ...cfg.orchestrator, testFirst: false } };
    const before = s.log.length;
    await new Orchestrator(root, quiet, router, new Materializer(root, join(root, '.kurultay')), index, recordingBus()).run('Implement clamp in src/mathutil.js', { mode: 'single' });
    assert.ok(!s.log.slice(before).some((l) => JSON.stringify(l.body).includes('TESTING (required)')), 'testFirst=false turns it off');
  });
});

describe('constrained JSON output', () => {
  it('sends response_format json_schema and falls back once the server rejects it', async () => {
    const s = await startMockServer([
      { id: 'guided', quality: 'good', tools: true, ctx: 65536 },
      { id: 'old', quality: 'good', tools: true, ctx: 65536, rejectSchema: true },
    ]);
    servers.push(s);
    const bus = recordingBus();
    const r = routerFor(config({ endpoints: [{ name: 'e', baseUrl: s.url }] }), [caps('guided', 'e', { jsonMode: true }), caps('old', 'e', { jsonMode: true })], bus);
    const req = { messages: [{ role: 'user' as const, content: 'Return a JSON object with keys "lang" (value "c++") and "year" (value 2011). JSON only.' }], jsonMode: true, jsonSchema: PLAN_SCHEMA };
    await r.chat(req, { only: ['guided@e'] });
    const rf = (i: number) => (s.log[i].body as { response_format?: { type: string; json_schema?: { name: string } } }).response_format;
    assert.equal(rf(0)?.type, 'json_schema');
    assert.equal(rf(0)?.json_schema?.name, 'kurultay_plan');
    const res = await r.chat(req, { only: ['old@e'] });
    assert.ok(res.content);
    assert.deepEqual([rf(1)?.type, rf(2)?.type], ['json_schema', 'json_object'], 'rejected → retried with json_object');
    assert.equal(r.get('old@e')!.caps.jsonSchema, false);
    await r.chat(req, { only: ['old@e'] });
    assert.equal(rf(3)?.type, 'json_object', 'not tried again');
    assert.equal(r.get('old@e')!.health.failures, 0, 'not counted as a model failure');
    assert.ok(bus.ofType('log.info').some((e) => /does not support json_schema/.test(e.message ?? '')));
  });
});
