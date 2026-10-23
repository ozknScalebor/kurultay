import type { ToolSpec } from '../llm/types.js';
import { errorMessage } from '../util/async.js';
import type { EventBus } from '../util/events.js';
import { McpClient, type McpServerConfig, type McpTool } from './client.js';

/**
 * Tools that do not live in Kurultay itself (MCP servers). Workers see them
 * next to the built-in tools as `mcp__<server>__<tool>`.
 */
export interface ExternalTools {
  specs(readOnlyOnly?: boolean): ToolSpec[];
  has(name: string): boolean;
  isReadOnly(name: string): boolean;
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ output: string; isError?: boolean }>;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

const MAX_OUTPUT = 12_000;

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server.replace(/[^\w-]/g, '_')}__${tool.replace(/[^\w-]/g, '_')}`.slice(0, 64);
}

export class McpManager implements ExternalTools {
  private readonly clients = new Map<string, McpClient>();
  private readonly tools = new Map<string, { server: string; tool: McpTool; readOnly: boolean }>();

  constructor(
    private readonly cfg: McpConfig | undefined,
    private readonly bus?: EventBus,
  ) {}

  get size(): number {
    return this.tools.size;
  }

  /** Start every enabled server; a broken server is reported and skipped. */
  async start(timeoutMs = 30_000): Promise<{ servers: string[]; failed: Array<{ server: string; error: string }> }> {
    const failed: Array<{ server: string; error: string }> = [];
    const entries = Object.entries(this.cfg?.servers ?? {}).filter(([, c]) => c.enabled !== false);
    await Promise.all(
      entries.map(async ([name, c]) => {
        const client = new McpClient(name, c);
        try {
          await client.start(timeoutMs);
          const list = await client.listTools(timeoutMs);
          const allow = c.tools?.length ? new Set(c.tools) : undefined;
          for (const t of list) {
            if (allow && !allow.has(t.name)) continue;
            const readOnly = !!t.annotations?.readOnlyHint || !!c.readOnlyTools?.includes(t.name);
            this.tools.set(mcpToolName(name, t.name), { server: name, tool: t, readOnly });
          }
          this.clients.set(name, client);
          this.bus?.info('mcp', `${name}: ${list.length} tools${client.serverInfo?.name ? ` (${client.serverInfo.name})` : ''}`);
        } catch (e) {
          client.close();
          failed.push({ server: name, error: errorMessage(e) });
          this.bus?.warn('mcp', `${name} could not start: ${errorMessage(e)}`);
        }
      }),
    );
    return { servers: [...this.clients.keys()], failed };
  }

  specs(readOnlyOnly = false): ToolSpec[] {
    return [...this.tools.entries()]
      .filter(([, t]) => !readOnlyOnly || t.readOnly)
      .map(([name, t]) => ({
        type: 'function' as const,
        function: {
          name,
          description: `[MCP ${t.server}] ${t.tool.description ?? t.tool.name}`.slice(0, 1024),
          parameters: (t.tool.inputSchema as Record<string, unknown> | undefined) ?? { type: 'object', properties: {} },
        },
      }));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  isReadOnly(name: string): boolean {
    return !!this.tools.get(name)?.readOnly;
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ output: string; isError?: boolean }> {
    const t = this.tools.get(name);
    const client = t && this.clients.get(t.server);
    if (!t || !client) return { output: `MCP tool not found: ${name}`, isError: true };
    this.bus?.emitEvent('tool.mcp', { message: `${t.server}/${t.tool.name}` });
    try {
      const r = await client.callTool(t.tool.name, args, signal);
      const text = r.text.length > MAX_OUTPUT ? `${r.text.slice(0, MAX_OUTPUT)}\n… (${r.text.length - MAX_OUTPUT} characters cut)` : r.text;
      return { output: text || '(empty result)', isError: r.isError };
    } catch (e) {
      return { output: `MCP error (${t.server}/${t.tool.name}): ${errorMessage(e)}`, isError: true };
    }
  }

  close(): void {
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
    this.tools.clear();
  }
}
