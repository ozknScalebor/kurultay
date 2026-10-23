import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Minimal Language Server Protocol client used only for diagnostics
 * (Serena / Crush / OpenCode style): initialize → didOpen/didChange →
 * textDocument/publishDiagnostics. Works with clangd, jdtls, pyright,
 * typescript-language-server, rust-analyzer… whatever is installed offline.
 */

export interface LspServerConfig {
  command: string;
  args?: string[];
  /** file extensions this server handles, e.g. [".c", ".cpp", ".h"] */
  extensions: string[];
  /** LSP languageId per extension (default derived from the extension) */
  languageIds?: Record<string, string>;
  initializationOptions?: unknown;
  /** wait at most this long for diagnostics of one file (default 20 s; jdtls needs longer on first start) */
  timeoutMs?: number;
  /** after the first diagnostics arrive, wait this long for updates (default 400 ms) */
  settleMs?: number;
  enabled?: boolean;
}

export interface LspConfig {
  servers: Record<string, LspServerConfig>;
}

export interface Diagnostic {
  line: number;
  col: number;
  severity: number;
  message: string;
  source?: string;
}

const LANG: Record<string, string> = {
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp',
  '.java': 'java', '.py': 'python', '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact',
  '.go': 'go', '.rs': 'rust', '.cs': 'csharp', '.kt': 'kotlin',
};

/** Content-Length framed JSON-RPC over stdio. */
export class LspClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buf = Buffer.alloc(0);
  private readonly versions = new Map<string, number>();
  private readonly waiters = new Map<string, Array<(d: Diagnostic[]) => void>>();
  private readonly latest = new Map<string, Diagnostic[]>();
  private dead?: Error;
  private stderr = '';

  constructor(
    readonly name: string,
    private readonly cfg: LspServerConfig,
    readonly root: string,
  ) {}

  async start(timeoutMs = 30_000): Promise<void> {
    const child = spawn(this.cfg.command, this.cfg.args ?? [], { cwd: this.root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' });
    this.child = child;
    child.stdout.on('data', (d: Buffer) => this.onData(d));
    child.stderr.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString('utf8')).slice(-2000);
    });
    const die = (e: Error) => {
      this.dead = e;
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    };
    child.on('exit', (code) => die(new Error(`LSP ${this.name} exited (code ${code ?? '-'})`)));
    child.on('error', (e) => die(new Error(`LSP ${this.name} could not start: ${e.message}`)));
    const rootUri = pathToFileURL(this.root).href;
    await withTimeout(
      this.request('initialize', {
        processId: process.pid,
        rootUri,
        rootPath: this.root,
        workspaceFolders: [{ uri: rootUri, name: 'project' }],
        capabilities: { textDocument: { publishDiagnostics: { relatedInformation: false }, synchronization: { didSave: false } }, workspace: { workspaceFolders: true } },
        initializationOptions: this.cfg.initializationOptions,
      }),
      timeoutMs,
      `LSP ${this.name} initialize`,
    );
    this.notify('initialized', {});
  }

  get alive(): boolean {
    return !this.dead && !!this.child;
  }

  /** Diagnostics for `path` with the given (possibly unsaved) content. */
  async diagnostics(path: string, text: string): Promise<Diagnostic[]> {
    if (this.dead) throw this.dead;
    const abs = isAbsolute(path) ? path : resolve(this.root, path);
    const uri = pathToFileURL(abs).href;
    const ext = extname(abs).toLowerCase();
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    this.latest.delete(uri);
    const first = new Promise<Diagnostic[]>((res) => this.waiters.set(uri, [...(this.waiters.get(uri) ?? []), res]));
    if (version === 1) this.notify('textDocument/didOpen', { textDocument: { uri, languageId: this.cfg.languageIds?.[ext] ?? LANG[ext] ?? ext.slice(1), version, text } });
    else this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    await withTimeout(first, this.cfg.timeoutMs ?? 20_000, `LSP ${this.name} diagnostics`);
    // servers often publish twice (fast syntax pass, then semantic pass): settle briefly
    await new Promise((r) => setTimeout(r, this.cfg.settleMs ?? 400));
    return this.latest.get(uri) ?? [];
  }

  close(): void {
    if (!this.child || this.dead) return;
    try {
      void this.request('shutdown', null).catch(() => undefined);
      this.notify('exit');
      setTimeout(() => this.child?.kill(), 500).unref();
    } catch {
      this.child.kill();
    }
    this.dead = new Error('closed');
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  private send(msg: unknown): void {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    try {
      this.child?.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
    } catch {
      /* exit handler reports it */
    }
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const len = Number(/Content-Length:\s*(\d+)/i.exec(this.buf.subarray(0, sep).toString('ascii'))?.[1] ?? NaN);
      if (!Number.isFinite(len)) {
        this.buf = this.buf.subarray(sep + 4);
        continue;
      }
      if (this.buf.length < sep + 4 + len) return;
      const raw = this.buf.subarray(sep + 4, sep + 4 + len).toString('utf8');
      this.buf = this.buf.subarray(sep + 4 + len);
      let msg: { id?: number; method?: string; params?: { uri?: string; diagnostics?: Array<{ range?: { start?: { line?: number; character?: number } }; severity?: number; message?: string; source?: string }> }; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      if (msg.method === 'textDocument/publishDiagnostics' && msg.params?.uri) {
        const diags = (msg.params.diagnostics ?? []).map((x) => ({ line: (x.range?.start?.line ?? 0) + 1, col: (x.range?.start?.character ?? 0) + 1, severity: x.severity ?? 1, message: x.message ?? '', source: x.source }));
        this.latest.set(msg.params.uri, diags);
        const w = this.waiters.get(msg.params.uri);
        this.waiters.delete(msg.params.uri);
        w?.forEach((f) => f(diags));
      } else if (msg.method && msg.id !== undefined) {
        // server → client requests (workspace/configuration, window/workDoneProgress/create…)
        this.send({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'workspace/configuration' ? [] : null });
      } else if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`LSP ${this.name}: ${msg.error.message ?? 'error'}`));
        else p.resolve(msg.result);
      }
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${what} timed out (${Math.round(ms / 1000)} s)`)), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        res(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        rej(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** One running server per (name, project root); started lazily, reused across edits. */
const pool = new Map<string, Promise<LspClient>>();

export function lspFor(cfg: LspConfig | undefined, root: string, path: string): { name: string; server: LspServerConfig } | undefined {
  const ext = extname(path).toLowerCase();
  for (const [name, server] of Object.entries(cfg?.servers ?? {})) {
    if (server.enabled !== false && server.extensions.map((e) => e.toLowerCase()).includes(ext)) return { name, server };
  }
  return undefined;
}

export async function lspDiagnostics(cfg: LspConfig | undefined, root: string, path: string, text: string): Promise<{ server: string; diagnostics: Diagnostic[] } | undefined> {
  const hit = lspFor(cfg, root, path);
  if (!hit) return undefined;
  const key = `${hit.name}\0${root}`;
  let p = pool.get(key);
  if (!p) {
    const c = new LspClient(hit.name, hit.server, root);
    p = c.start().then(() => c);
    pool.set(key, p);
    p.catch(() => pool.delete(key));
  }
  const client = await p;
  if (!client.alive) {
    pool.delete(key); // crashed since the last use: start a fresh one
    return lspDiagnostics(cfg, root, path, text);
  }
  const rel = isAbsolute(path) ? relative(root, path) : path;
  return { server: hit.name, diagnostics: await client.diagnostics(rel, text) };
}

/** Stop every pooled language server (end of a CLI command / console exit). */
export async function closeLspServers(): Promise<void> {
  const all = [...pool.values()];
  pool.clear();
  for (const p of all) {
    try {
      (await p).close();
    } catch {
      /* failed to start */
    }
  }
}
