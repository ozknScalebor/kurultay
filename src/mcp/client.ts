import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Minimal Model Context Protocol client over stdio (newline-delimited JSON-RPC
 * 2.0, spec 2025-06-18): initialize → tools/list → tools/call. Enough to use
 * the user's local MCP servers (databases, issue trackers, internal docs…) as
 * worker tools without any dependency.
 */

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** set false to keep the entry in the config without starting it */
  enabled?: boolean;
  /** per tools/call timeout (default 120 s) */
  timeoutMs?: number;
  /** only expose these tools (default: all) */
  tools?: string[];
  /** tools that only read – they are also offered to read-only reviewers */
  readOnlyTools?: string[];
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export class McpClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buf = '';
  private stderr = '';
  private closed = false;
  serverInfo?: { name?: string; version?: string };

  constructor(
    readonly name: string,
    private readonly cfg: McpServerConfig,
  ) {}

  async start(timeoutMs = 30_000): Promise<void> {
    const child = spawn(this.cfg.command, this.cfg.args ?? [], {
      cwd: this.cfg.cwd,
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32', // npx / .cmd shims on Windows
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => this.onData(d));
    child.stderr.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString('utf8')).slice(-4000);
    });
    child.on('exit', (code) => this.fail(new Error(`MCP sunucusu ${this.name} kapandı (çıkış ${code ?? '-'})${this.stderr ? `: ${this.stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`)));
    child.on('error', (e) => this.fail(new Error(`MCP sunucusu ${this.name} başlatılamadı: ${e.message}`)));
    const init = (await this.request(
      'initialize',
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'kurultay', version: '1' } },
      timeoutMs,
    )) as { serverInfo?: { name?: string; version?: string } };
    this.serverInfo = init?.serverInfo;
    this.notify('notifications/initialized');
  }

  async listTools(timeoutMs = 30_000): Promise<McpTool[]> {
    const out: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = (await this.request('tools/list', cursor ? { cursor } : {}, timeoutMs)) as { tools?: McpTool[]; nextCursor?: string };
      out.push(...(r?.tools ?? []));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const id = this.nextId;
    const onAbort = () => {
      this.notify('notifications/cancelled', { requestId: id, reason: 'aborted' });
      this.pending.get(id)?.reject(new Error('iptal edildi'));
      this.pending.delete(id);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const r = (await this.request('tools/call', { name, arguments: args }, this.cfg.timeoutMs ?? 120_000)) as {
        content?: Array<{ type: string; text?: string; mimeType?: string; resource?: { uri?: string; text?: string } }>;
        structuredContent?: unknown;
        isError?: boolean;
      };
      const parts = (r?.content ?? []).map((c) =>
        c.type === 'text' ? (c.text ?? '') : c.type === 'resource' ? `[kaynak ${c.resource?.uri ?? ''}]\n${c.resource?.text ?? ''}` : `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ''}]`,
      );
      if (!parts.length && r?.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent, null, 1));
      return { text: parts.join('\n'), isError: !!r?.isError };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error('kapatıldı'));
    try {
      this.child?.stdin.end();
      this.child?.kill();
    } catch {
      /* already gone */
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed || !this.child) return Promise.reject(new Error(`MCP sunucusu ${this.name} çalışmıyor`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.name}: ${method} zaman aşımı (${Math.round(timeoutMs / 1000)} sn)`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params?: unknown): void {
    if (!this.closed) this.write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  private write(msg: unknown): void {
    try {
      this.child?.stdin.write(JSON.stringify(msg) + '\n');
    } catch {
      /* exit handler reports it */
    }
  }

  private onData(d: string): void {
    this.buf += d;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number | string; result?: unknown; error?: { message?: string; code?: number }; method?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // servers sometimes log to stdout
      }
      if (msg.method && msg.id !== undefined) {
        // server → client request (ping, roots/list, sampling…): answer minimally
        this.write({ jsonrpc: '2.0', id: msg.id, ...(msg.method === 'ping' ? { result: {} } : msg.method === 'roots/list' ? { result: { roots: [] } } : { error: { code: -32601, message: 'not supported' } }) });
        continue;
      }
      if (typeof msg.id !== 'number') continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`MCP ${this.name}: ${msg.error.message ?? 'hata'} (${msg.error.code ?? '?'})`));
      else p.resolve(msg.result);
    }
  }

  private fail(e: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
      this.pending.delete(id);
    }
    this.closed = true; // exit / spawn error / close: the server is gone
  }
}
