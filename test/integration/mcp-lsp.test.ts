import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { syntaxCheck } from '../../src/agent/compile-check.js';
import { executeTool, toolSpecs, type ToolContext } from '../../src/agent/tools.js';
import { Materializer, Overlay } from '../../src/agent/workspace.js';
import { ProjectIndex } from '../../src/index/project-index.js';
import { LspClient, closeLspServers, lspDiagnostics } from '../../src/lsp/client.js';
import { McpManager, mcpToolName } from '../../src/mcp/manager.js';
import { startMockServer, type MockReply, type MockServerHandle } from '../../src/mock/server.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { caps, config, isAgent, lastUser, recordingBus, routerFor, tmpProject, toolResults } from '../helpers.js';
import { FAKE_LSP, FAKE_MCP, script } from '../fixtures.js';

const servers: MockServerHandle[] = [];
const managers: McpManager[] = [];
after(async () => {
  managers.forEach((m) => m.close());
  await closeLspServers();
  await Promise.all(servers.map((s) => s.close()));
});

const MCP_JS = script(FAKE_MCP);
const LSP_JS = script(FAKE_LSP);

async function tracker(extra: Record<string, unknown> = {}) {
  const m = new McpManager({ servers: { tracker: { command: process.execPath, args: [MCP_JS], ...extra } } }, recordingBus());
  managers.push(m);
  return { m, started: await m.start(10_000) };
}

function ctxFor(root: string, extra: Partial<ToolContext> = {}): ToolContext {
  const cfg = config({ endpoints: [{ name: 'e', baseUrl: 'http://127.0.0.1:1/v1' }] });
  return { workerId: 'w', root, overlay: new Overlay('w', root), materializer: new Materializer(root, join(root, '.kurultay')), config: cfg, readFiles: new Set(), writtenFiles: new Set(), staleFiles: new Set(), ...extra };
}

describe('MCP client', () => {
  it('starts stdio servers, pages tools/list and calls tools', async () => {
    const { m, started } = await tracker();
    assert.deepEqual(started, { servers: ['tracker'], failed: [] });
    assert.deepEqual(m.specs().map((s) => s.function.name), ['mcp__tracker__lookup_ticket', 'mcp__tracker__create_ticket', 'mcp__tracker__slow']);
    assert.deepEqual(m.specs(true).map((s) => s.function.name), ['mcp__tracker__lookup_ticket'], 'only read-only tools for reviewers');
    assert.match(m.specs()[0].function.description, /^\[MCP tracker\] Read a ticket/);
    assert.deepEqual(await m.call('mcp__tracker__lookup_ticket', { id: 'KUR-7' }), { output: 'KUR-7: Login fails when the password is empty', isError: false });
    assert.deepEqual(await m.call('mcp__tracker__create_ticket', { title: 'x' }), { output: 'created KUR-8\n[image image/png]', isError: false });
    assert.deepEqual(await m.call('mcp__tracker__create_ticket', {}), { output: 'title required', isError: true });
    assert.match((await m.call('mcp__tracker__nope', {})).output, /not found/);
    assert.equal(mcpToolName('my server', 'do.it'), 'mcp__my_server__do_it');
  });

  it('times out, honours abort, filters tools and survives broken servers', async () => {
    const { m } = await tracker({ timeoutMs: 300, tools: ['lookup_ticket', 'slow'], readOnlyTools: ['slow'] });
    assert.equal(m.size, 2);
    assert.ok(m.isReadOnly('mcp__tracker__slow'), 'readOnlyTools from the config');
    assert.match((await m.call('mcp__tracker__slow', {})).output, /timed out/);
    const ctrl = new AbortController();
    const p = m.call('mcp__tracker__slow', {}, ctrl.signal);
    ctrl.abort();
    assert.match((await p).output, /cancelled/);
    const broken = new McpManager({ servers: { dead: { command: process.execPath, args: ['-e', 'process.exit(3)'] }, missing: { command: 'kurultay-no-such-binary' }, off: { command: 'x', enabled: false } } }, recordingBus());
    const r = await broken.start(5000);
    assert.deepEqual(r.servers, []);
    assert.deepEqual(r.failed.map((f) => f.server).sort(), ['dead', 'missing']);
    assert.match(r.failed.find((f) => f.server === 'dead')!.error, /exited \(code 3\)/);
    broken.close();
    m.close();
    assert.match((await m.call('mcp__tracker__lookup_ticket', { id: 'KUR-7' })).output, /not found/, 'closed manager has no tools');
  });

  it('workers see MCP tools; read-only workers only the read-only ones', async () => {
    const { m } = await tracker();
    const root = tmpProject({ 'a.txt': 'x' });
    const ctx = ctxFor(root, { external: m });
    assert.equal((await executeTool('mcp__tracker__lookup_ticket', { id: 'KUR-7' }, ctx)).output, 'KUR-7: Login fails when the password is empty');
    const ro = ctxFor(root, { external: m, allowed: new Set(['read_file']) });
    assert.match((await executeTool('mcp__tracker__create_ticket', { title: 'x' }, ro)).output, /not allowed/);
    assert.equal((await executeTool('mcp__tracker__lookup_ticket', { id: 'KUR-7' }, ro)).isError, false);
    assert.ok(toolSpecs(new Set(['read_file']), { external: m }).some((t) => t.function.name === 'mcp__tracker__lookup_ticket'));
    assert.ok(!toolSpecs(new Set(['read_file']), { external: m }).some((t) => t.function.name === 'mcp__tracker__create_ticket'));
  });

  it('an orchestrated worker uses an MCP tool to do its task', async () => {
    const { m } = await tracker();
    const handler = (q: { messages: Array<{ role: string; content: string | null }>; body: Record<string, unknown> }): MockReply | undefined => {
      const u = lastUser(q.messages);
      if (isAgent(q.messages)) {
        const step = toolResults(q.messages);
        if (step === 0) return { toolCall: { name: 'mcp__tracker__lookup_ticket', args: { id: 'KUR-7' } } };
        if (step === 1) {
          const ticket = q.messages.filter((x) => x.role === 'tool').pop()?.content ?? '';
          return { toolCall: { name: 'write_file', args: { path: 'BUG.md', content: `# ${ticket}\n` } } };
        }
        return { toolCall: { name: 'finish', args: { summary: 'done' } } };
      }
      if (/You are the planner of a team/.test(u)) return { content: JSON.stringify({ understanding: 'u', acceptance_criteria: ['BUG.md'], subtasks: [{ id: 'T1', title: 'note', description: 'write BUG.md from ticket KUR-7' }] }) };
      if (/final acceptance judge/.test(u)) return { content: '{"complete":true,"missing":[]}' };
      return undefined;
    };
    const s = await startMockServer([{ id: 'w1', quality: 'good', tools: true, ctx: 65536, handler }]);
    servers.push(s);
    const root = tmpProject({ 'README.md': '# x' }, { git: true });
    const cfg = config({ endpoints: [{ name: 'e', baseUrl: s.url }] });
    const index = new ProjectIndex(root, join(root, '.kurultay'));
    index.build();
    const orch = new Orchestrator(root, cfg, routerFor(cfg, [caps('w1', 'e')]), new Materializer(root, join(root, '.kurultay')), index, recordingBus());
    orch.external = m;
    const report = await orch.run('Write BUG.md from ticket KUR-7', { mode: 'single' });
    assert.equal(report.status, 'completed');
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(join(root, 'BUG.md'), 'utf8'), '# KUR-7: Login fails when the password is empty\n');
    const offered = (s.log.find((l) => Array.isArray(l.body.tools))!.body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    assert.ok(offered.includes('mcp__tracker__lookup_ticket'));
  });
});

describe('LSP diagnostics', () => {
  const lspCfg = { servers: { fake: { command: process.execPath, args: [LSP_JS], extensions: ['.foo', '.c'], settleMs: 200 } } };

  it('opens/changes documents and returns the settled diagnostics', async () => {
    const root = tmpProject({});
    const c = new LspClient('fake', lspCfg.servers.fake, root);
    await c.start();
    const d1 = await c.diagnostics('a.foo', 'ok\n  ERROR here\nWARN');
    assert.deepEqual(d1.map((d) => [d.line, d.col, d.severity, d.message]), [[2, 3, 1, 'unexpected token'], [3, 1, 2, 'style']]);
    assert.deepEqual(await c.diagnostics(join(root, 'a.foo'), 'fixed'), [], 'didChange on the second call');
    c.close();
    assert.equal(c.alive, false);
    await assert.rejects(c.diagnostics('a.foo', 'x'), /closed/);
    await assert.rejects(new LspClient('none', { command: 'kurultay-no-such-lsp', extensions: ['.x'] }, root).start(5000), /could not start|exited/);
  });

  it('is used by the post-edit check before compilers, with a pooled server per project', async () => {
    const root = tmpProject({ 'src/a.foo': 'fine\n', 'src/b.txt': 'x' });
    const m = new Materializer(root, join(root, '.kurultay'));
    const o = new Overlay('w', root);
    o.write('src/a.foo', 'line1\nERROR\n');
    const r = await syntaxCheck('src/a.foo', o, m, 'auto', undefined, lspCfg);
    assert.deepEqual(r, { checked: true, tool: 'LSP fake', errors: ['src/a.foo:2:1: error: unexpected token'] });
    assert.equal((await lspDiagnostics(lspCfg, root, 'src/b.txt', 'x')), undefined, 'no server for this extension');
    const again = await lspDiagnostics(lspCfg, root, join(root, 'src/a.foo'), 'ok');
    assert.deepEqual(again, { server: 'fake', diagnostics: [] });
    // a server that cannot start → the compiler check takes over
    const broken = { servers: { bad: { command: 'kurultay-no-such-lsp', extensions: ['.foo'] } } };
    assert.deepEqual(await syntaxCheck('src/a.foo', o, m, 'auto', undefined, broken), { checked: false, errors: [] });
    const ctx = ctxFor(root);
    ctx.config.lsp = lspCfg;
    await executeTool('read_file', { path: 'src/a.foo' }, ctx);
    const out = await executeTool('edit_file', { path: 'src/a.foo', old_text: 'fine', new_text: 'ERROR' }, ctx);
    assert.match(out.output, /LSP fake found compile errors in src\/a\.foo[\s\S]*src\/a\.foo:1:1: error: unexpected token/);
    await closeLspServers();
  });
});
