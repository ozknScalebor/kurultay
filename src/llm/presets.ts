/**
 * Sampling settings recommended by the model publishers. Local servers (llama.cpp,
 * Ollama, vLLM) otherwise use their own defaults (e.g. llama.cpp min_p 0.1, greedy
 * or temperature 0.8), which is not what these models were tuned for.
 *
 * Sources (checked 2026-11):
 *  - Qwen3-Coder: temperature 0.7, top_p 0.8, top_k 20, repetition_penalty 1.05
 *    (Qwen model card, repeated in the Unsloth "Qwen3-Coder: How to Run Locally" guide)
 *  - Qwen3 hybrid / 2507 Instruct (non-thinking): 0.7 / 0.8 / 20, min_p 0
 *    Qwen3 thinking / 2507 Thinking: 0.6 / 0.95 / 20, min_p 0; "avoid greedy decoding"
 *    (Qwen3 model card "Best Practices"; Unsloth Qwen3-2507 guide)
 *  - Devstral Small: temperature 0.15 (mistralai/Devstral-Small-2507 model card)
 *  - gpt-oss: temperature 1.0, top_p 1.0 (OpenAI recommendation quoted in the gpt-oss docs)
 *
 * Models without a preset keep the server's defaults. A model's own `temperature` /
 * `extraBody` in the configuration always wins.
 */

export interface SamplingPreset {
  family: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  repetition_penalty?: number;
  /**
   * Hybrid reasoning model whose thinking can be switched off with the `/no_think`
   * soft switch (Qwen3 hybrid). Long hidden reasoning makes slow local models time out.
   */
  hybridThinking?: boolean;
}

interface Rule {
  test: (id: string) => boolean;
  preset: SamplingPreset;
}

const has = (id: string, ...words: RegExp[]) => words.every((w) => w.test(id));

const RULES: Rule[] = [
  { test: (id) => has(id, /qwen-?3/, /coder/), preset: { family: 'qwen3-coder', temperature: 0.7, top_p: 0.8, top_k: 20, repetition_penalty: 1.05 } },
  { test: (id) => has(id, /qwen-?3/, /thinking/), preset: { family: 'qwen3-thinking', temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 } },
  { test: (id) => has(id, /qwen-?3/, /2507|instruct/), preset: { family: 'qwen3-instruct', temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0 } },
  // the original Qwen3 release is hybrid: thinking on by default, /no_think switches it off
  { test: (id) => /qwen-?3(?![.\d])/.test(id), preset: { family: 'qwen3', temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, hybridThinking: true } },
  { test: (id) => /devstral/.test(id), preset: { family: 'devstral', temperature: 0.15 } },
  { test: (id) => /gpt-?oss/.test(id), preset: { family: 'gpt-oss', temperature: 1.0, top_p: 1.0 } },
];

/** The publisher's recommended sampling for a model id (as the server names it), if known. */
export function presetFor(modelId: string): SamplingPreset | undefined {
  const id = modelId.toLowerCase();
  return RULES.find((r) => r.test(id))?.preset;
}

/**
 * Request body fields for a preset. `repeat_penalty` is llama.cpp's name for
 * `repetition_penalty` (vLLM); servers ignore the one they do not know.
 */
export function presetBody(p: SamplingPreset): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (p.top_p !== undefined) body.top_p = p.top_p;
  if (p.top_k !== undefined) body.top_k = p.top_k;
  if (p.min_p !== undefined) body.min_p = p.min_p;
  if (p.repetition_penalty !== undefined) {
    body.repetition_penalty = p.repetition_penalty;
    body.repeat_penalty = p.repetition_penalty;
  }
  return body;
}
