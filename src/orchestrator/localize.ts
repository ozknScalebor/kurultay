import type { ProjectIndex } from '../index/project-index.js';
import type { SymbolDef } from '../index/symbols.js';
import type { Router } from '../llm/router.js';
import { LOCATE_ELEMENTS_SCHEMA, LOCATE_FILES_SCHEMA } from '../llm/schemas.js';
import type { EventBus } from '../util/events.js';
import { errorMessage } from '../util/async.js';
import { truncateTokens, tryExtractJson } from '../util/text.js';

/**
 * Localisation before the agent loop (Agentless): narrow the code down in fixed steps –
 * files, then classes/functions from a skeleton of those files, then their full code –
 * and hand the worker only that focused context. Weak models compound errors in long
 * free exploration (Agentless), and every model does better with a short focused prompt
 * than with a long one (Chroma "Context Rot": ~300-token focused prompts beat ~113k ones).
 */

export interface Location {
  path: string;
  symbol: string;
  start: number;
  end: number;
}

export interface Localization {
  files: string[];
  locations: Location[];
  /** prompt section for the workers ('' when nothing useful was found) */
  context: string;
  model?: string;
}

const MAX_CANDIDATES = 30;
const MAX_FILES = 4;
const MAX_LOCATIONS = 8;

export async function localize(
  index: ProjectIndex,
  router: Router,
  task: string,
  hints: { files?: string[]; retrieved?: string[] },
  opts: { budgetTokens: number; signal?: AbortSignal; bus?: EventBus; source?: string },
): Promise<Localization | undefined> {
  const known = new Set(index.files.map((f) => f.path));
  const candidates = [...new Set([...(hints.files ?? []), ...(hints.retrieved ?? []), ...index.search(task, MAX_CANDIDATES).map((h) => h.path)])].filter((p) => known.has(p)).slice(0, MAX_CANDIDATES);
  if (!candidates.length) return undefined;
  const source = opts.source ?? 'localize';
  try {
    // 1. files
    const listing = candidates
      .map((p) => {
        const f = index.file(p)!;
        const defs = f.defs.slice(0, 8).map((d) => d.name).join(', ');
        return `- ${p}${f.summary ? ` – ${f.summary.replace(/\s+/g, ' ').slice(0, 160)}` : ''}${defs ? ` [${defs}]` : ''}`;
      })
      .join('\n');
    const r1 = await router.chat(
      {
        messages: [{ role: 'user', content: `Task:\n${task}\n\nCandidate files of the project:\n${listing}\n\nWhich files must be EDITED to complete the task? List at most ${MAX_FILES} paths from the list, most likely first. Return ONLY JSON: {"files": ["path", ...]}` }],
        temperature: 0,
        jsonMode: true,
        jsonSchema: LOCATE_FILES_SCHEMA,
        maxTokens: 400,
        purpose: 'localize.files',
        signal: opts.signal,
      },
      { role: 'planner' },
    );
    const files = (tryExtractJson<{ files?: unknown[] }>(r1.content)?.files ?? []).map(String).filter((p) => known.has(p)).slice(0, MAX_FILES);
    if (!files.length) return undefined;

    // 2. classes / functions from a skeleton of those files
    const skeleton = files.map((p) => `## ${p}\n${(index.file(p)!.defs.length ? index.file(p)!.defs.map((d) => `L${d.line}: ${d.signature}`) : ['(no definitions found – whole file)']).join('\n')}`).join('\n\n');
    let picked: Array<{ file: string; symbol: string }> = [];
    if (files.some((p) => index.file(p)!.defs.length)) {
      const r2 = await router.chat(
        {
          messages: [{ role: 'user', content: `Task:\n${task}\n\nSkeleton of the files to edit (definitions with line numbers):\n${skeleton}\n\nWhich classes/functions must be changed or are needed to understand the change? At most ${MAX_LOCATIONS}. Use the names exactly as shown. Return ONLY JSON: {"locations": [{"file": "path", "symbol": "name"}]}` }],
          temperature: 0,
          jsonMode: true,
          jsonSchema: LOCATE_ELEMENTS_SCHEMA,
          maxTokens: 600,
          purpose: 'localize.elements',
          signal: opts.signal,
        },
        { role: 'planner' },
      );
      picked = (tryExtractJson<{ locations?: Array<{ file?: unknown; symbol?: unknown }> }>(r2.content)?.locations ?? []).map((l) => ({ file: String(l.file ?? ''), symbol: String(l.symbol ?? '') }));
    }

    // 3. the code of those elements
    const locations: Location[] = [];
    for (const p of files) {
      const f = index.file(p)!;
      const defs = [...f.defs].sort((a, b) => a.line - b.line);
      const mine = picked.filter((l) => l.file === p).map((l) => findDef(defs, l.symbol)).filter((d): d is SymbolDef => !!d);
      if (!defs.length || !mine.length) {
        // nothing more precise: the start of the file
        locations.push({ path: p, symbol: '(file)', start: 1, end: Math.min(f.lines, 80) });
        continue;
      }
      for (const d of mine) {
        const next = defs.find((x) => x.line > d.line && (!x.parent || x.parent !== d.name));
        locations.push({ path: p, symbol: d.name, start: d.line, end: Math.min(f.lines, next ? next.line - 1 : d.line + 60, d.line + 120) });
      }
    }
    const merged = mergeLocations(locations).slice(0, MAX_LOCATIONS);
    const body = merged
      .map((l) => {
        const lines = (index.read(l.path) ?? '').split('\n').slice(l.start - 1, l.end);
        return `## ${l.path} – ${l.symbol} (lines ${l.start}-${l.end})\n\`\`\`\n${lines.map((t, i) => `${String(l.start + i).padStart(5)}│ ${t}`).join('\n')}\n\`\`\``;
      })
      .join('\n\n');
    const context = body ? truncateTokens(`# LIKELY EDIT LOCATIONS (found by a localisation step – read the files before editing; other places may need changes too)\n${body}`, opts.budgetTokens) : '';
    opts.bus?.info(source, `localised: ${merged.map((l) => `${l.path}${l.symbol === '(file)' ? '' : `:${l.symbol}`}`).join(', ')}`);
    return { files, locations: merged, context, model: r1.model };
  } catch (e) {
    opts.bus?.warn(source, `localisation skipped: ${errorMessage(e)}`);
    return undefined;
  }
}

function findDef(defs: SymbolDef[], symbol: string): SymbolDef | undefined {
  const s = symbol.trim();
  const short = s.split(/[.:#]+/).pop() ?? s;
  return defs.find((d) => d.name === s) ?? defs.find((d) => d.name === short) ?? defs.find((d) => `${d.parent}.${d.name}` === s);
}

function mergeLocations(list: Location[]): Location[] {
  const out: Location[] = [];
  for (const l of [...list].sort((a, b) => a.path.localeCompare(b.path) || a.start - b.start)) {
    const prev = out[out.length - 1];
    if (prev && prev.path === l.path && l.start <= prev.end + 1) {
      prev.end = Math.max(prev.end, l.end);
      if (!prev.symbol.split(', ').includes(l.symbol)) prev.symbol = `${prev.symbol}, ${l.symbol}`;
    } else out.push({ ...l });
  }
  return out;
}
