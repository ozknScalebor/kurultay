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
  nvidia: { env: 'NVIDIA_API_KEY', base: 'https://integrate.api.nvidia.com/v1', prefer: [/kimi-k\d/i, /deepseek-v[4-9]/i, /minimax-m\d/i, /glm-[5-9]/i, /qwen3[.\d]*-coder/i, /mistral-large/i, /nemotron-3-ultra/i, /gpt-oss-120b/i, /step-\d/i], concurrency: 8, rpm: 40 },
  // a second NIM model from ANOTHER family than the first (same key; the 40 requests/min are shared)
  nvidia2: { env: 'NVIDIA_API_KEY', base: 'https://integrate.api.nvidia.com/v1', prefer: [/deepseek-v[4-9]/i, /minimax-m\d/i, /glm-[5-9]/i, /qwen3[.\d]*-coder/i, /mistral-large/i, /nemotron-3-ultra/i, /gpt-oss-120b/i, /step-\d/i, /kimi-k\d/i], concurrency: 8, rpm: 40, differentFrom: 'nvidia' },
  mistral: { env: 'MISTRAL_API_KEY', base: 'https://api.mistral.ai/v1', prefer: [/^devstral-medium/i, /^devstral/i, /^codestral-latest$/i, /^mistral-medium-latest$/i, /^mistral-large-latest$/i], concurrency: 1 },
  groq: { env: 'GROQ_API_KEY', base: 'https://api.groq.com/openai/v1', prefer: [/^openai\/gpt-oss-120b$/i], concurrency: 1 },
};
const HELPER = { nvidia: [/gpt-oss-20b/i, /nemotron-3\.5-lightning/i, /nemotron-3\.5-bolt/i, /gemma-3-12b-it/i, /llama-3\.1-8b-instruct/i, /phi-4-mini/i], mistral: [/^mistral-small-latest$/i, /^ministral-8b/i], groq: [/^openai\/gpt-oss-20b$/i] };

/** Model family of an id ("moonshotai/kimi-k2.6" → "kimi"). */
export function family(id) {
  const m = /(kimi|deepseek|glm|qwen|gpt-oss|llama|mistral|devstral|codestral|gemma|nemotron|phi)/i.exec(id);
  return m ? m[1].toLowerCase() : id;
}

/** First id matching the preferences, in preference order (instruct/chat variants, never base/embedding models). */
export function pick(ids, prefer) {
  const usable = ids.filter((id) => !/embed|rerank|guard|safety|vision-only|base$|ocr|moderation|tts|whisper|clip|detector|translate|calibration/i.test(id));
  for (const re of prefer) {
    // newest version first; reasoning-only variants last (slow for an agent loop)
    const slow = (id) => (/thinking|reason/i.test(id) ? 1 : 0);
    const hits = usable.filter((id) => re.test(id)).sort((a, b) => slow(a) - slow(b) || b.localeCompare(a, undefined, { numeric: true }));
    if (hits.length) return hits[0];
  }
  return undefined;
}

/**
 * A tiny chat request: does the model answer at all, and how fast? A free endpoint can list a
 * model and still queue every request for minutes – such a model makes the whole bench time out.
 */
export async function ping(base, key, id, timeoutMs = 60_000, doFetch = fetch) {
  const t0 = Date.now();
  try {
    const r = await doFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'Reply with the word OK.' }], max_tokens: 16, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { ok: false, ms: Date.now() - t0, error: `HTTP ${r.status}` };
    await r.json();
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e?.name === 'TimeoutError' ? 'no answer in time' : (e?.message ?? e)) };
  }
}

/** All ids matching the preferences, best first (same order as pick). */
export function candidates(ids, prefer) {
  const out = [];
  let rest = [...ids];
  for (;;) {
    const m = pick(rest, prefer);
    if (!m) return out;
    out.push(m);
    rest = rest.filter((x) => x !== m);
  }
}

/**
 * Best-preferred candidate that answers. All candidates are asked at once (30 s each), so a
 * free tier with several stuck models costs 30 s instead of a minute per model; every answer
 * is logged. A forced id is tried first even when the list does not show it.
 */
async function firstAnswering(name, base, key, ids, prefer, forced) {
  const list = [...(forced ? [forced] : []), ...candidates(ids, prefer).filter((x) => x !== forced)].slice(0, 6);
  const results = await Promise.all(list.map((id) => ping(base, key, id, 30_000)));
  list.forEach((id, i) => {
    const r = results[i];
    console.error(`${name}: ${id} → ${r.ok ? `answered in ${(r.ms / 1000).toFixed(1)} s` : `${r.error} after ${(r.ms / 1000).toFixed(0)} s`}`);
  });
  return list.find((_, i) => results[i].ok);
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
    if (!p.differentFrom) console.error(`::group::${name}: ${lists[name].length} models listed\n${lists[name].join('\n')}\n::endgroup::`);
    const taken = p.differentFrom && chosen[p.differentFrom] ? family(chosen[p.differentFrom]) : undefined;
    const forced = name === 'nvidia' ? process.env.BENCH_MODEL : name === 'nvidia2' ? process.env.BENCH_SECOND : undefined;
    const pool = lists[name].filter((id) => !taken || family(id) !== taken);
    const model = await firstAnswering(name, p.base, process.env[p.env], pool, p.prefer, forced || undefined);
    if (!model) {
      console.error(`::warning::${name}: no listed model of the preferred families answered – skipped`);
      continue;
    }
    chosen[name] = model;
    endpoints.push({ name, baseUrl: p.base, apiKey: `\${${p.env}}`, models: [model], maxConcurrency: p.concurrency, ...(p.rpm ? { requestsPerMinute: p.rpm } : {}) });
    labels.push(`${model} (${name})`);
  }
  if (!endpoints.length) {
    console.error('::error::no model answered – the free endpoint may be overloaded right now (try again later or set the model input), or the key is missing/invalid');
    process.exit(1);
  }
  let helper;
  for (const [name, prefer] of Object.entries(HELPER)) {
    const m = lists[name] && (await firstAnswering('helper', PROVIDERS[name].base, process.env[PROVIDERS[name].env], lists[name], prefer));
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
