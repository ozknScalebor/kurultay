import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { AgentWorker } from '../../src/agent/worker.js';
import { SkillRegistry, selectSkillsFor } from '../../src/skills/skills.js';
import { Materializer, Overlay } from '../../src/agent/workspace.js';
import { ProjectIndex } from '../../src/index/project-index.js';
import { startMockServer, type MockModel, type MockReply, type MockRequest, type MockServerHandle } from '../../src/mock/server.js';
import { caps, config, isAgent, lastUser, recordingBus, routerFor, tmpProject, toolResults } from '../helpers.js';

const servers: MockServerHandle[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

type Script = (step: number, q: MockRequest) => MockReply | undefined;

/** Build a worker against a mock model whose agent turns follow `script`. */
async function setup(models: Array<Partial<MockModel> & { id: string; script?: Script }>, files: Record<string, string> = { 'src/a.c': 'int a = 1;\n' }, capsOver: Record<string, Partial<ReturnType<typeof caps>>> = {}) {
  const mocks: MockModel[] = models.map((m) => ({
    quality: 'good',
    tools: true,
    ctx: 65536,
    ...m,
    handler: (q) => (m.script && isAgent(q.messages) ? m.script(toolResults(q.messages), q) : m.handler?.(q)),
  }));
  const s = await startMockServer(mocks);
  servers.push(s);
  const root = tmpProject(files);
  const cfg = config({ endpoints: [{ name: 'e', baseUrl: s.url }], orchestrator: { maxStepsPerWorker: 12 } });
  const bus = recordingBus();
  const router = routerFor(cfg, mocks.map((m) => caps(m.id, 'e', { nativeTools: m.tools, ...(capsOver[m.id] ?? {}) })), bus);
  const index = new ProjectIndex(root, join(root, '.kurultay'));
  index.build();
  const materializer = new Materializer(root, join(root, '.kurultay'));
  const make = (model: string, over: Partial<ConstructorParameters<typeof AgentWorker>[0]> = {}) => {
    const overlay = new Overlay('w1', root);
    const w = new AgentWorker({ id: 'w1', task: 'change a to 2', context: 'ctx', model: `${model}@e`, overlay, ...over }, router, cfg, { index, materializer, root, bus });
    return { w, overlay: over.overlay ?? overlay };
  };
  return { s, root, bus, router, make };
}

const call = (name: string, args: Record<string, unknown>): MockReply => ({ toolCall: { name, args } });
const text = (content: string): MockReply => ({ content });

describe('AgentWorker', () => {
  it('runs a native tool-calling loop: read → edit → finish', async () => {
    const { make, s } = await setup([{ id: 'nat', script: (n) => [call('read_file', { path: 'src/a.c' }), call('edit_file', { path: 'src/a.c', old_text: 'int a = 1;', new_text: 'int a = 2;' }), call('finish', { summary: 'a is 2' })][n] }]);
    const { w, overlay } = make('nat');
    const r = await w.run();
    assert.equal(r.status, 'done');
    assert.equal(r.summary, 'a is 2');
    assert.deepEqual(r.changedFiles, ['src/a.c']);
    assert.equal(overlay.read('src/a.c'), 'int a = 2;\n');
    assert.deepEqual(r.models, ['nat@e']);
    assert.equal(r.steps, 3);
    assert.ok(r.tokens.in > 0 && r.tokens.out > 0);
    // native protocol: tool results are sent back as role=tool messages with matching ids
    const last = s.log[s.log.length - 1].body.messages as Array<{ role: string; tool_call_id?: string }>;
    assert.ok(last.some((m) => m.role === 'tool' && m.tool_call_id));
    assert.ok(Array.isArray(s.log[0].body.tools));
  });

  it('drives models without native tools through <tool_call> text and Qwen3-Coder XML', async () => {
    const { make, s } = await setup([
      {
        id: 'txt', tools: false,
        script: (n) => [
          text('Let me look.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "src/a.c"}}\n</tool_call>'),
          text('<tool_call>\n<function=edit_file>\n<parameter=path>\nsrc/a.c\n</parameter>\n<parameter=old_text>\nint a = 1;\n</parameter>\n<parameter=new_text>\nint a = 3;\n</parameter>\n</function>\n</tool_call>'),
          text('<tool_call>{"name":"finish","arguments":{"summary":"done via text"}}</tool_call>'),
        ][n],
      },
    ]);
    const { w, overlay } = make('txt');
    const r = await w.run();
    assert.equal(r.status, 'done');
    assert.equal(overlay.read('src/a.c'), 'int a = 3;\n');
    assert.equal(s.log[0].body.tools, undefined, 'no tools field for prompt-tool models');
    const sys = (s.log[0].body.messages as Array<{ content: string }>)[0].content;
    assert.match(sys, /<tool_call>/);
    const second = s.log[1].body.messages as Array<{ role: string; content: string }>;
    assert.match(second[second.length - 1].content, /^<tool_result name="read_file">/);
  });

  it('accepts SEARCH/REPLACE edits from text models', async () => {
    const { make } = await setup([{ id: 'sr', tools: false, script: (n) => [text('src/a.c\n<<<<<<< SEARCH\nint a = 1;\n=======\nint a = 4;\n>>>>>>> REPLACE'), text('<tool_call>{"name":"finish","arguments":{"summary":"ok"}}</tool_call>')][n] }]);
    const { w, overlay } = make('sr');
    assert.equal((await w.run()).status, 'done');
    assert.equal(overlay.read('src/a.c'), 'int a = 4;\n');
  });

  it('switches to prompt-based tools when the server rejects the tools field', async () => {
    const { make, bus } = await setup([{ id: 'strict', tools: false, rejectTools: true, script: (n) => [text('<tool_call>{"name":"finish","arguments":{"summary":"fallback worked"}}</tool_call>')][n] }], undefined, { strict: { nativeTools: true } });
    const { w } = make('strict');
    const r = await w.run();
    assert.equal(r.status, 'done');
    assert.equal(r.summary, 'fallback worked');
    assert.ok(bus.ofType('log.warn').some((e) => /prompt tabanlı/.test(e.message ?? '')));
  });

  it('nudges idle models and gives up after three turns without tool calls', async () => {
    const { make, s } = await setup([{ id: 'chatty', script: () => text('I think the code looks fine.') }]);
    const { w } = make('chatty');
    const r = await w.run();
    assert.equal(r.status, 'failed');
    assert.match(r.summary, /araç çağrısı yapmadan/);
    assert.equal(s.log.length, 3);
    const msgs = s.log[1].body.messages as Array<{ role: string; content: string }>;
    assert.match(msgs[msgs.length - 1].content, /did not call any tool/);
  });

  it('stops at the step limit', async () => {
    const { make } = await setup([{ id: 'loop', script: () => call('list_dir', { path: '.' }) }]);
    const { w } = make('loop', { maxSteps: 4 });
    const r = await w.run();
    assert.equal(r.status, 'max_steps');
    assert.equal(r.steps, 4);
  });

  it('read-only workers cannot modify files', async () => {
    const { make, s } = await setup([{ id: 'ro', script: (n) => [call('write_file', { path: 'src/a.c', content: 'hacked' }), call('finish', { summary: 'reviewed' })][n] }]);
    const { w, overlay } = make('ro', { readOnly: true });
    const r = await w.run();
    assert.equal(r.status, 'done');
    assert.equal(overlay.read('src/a.c'), 'int a = 1;\n');
    const toolNames = (s.log[0].body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    assert.ok(!toolNames.includes('write_file') && !toolNames.includes('run_command'));
    const second = s.log[1].body.messages as Array<{ role: string; content: string }>;
    assert.match(second[second.length - 1].content, /izin verilmeyen/);
  });

  it('condenses history when the context window fills up', async () => {
    const big = Array.from({ length: 300 }, (_, i) => `int value_${i} = ${i}; // padding padding padding`).join('\n');
    let condensed = 0;
    const { make, bus } = await setup(
      [
        {
          id: 'small',
          script: (n, q) => {
            if (q.messages.some((m) => (m.content ?? '').includes('<progress_notes>'))) return call('finish', { summary: 'after condense' });
            return n < 8 ? call('read_file', { path: 'big.c', start_line: n + 1 }) : call('finish', { summary: 'no condense' });
          },
          handler: undefined,
        },
        {
          id: 'fast',
          handler: (q) => {
            if (!/compacting the work log/.test(q.messages[0]?.content ?? '')) return undefined;
            condensed++;
            // the condenser lists the files the worker touched and asks for the structured sections
            assert.match(lastUser(q.messages), /big\.c/);
            return text('## Goal\nread big.c\n## Progress\n### Done\n- read big.c several times');
          },
        },
      ],
      { 'big.c': big },
      { small: { contextWindow: 6000 }, fast: { roleScores: { planner: 0, coder: 0, summarizer: 0, reviewer: 0, judge: 0, fast: 1 } } },
    );
    const { w } = make('small');
    const r = await w.run();
    assert.equal(r.summary, 'after condense');
    assert.ok(condensed >= 1, 'a condense request was made');
    assert.ok(bus.ofType('log.info').some((e) => /yoğunlaştırıldı/.test(e.message ?? '')));
  });

  it('toolshim turns prose that names a tool into a real call', async () => {
    let shimAsked = 0;
    const { make, bus } = await setup(
      [
        { id: 'prose', tools: false, script: (n) => [text('I will now use read_file to open {src/a.c}.'), text('<tool_call>{"name":"finish","arguments":{"summary":"read it"}}</tool_call>')][n] },
        {
          id: 'fast',
          handler: (q) => {
            if (!/replied with plain text instead of a tool call/.test(lastUser(q.messages))) return undefined;
            shimAsked++;
            return text('{"calls":[{"name":"read_file","arguments":{"path":"src/a.c"}},{"name":"rm_rf","arguments":{}}]}');
          },
        },
      ],
      undefined,
      { prose: { nativeTools: false }, fast: { roleScores: { planner: 0, coder: 0, summarizer: 0, reviewer: 0, judge: 0, fast: 1 } } },
    );
    const { w } = make('prose');
    const r = await w.run();
    assert.equal(r.status, 'done');
    assert.equal(shimAsked, 1);
    assert.ok(r.interventions.includes('toolshim'));
    assert.ok(bus.types().includes('worker.toolshim'));
  });

  it('stops a worker stuck repeating the same call with the same result', async () => {
    const { make } = await setup([{ id: 'stuck', script: () => call('list_dir', { path: 'src' }) }]);
    const { w } = make('stuck');
    const r = await w.run();
    assert.equal(r.status, 'failed');
    assert.match(r.summary, /döngü/);
    assert.equal(r.steps, 5);
    assert.ok(r.interventions.some((i) => /repeat/.test(i)));
  });

  it('stops after too many consecutive failing tool calls', async () => {
    const { make } = await setup([{ id: 'clumsy', script: (n) => call('read_file', { path: `missing-${n}.c` }) }]);
    const { w } = make('clumsy');
    const r = await w.run();
    assert.equal(r.status, 'failed');
    assert.match(r.summary, /üst üste başarısız/);
  });

  it('preloads selected skills, advertises the rest and loads on demand', async () => {
    const files = {
      'src/a.c': 'int a = 1;\n',
      'src/drivers/uart.c': 'int u;\n',
      '.kurultay/skills/c-style/SKILL.md': '---\nname: c-style\ndescription: C kod stili\nalways: true\n---\nPRELOADED-STYLE-1',
      '.kurultay/skills/driver/SKILL.md': '---\nname: driver\ndescription: Sürücü ekleme adımları\npaths: ["src/drivers/**"]\n---\nDRIVER-BODY-2',
      '.kurultay/skills/review/SKILL.md': '---\nname: review\ndescription: İnceleme listesi\n---\nREVIEW-BODY-3',
    };
    let seen: MockRequest | undefined;
    const { make, root } = await setup(
      [
        {
          id: 'sk',
          script: (n, q) => {
            seen ??= q;
            return [call('read_file', { path: 'src/drivers/uart.c' }), call('skill', { name: 'driver' }), call('finish', { summary: 'ok' })][n];
          },
        },
      ],
      files,
    );
    const registry = SkillRegistry.discover(root, { includeUser: false });
    const sel = selectSkillsFor(registry, { text: 'change a', files: ['src/a.c'] });
    const { w } = make('sk', { skills: { registry, preload: sel.preload, recommended: ['review'], files: ['src/a.c'] } });
    const r = await w.run();
    assert.equal(r.status, 'done');
    const sys = (seen!.messages[0].content ?? '') as string;
    const first = (seen!.messages[1].content ?? '') as string;
    assert.match(first, /# ACTIVE SKILLS[\s\S]*PRELOADED-STYLE-1/);
    assert.match(sys, /<name>review<\/name>/);
    assert.ok(!sys.includes('<name>driver</name>'), 'path-scoped skill not advertised up front');
    assert.ok(!sys.includes('<name>c-style</name>'), 'preloaded skill not listed twice');
    assert.deepEqual(r.skills, [
      { name: 'c-style', how: 'preload' },
      { name: 'driver', how: 'tool' },
    ]);
  });

  it('keeps going with a raw log when the condenser model fails', async () => {
    const big = Array.from({ length: 300 }, (_, i) => `int value_${i} = ${i}; // padding padding padding`).join('\n');
    const { make } = await setup(
      [
        {
          id: 'small2',
          script: (n, q) => {
            if (q.messages.some((m) => (m.content ?? '').includes('<progress_notes>'))) return call('finish', { summary: 'after fallback' });
            return n < 8 ? call('read_file', { path: 'big.c', start_line: n + 1 }) : call('finish', { summary: 'no condense' });
          },
          handler: (q) => (/compacting the work log/.test(q.messages[0]?.content ?? '') ? { status: 400, error: 'nope' } : undefined),
        },
        { id: 'fast', handler: (q) => (/compacting the work log/.test(q.messages[0]?.content ?? '') ? { status: 400, error: 'nope' } : undefined) },
      ],
      { 'big.c': big },
      { small2: { contextWindow: 6000 }, fast: { roleScores: { planner: 0, coder: 0, summarizer: 0, reviewer: 0, judge: 0, fast: 1 } } },
    );
    const { w } = make('small2');
    const r = await w.run();
    assert.equal(r.summary, 'after fallback');
  });

  it('falls back to another model when its model dies mid-task and reports both', async () => {
    const { make } = await setup([
      { id: 'dies', script: (n) => (n === 0 ? call('read_file', { path: 'src/a.c' }) : { status: 400, error: 'model crashed' }) },
      { id: 'backup', script: () => call('finish', { summary: 'backup finished' }) },
    ]);
    const { w } = make('dies');
    const r = await w.run();
    assert.equal(r.status, 'done');
    assert.deepEqual(r.models.sort(), ['backup@e', 'dies@e']);
  });

  it('fails cleanly when no model can answer', async () => {
    const { make } = await setup([{ id: 'dead', script: () => ({ status: 400, error: 'always broken' }) }]);
    const { w } = make('dead');
    const r = await w.run();
    assert.equal(r.status, 'failed');
    assert.match(r.error ?? '', /always broken/);
  });
});
