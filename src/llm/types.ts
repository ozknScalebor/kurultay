export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'none' | 'required';
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  stop?: string[];
  /** stream tokens (default true) */
  stream?: boolean;
  onToken?: (chunk: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** abort when no token arrived within this time (streaming only; 0/undefined = off) */
  firstTokenTimeoutMs?: number;
  /** abort when the stream is silent for this long after it started (streaming only) */
  idleTimeoutMs?: number;
  /** free-form label for logs/telemetry ("probe", "summary", "worker-2"...) */
  purpose?: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResult {
  content: string;
  thinking: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: Usage;
  /** time to first token (ms) */
  ttftMs: number;
  durationMs: number;
  /** model key "model@endpoint" that actually answered */
  model: string;
}

export type LlmErrorKind = 'network' | 'timeout' | 'rate_limit' | 'server' | 'auth' | 'not_found' | 'context_length' | 'bad_request' | 'aborted' | 'circuit_open';

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: LlmErrorKind,
    readonly status?: number,
    readonly model?: string,
    /** server-requested wait (Retry-After header), ms */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }

  get retryable(): boolean {
    return this.kind === 'network' || this.kind === 'timeout' || this.kind === 'rate_limit' || this.kind === 'server';
  }

  /** Should the router move on to a different model? */
  get fallbackable(): boolean {
    return this.kind !== 'aborted';
  }
}
