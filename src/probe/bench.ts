import vm from 'node:vm';
import { applyReplacement, parseSearchReplace } from '../agent/edits.js';

/**
 * Tiny, language-neutral coding benchmark evaluated offline in a node:vm sandbox.
 * Kept small on purpose: it ranks models relative to each other, it is not SWE-bench.
 */
export interface CodingTask {
  id: string;
  fn: string;
  prompt: string;
  tests: Array<[unknown[], unknown]>;
}

export const CODING_TASKS: CodingTask[] = [
  {
    id: 'roman',
    fn: 'toRoman',
    prompt: 'Write a JavaScript function `toRoman(n)` that converts an integer 1..3999 to a Roman numeral string.',
    tests: [
      [[1], 'I'],
      [[4], 'IV'],
      [[9], 'IX'],
      [[58], 'LVIII'],
      [[1994], 'MCMXCIV'],
      [[3999], 'MMMCMXCIX'],
    ],
  },
  {
    id: 'intervals',
    fn: 'mergeIntervals',
    prompt:
      'Write a JavaScript function `mergeIntervals(list)` that takes an array of [start, end] integer pairs (unsorted) and returns the merged, sorted list of overlapping intervals. Touching intervals like [1,2],[2,3] merge.',
    tests: [
      [[[[1, 3], [2, 6], [8, 10], [15, 18]]], [[1, 6], [8, 10], [15, 18]]],
      [[[[1, 4], [4, 5]]], [[1, 5]]],
      [[[[5, 7], [1, 2]]], [[1, 2], [5, 7]]],
      [[[]], []],
    ],
  },
  {
    id: 'brackets',
    fn: 'isBalanced',
    prompt: 'Write a JavaScript function `isBalanced(s)` that returns true if every (), [] and {} in string s is correctly balanced and nested; other characters are ignored.',
    tests: [
      [['([]{})'], true],
      [['([)]'], false],
      [['a(b[c]{d}e)f'], true],
      [['(('], false],
      [[''], true],
      [['}{'], false],
    ],
  },
  {
    id: 'duration',
    fn: 'parseDuration',
    prompt:
      'Write a JavaScript function `parseDuration(s)` that parses strings like "1h30m", "45s", "2h", "1h2m3s", "90m" into total seconds (number). Units: h, m, s. Return NaN for invalid input such as "" or "5x".',
    tests: [
      [['1h30m'], 5400],
      [['45s'], 45],
      [['1h2m3s'], 3723],
      [['90m'], 5400],
      [[''], NaN],
      [['5x'], NaN],
    ],
  },
  {
    id: 'crc',
    fn: 'crc8',
    prompt:
      'Write a JavaScript function `crc8(bytes)` computing CRC-8 (polynomial 0x07, init 0x00, no reflection, no final xor) over an array of byte values and returning a number 0..255.',
    tests: [
      [[[0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]], 0xf4],
      [[[]], 0],
      [[[0x00]], 0],
      [[[0xff]], 0xf3],
    ],
  },
  {
    id: 'ringbuffer',
    fn: 'makeRing',
    prompt:
      'Write a JavaScript function `makeRing(capacity)` returning an object with push(x), toArray() and size(). When full, push overwrites the oldest element. toArray returns oldest→newest.',
    tests: [
      [[2], 'custom'],
    ],
  },
];

function extractCode(text: string): string {
  const fence = [...text.matchAll(/```(?:javascript|js|typescript|ts)?\s*\n([\s\S]*?)```/g)];
  if (fence.length) return fence.map((m) => m[1]).join('\n');
  return text;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Evaluate model output for a task. Returns fraction of tests passed. */
export function evaluateCodingAnswer(task: CodingTask, answer: string): number {
  let code = extractCode(answer)
    .replace(/^\s*export\s+(default\s+)?/gm, '')
    .replace(/^\s*import .*$/gm, '');
  // strip TypeScript type annotations in the simplest cases
  code = code.replace(/\)\s*:\s*[\w<>[\]|, ]+\s*\{/g, ') {').replace(/(\w)\s*:\s*(number|string|boolean|any|number\[\]|unknown)(\[\])?(?=[,)=])/g, '$1');
  const ctx = vm.createContext({});
  try {
    new vm.Script(`${code}\n;globalThis.__fn = typeof ${task.fn} !== 'undefined' ? ${task.fn} : undefined;`).runInContext(ctx, { timeout: 1000 });
  } catch {
    return 0;
  }
  const fn = (ctx as { __fn?: unknown }).__fn;
  if (typeof fn !== 'function') return 0;
  if (task.id === 'ringbuffer') {
    try {
      const r = vm.runInContext(
        `(() => { const r = __fn(3); r.push(1); r.push(2); const a = JSON.stringify(r.toArray()) === '[1,2]' && r.size() === 2;
          r.push(3); r.push(4); const b = JSON.stringify(r.toArray()) === '[2,3,4]' && r.size() === 3;
          r.push(5); const c = JSON.stringify(r.toArray()) === '[3,4,5]'; return [a,b,c].filter(Boolean).length / 3; })()`,
        ctx,
        { timeout: 1000 },
      );
      return typeof r === 'number' ? r : 0;
    } catch {
      return 0;
    }
  }
  let pass = 0;
  for (const [args, expected] of task.tests) {
    try {
      (ctx as Record<string, unknown>).__args = JSON.parse(JSON.stringify(args));
      const got = vm.runInContext('__fn(...__args)', ctx, { timeout: 1000 });
      if (deepEqual(got, expected)) pass++;
    } catch {
      /* failed test */
    }
  }
  return pass / task.tests.length;
}

/** Edit-format tasks: the model must answer with SEARCH/REPLACE blocks. */
export interface EditTask {
  id: string;
  path: string;
  original: string;
  instruction: string;
  check: (result: string) => boolean;
}

export const EDIT_TASKS: EditTask[] = [
  {
    id: 'rename',
    path: 'src/sensor.c',
    original: `#include "sensor.h"

static int read_raw(int ch) {
    return adc_read(ch);
}

int sensor_value(int ch) {
    int raw = read_raw(ch);
    return raw * 3300 / 4096;
}
`,
    instruction: 'Rename the function read_raw to sensor_read_raw everywhere in this file.',
    check: (r) => !/\bread_raw\b/.test(r.replace(/sensor_read_raw/g, '')) && (r.match(/sensor_read_raw/g) ?? []).length === 2,
  },
  {
    id: 'guard',
    path: 'src/queue.cpp',
    original: `#include "queue.h"

bool Queue::pop(Item &out) {
    out = items_[head_];
    head_ = (head_ + 1) % capacity_;
    --count_;
    return true;
}
`,
    instruction: 'In Queue::pop, return false immediately (before touching any member) when count_ == 0.',
    check: (r) => /if\s*\(\s*count_\s*==\s*0\s*\)/.test(r) && r.indexOf('count_ == 0') < r.indexOf('out = items_') && r.includes('return false'),
  },
  {
    id: 'add-method',
    path: 'src/Stack.java',
    original: `public class Stack {
    private final java.util.ArrayList<Integer> data = new java.util.ArrayList<>();

    public void push(int v) {
        data.add(v);
    }
}
`,
    instruction: 'Add a public method `int size()` that returns the number of elements, placed after push.',
    check: (r) => /public\s+int\s+size\s*\(\s*\)/.test(r) && r.indexOf('size()') > r.indexOf('push(') && /data\.size\(\)/.test(r) && (r.match(/\{/g) ?? []).length === (r.match(/\}/g) ?? []).length,
  },
];

export function editTaskPrompt(t: EditTask): string {
  return `You are editing a file. Respond ONLY with one or more SEARCH/REPLACE blocks in exactly this format:

${t.path}
<<<<<<< SEARCH
(exact existing lines to find)
=======
(replacement lines)
>>>>>>> REPLACE

File ${t.path}:
\`\`\`
${t.original}\`\`\`

Task: ${t.instruction}`;
}

export function evaluateEditAnswer(t: EditTask, answer: string): number {
  try {
    const blocks = parseSearchReplace(answer, t.path);
    if (!blocks.length) return 0;
    let content = t.original;
    for (const b of blocks) content = applyReplacement(content, b.search, b.replace, { path: t.path });
    return t.check(content) ? 1 : 0.25;
  } catch {
    return 0;
  }
}
