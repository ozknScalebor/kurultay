import { tryExtractJson } from '../util/text.js';
import { parseSearchReplace } from './edits.js';

/**
 * Prompt-based tool calling for local models without (reliable) native
 * function calling. Accepts the formats open models actually produce:
 *   <tool_call>{"name": "...", "arguments": {...}}</tool_call>      (Hermes / Qwen2.5)
 *   <tool_call><function=name><parameter=k>v</parameter></function></tool_call> (Qwen3-Coder)
 *   ```json {"name": "...", "arguments": {...}} ```                  (generic)
 *   SEARCH/REPLACE blocks                                            (Aider style edits)
 */

export interface ParsedCall {
  name: string;
  arguments: Record<string, unknown>;
}

function normalize(obj: unknown): ParsedCall | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  const fn = (o.function && typeof o.function === 'object' ? (o.function as Record<string, unknown>) : undefined) ?? o;
  const name = (fn.name ?? o.tool ?? o.tool_name) as unknown;
  if (typeof name !== 'string' || !name) return undefined;
  let args = (fn.arguments ?? fn.parameters ?? o.args ?? o.input ?? {}) as unknown;
  if (typeof args === 'string') args = tryExtractJson(args) ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  return { name, arguments: args as Record<string, unknown> };
}

function parseXmlFunction(body: string): ParsedCall | undefined {
  const m = body.match(/<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/);
  if (!m) return undefined;
  const args: Record<string, unknown> = {};
  for (const p of m[2].matchAll(/<parameter=([\w.-]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) {
    const raw = p[2];
    const trimmed = raw.trim();
    if (/^(true|false)$/.test(trimmed)) args[p[1]] = trimmed === 'true';
    else if (/^-?\d+$/.test(trimmed)) args[p[1]] = Number(trimmed);
    else if (/^[[{]/.test(trimmed)) args[p[1]] = tryExtractJson(trimmed) ?? raw;
    else args[p[1]] = raw;
  }
  return { name: m[1], arguments: args };
}

export function parseTextToolCalls(text: string): ParsedCall[] {
  const calls: ParsedCall[] = [];
  const tagged = [...text.matchAll(/<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g)];
  for (const t of tagged) {
    const body = t[1].trim();
    if (!body) continue;
    const xml = parseXmlFunction(body);
    if (xml) {
      calls.push(xml);
      continue;
    }
    const n = normalize(tryExtractJson(body));
    if (n) calls.push(n);
  }
  if (!tagged.length) {
    for (const m of text.matchAll(/<function=[\w.-]+>[\s\S]*?(?:<\/function>|$)/g)) {
      const xml = parseXmlFunction(m[0]);
      if (xml) calls.push(xml);
    }
  }
  if (!calls.length) {
    for (const f of text.matchAll(/```(?:json|tool_call|tool)?\s*\n([\s\S]*?)```/g)) {
      const parsed = tryExtractJson(f[1]);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) {
        const n = normalize(item);
        if (n && n.name) calls.push(n);
      }
    }
  }
  // SEARCH/REPLACE edits are always honoured, even alongside other calls
  if (/^<{5,9} ?SEARCH\s*$/m.test(text)) {
    try {
      for (const b of parseSearchReplace(text)) {
        if (b.search.trim() === '') calls.push({ name: 'write_file', arguments: { path: b.path, content: b.replace } });
        else calls.push({ name: 'edit_file', arguments: { path: b.path, old_text: b.search, new_text: b.replace } });
      }
    } catch {
      /* malformed block – the model will get feedback that nothing happened */
    }
  }
  return calls;
}

export function textToolInstructions(catalogue: string): string {
  return `## Araç kullanımı
You can call tools by writing one or more blocks EXACTLY like this (JSON inside the tags):
<tool_call>
{"name": "read_file", "arguments": {"path": "src/main.c"}}
</tool_call>
After your tool calls, STOP and wait – results arrive in the next message inside <tool_result> tags.
To edit files you may also use SEARCH/REPLACE blocks:
path/to/file.ext
<<<<<<< SEARCH
exact existing lines
=======
new lines
>>>>>>> REPLACE
When the task is complete call the finish tool.

Available tools:
${catalogue}`;
}
