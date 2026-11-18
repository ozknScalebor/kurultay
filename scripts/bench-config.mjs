#!/usr/bin/env node
// Writes $KURULTAY_HOME/config.json for the bench from the API keys in the environment and prints
// GitHub step outputs (label=…). Main models: Groq gpt-oss-120b and, with GEMINI_API_KEY, the best
// free Gemini Flash the key can see; helper (summaries, compaction): Groq gpt-oss-20b.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const GROQ = 'https://api.groq.com/openai/v1';
// newest first; the first one the key can list is used
const GEMINI_PREFERENCE = [/^(models\/)?gemini-3\.8-flash$/, /^(models\/)?gemini-3\.5-flash$/, /^(models\/)?gemini-3\.\d+-flash$/, /^(models\/)?gemini-2\.5-flash$/];

export function pickGemini(ids) {
  for (const re of GEMINI_PREFERENCE) {
    const hit = ids.find((id) => re.test(id));
    if (hit) return hit.replace(/^models\//, '');
  }
  return undefined;
}

async function listModels(base, key) {
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.data ?? []).map((m) => String(m.id));
  } catch {
    return [];
  }
}

async function main() {
  const endpoints = [{ name: 'groq', baseUrl: GROQ, apiKey: '${GROQ_API_KEY}', models: ['openai/gpt-oss-120b'], maxConcurrency: 2 }];
  const labels = ['gpt-oss-120b (Groq)'];
  if (process.env.GEMINI_API_KEY) {
    const g = pickGemini(await listModels(GEMINI, process.env.GEMINI_API_KEY));
    if (g) {
      endpoints.push({ name: 'gemini', baseUrl: GEMINI, apiKey: '${GEMINI_API_KEY}', models: [g], maxConcurrency: 1 });
      labels.push(`${g} (Google)`);
    } else console.error('::warning::no free Gemini Flash model visible to GEMINI_API_KEY – running without it');
  }
  const config = {
    endpoints,
    helper: { name: 'helper', baseUrl: GROQ, apiKey: '${GROQ_API_KEY}', models: ['openai/gpt-oss-20b'] },
    skills: { includeUser: false },
  };
  const home = process.env.KURULTAY_HOME ?? '.bench-home';
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2));
  process.stdout.write(`label=Kurultay: ${labels.join(' + ')}, helper gpt-oss-20b · Qwen Code: gpt-oss-120b (Groq)\n`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) await main();
