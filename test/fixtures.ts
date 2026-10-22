import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpProject } from './helpers.js';

/** Write a CommonJS fixture script to a temp dir and return its path. */
export function script(code: string): string {
  const p = join(tmpProject({}), 'server.cjs');
  writeFileSync(p, code);
  return p;
}

/** A tiny MCP server: an issue tracker with a read-only lookup and a write tool. */
export const FAKE_MCP = String.raw`
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
process.stdout.write('fake-mcp starting (log line on stdout)\n');
const tickets = { 'KUR-7': 'Login fails when the password is empty' };
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: 99, method: 'ping' }); // server → client request
    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-tracker', version: '1.0' } } });
  }
  if (m.method === 'tools/list') {
    if (!m.params.cursor) return send({ jsonrpc: '2.0', id: m.id, result: { nextCursor: 'p2', tools: [{ name: 'lookup_ticket', description: 'Read a ticket', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, annotations: { readOnlyHint: true } }] } });
    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'create_ticket', description: 'Create a ticket', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } }, { name: 'slow', description: 'never answers' }] } });
  }
  if (m.method === 'tools/call') {
    const a = m.params.arguments || {};
    if (m.params.name === 'lookup_ticket') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: tickets[a.id] ? a.id + ': ' + tickets[a.id] : 'not found' }] } });
    if (m.params.name === 'create_ticket') return send({ jsonrpc: '2.0', id: m.id, result: a.title ? { content: [{ type: 'text', text: 'created KUR-8' }, { type: 'image', mimeType: 'image/png', data: '' }] } : { isError: true, content: [{ type: 'text', text: 'title required' }] } });
    if (m.params.name === 'slow') return;
    return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'unknown tool' } });
  }
  if (m.id !== undefined && m.method) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } });
});
`;

/** A tiny language server: lines containing ERROR are errors, WARN warnings; publishes twice. */
export const FAKE_LSP = String.raw`
let buf = Buffer.alloc(0);
const send = (m) => { const b = Buffer.from(JSON.stringify(m)); process.stdout.write('Content-Length: ' + b.length + '\r\n\r\n'); process.stdout.write(b); };
const publish = (uri, text) => {
  send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } });
  setTimeout(() => {
    const diagnostics = [];
    text.split('\n').forEach((l, i) => {
      if (l.includes('ERROR')) diagnostics.push({ range: { start: { line: i, character: l.indexOf('ERROR') } }, severity: 1, message: 'unexpected token', source: 'fake' });
      if (l.includes('WARN')) diagnostics.push({ range: { start: { line: i, character: 0 } }, severity: 2, message: 'style' });
    });
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
  }, 60);
};
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n'); if (sep < 0) return;
    const len = Number(/Content-Length: (\d+)/.exec(buf.subarray(0, sep).toString())[1]);
    if (buf.length < sep + 4 + len) return;
    const m = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString()); buf = buf.subarray(sep + 4 + len);
    if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: 50, method: 'workspace/configuration', params: { items: [] } }); send({ jsonrpc: '2.0', id: m.id, result: { capabilities: { textDocumentSync: 1 } } }); }
    else if (m.method === 'textDocument/didOpen') publish(m.params.textDocument.uri, m.params.textDocument.text);
    else if (m.method === 'textDocument/didChange') publish(m.params.textDocument.uri, m.params.contentChanges[0].text);
    else if (m.method === 'shutdown') send({ jsonrpc: '2.0', id: m.id, result: null });
    else if (m.method === 'exit') process.exit(0);
  }
});
`;

