import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { AgentWorker } from '../../src/agent/worker.js';
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
            return n < 8 ? call('read_file', { path: 'big.c' }) : call('finish', { summary: 'no condense' });
          },
          handler: undefined,
        },
        { id: 'fast', handler: (q) => (/Condense this agent work log/.test(lastUser(q.messages)) ? (condensed++, text('notes: read big.c several times')) : undefined) },
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
