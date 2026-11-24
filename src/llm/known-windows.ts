/**
 * Context windows of well-known model families, used when the server does not report one
 * (NVIDIA NIM, many proxies). Without it a probe that measures only up to 32k – or a model
 * that was never probed – runs a 256k model in 32k, and the worker then forgets and re-reads
 * files: twice the requests of an agent that knows the window (Qwen Code looks the window up
 * in such a table, packages/core/src/core/tokenLimits.ts).
 *
 * The values are the families' published windows, capped at 256k: a self-hosted server often
 * runs a smaller one and then reports it (vLLM max_model_len, llama.cpp n_ctx), which wins.
 * A context-length error at run time shrinks the window again (see the worker).
 */
const CAP = 262_144;

const PATTERNS: Array<[RegExp, number]> = [
  [/^kimi-|^k3[.-]/, 262_144],
  [/^qwen3[.-]|^qwen3$|^qwen4/, 262_144],
  [/^qwen2\.5-coder/, 32_768],
  [/^qwen/, 131_072],
  [/^deepseek-(?:v4|flash)/, 262_144],
  [/^deepseek/, 131_072],
  [/^glm-/, 202_752],
  [/^minimax-/, 200_000],
  [/^gpt-oss/, 131_072],
  [/^gpt-5/, 262_144],
  [/^gpt-4\.1/, 262_144],
  [/^gpt-4o/, 131_072],
  [/^claude-/, 200_000],
  [/^gemini-/, 262_144],
  [/^gemma-[34]/, 131_072],
  [/^(?:meta-)?llama-?3\.[1-9]|^llama-4/, 131_072],
  [/^(?:mistral-large|mistral-medium|devstral|codestral)/, 131_072],
  [/^nemotron/, 131_072],
];

/** "moonshotai/Kimi-K3.1-Pro" → "kimi-k3.1-pro"; quantisation suffixes stay (they do not match anything wrong). */
export function normalizeModelId(id: string): string {
  return id.toLowerCase().split('/').pop()!.replace(/^(?:models--|hf\.co-)/, '').replace(/\.gguf$/, '');
}

export function knownContextWindow(id: string): number | undefined {
  const m = normalizeModelId(id);
  for (const [re, n] of PATTERNS) if (re.test(m)) return Math.min(CAP, n);
  return undefined;
}
