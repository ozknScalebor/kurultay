#!/usr/bin/env node
/* global fetch, AbortSignal */
// Writes $KURULTAY_HOME/config.json for the bench from the API keys in the environment and prints
// GitHub step outputs: label, qwen_base, qwen_model, qwen_key_env, solo_config.
//
// Fairness: the first model (Kimi K2 on NIM) is Kurultay's MAIN model (orchestrator.primaryModel)
// and the only model Qwen Code gets. A second config, config-solo.json, runs Kurultay with that
// model alone, so the bench shows what the extra models add – or cost – in time.
// Concurrency: no small fixed cap. NIM allows 40 requests/min per key, so every NIM endpoint
// carries requestsPerMinute: 40 (one limiter shared by all models of the key) and a generous
// maxConcurrency; requests wait for the limit instead of failing with 429.
//
// Chosen for their FREE TOKEN volume (a Kurultay task sends tens of thousands of prompt tokens
// per request), not only their request counts:
//   NVIDIA NIM      40 requests/min, no daily token cap → BOTH main models from two different
//                   families (Kimi K2 and DeepSeek / GLM / Qwen3-Coder) + a small helper; one key
//   Mistral         used when a key is given (free tier availability varies by account)
//   Groq            only a fallback: 200 K tokens/day per model is a handful of agent tasks
// The model ids are read from each provider's /models list, newest preference first.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROVIDERS = {
  nvidia: { env: 'NVIDIA_API_KEY', base: 'https://integrate.api.nvidia.com/v1', prefer: [/kimi-k2/i, /deepseek-v4/i, /deepseek-v3/i, /glm-5/i, /qwen3-coder/i, /gpt-oss-120b/i], concurrency: 8, rpm: 40 },
  // a second NIM model from ANOTHER family than the first (same key; the 40 requests/min are shared)
  nvidia2: { env: 'NVIDIA_API_KEY', base: 'https://integrate.api.nvidia.com/v1', prefer: [/deepseek-v4/i, /glm-5/i, /qwen3-coder/i, /deepseek-v3/i, /glm-4\.[5-9]/i, /gpt-oss-120b/i], concurrency: 8, rpm: 40, differentFrom: 'nvidia' },
  mistral: { env: 'MISTRAL_API_KEY', base: 'https://api.mistral.ai/v1', prefer: [/^devstral-medium/i, /^devstral/i, /^codestral-latest$/i, /^mistral-medium-latest$/i, /^mistral-large-latest$/i], concurrency: 1 },
  groq: { env: 'GROQ_API_KEY', base: 'https://api.groq.com/openai/v1', prefer: [/^openai\/gpt-oss-120b$/i], concurrency: 1 },
};
const HELPER = { nvidia: [/gpt-oss-20b/i, /llama-3\.1-8b-instruct/i, /phi-4-mini/i], mistral: [/^mistral-small-latest$/i, /^ministral-8b/i], groq: [/^openai\/gpt-oss-20b$/i] };

/** Model family of an id ("moonshotai/kimi-k2.6" → "kimi"). */
export function family(id) {
  const m = /(kimi|deepseek|glm|qwen|gpt-oss|llama|mistral|devstral|codestral|gemma|nemotron|phi)/i.exec(id);
  return m ? m[1].toLowerCase() : id;
}

/** First id matching the preferences, in preference order (instruct/chat variants, never base/embedding models). */
export function pick(ids, prefer) {
  const usable = ids.filter((id) => !/embed|rerank|guard|vision-only|base$|ocr|moderation|tts|whisper/i.test(id));
  for (const re of prefer) {
    // newest version first; reasoning-only variants last (slow for an agent loop)
    const slow = (id) => (/thinking|reason/i.test(id) ? 1 : 0);
    const hits = usable.filter((id) => re.test(id)).sort((a, b) => slow(a) - slow(b) || b.localeCompare(a, undefined, { numeric: true }));
    if (hits.length) return hits[0];
  }
  return undefined;
}

async function listModels(base, key) {
  try {
    const r = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.data ?? []).map((m) => String(m.id));
  } catch {
    return [];
  }
}

async function main() {
  const endpoints = [];
  const labels = [];
  const lists = {};
  const chosen = {};
  for (const [name, p] of Object.entries(PROVIDERS)) {
    if (!process.env[p.env]) continue;
    // two main models are enough; Mistral / Groq only fill a missing slot
    if (endpoints.length >= 2) continue;
    lists[name] = lists[p.differentFrom] ?? (await listModels(p.base, process.env[p.env]));
    const taken = p.differentFrom && chosen[p.differentFrom] ? family(chosen[p.differentFrom]) : undefined;
    const model = pick(lists[name].filter((id) => !taken || family(id) !== taken), p.prefer);
    if (!model) {
      console.error(`::warning::${name}: no suitable model in its /models list – skipped`);
      continue;
    }
    chosen[name] = model;
    endpoints.push({ name, baseUrl: p.base, apiKey: `\${${p.env}}`, models: [model], maxConcurrency: p.concurrency, ...(p.rpm ? { requestsPerMinute: p.rpm } : {}) });
    labels.push(`${model} (${name})`);
  }
  if (!endpoints.length) {
    console.error('::error::no usable model – set NVIDIA_API_KEY and/or MISTRAL_API_KEY or GROQ_API_KEY');
    process.exit(1);
  }
  let helper;
  for (const [name, prefer] of Object.entries(HELPER)) {
    const m = lists[name] && pick(lists[name], prefer);
    if (m) {
      helper = { name: 'helper', baseUrl: PROVIDERS[name].base, apiKey: `\${${PROVIDERS[name].env}}`, models: [m], ...(PROVIDERS[name].rpm ? { requestsPerMinute: PROVIDERS[name].rpm } : {}) };
      break;
    }
  }
  const main = endpoints[0];
  const config = { endpoints, ...(helper ? { helper } : {}), orchestrator: { primaryModel: main.models[0] }, skills: { includeUser: false } };
  const solo = { endpoints: [main], orchestrator: { primaryModel: main.models[0] }, skills: { includeUser: false } };
  const home = process.env.KURULTAY_HOME ?? '.bench-home';
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(home, 'config-solo.json'), JSON.stringify(solo, null, 2));
  // Qwen Code gets the first (strongest) model – the same one Kurultay leans on
  const keyEnv = Object.values(PROVIDERS).find((p) => p.base === main.baseUrl).env;
  process.stdout.write(
    [
      `label=Kurultay: main ${main.models[0]} + ${labels.slice(1).join(' + ') || 'no second model'}${helper ? `, helper ${helper.models[0]}` : ''} · Qwen Code: ${main.models[0]}`,
      `qwen_base=${main.baseUrl}`,
      `qwen_model=${main.models[0]}`,
      `qwen_key_env=${keyEnv}`,
      `solo_config=${join(home, 'config-solo.json')}`,
      '',
    ].join('\n'),
  );
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) await main();
