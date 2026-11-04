import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ProjectIndex } from '../../src/index/project-index.js';
import { startMockServer, type MockServerHandle } from '../../src/mock/server.js';
import { localize } from '../../src/orchestrator/localize.js';
import { caps, config, lastUser, recordingBus, routerFor, tmpProject } from '../helpers.js';

const servers: MockServerHandle[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

const UART = `#include "uart.h"

int uart_init(int baud) {
    if (baud <= 0) return -1;
    return 0;
}

int uart_send(const char *buf, int len) {
    for (int i = 0; i < len; i++) put(buf[i]);
    return len;
}

int uart_close(void) {
    return 0;
}
`;

async function setup(answers: { files?: string; elements?: string }) {
  const prompts: string[] = [];
  const s = await startMockServer([
    {
      id: 'loc',
      quality: 'good',
      tools: true,
      ctx: 65536,
      handler: (q) => {
        const u = lastUser(q.messages);
        prompts.push(u);
        if (/Which files must be EDITED/.test(u)) return { content: answers.files ?? '{"files":["src/uart.c","nope.c"]}' };
        if (/Skeleton of the files to edit/.test(u)) return { content: answers.elements ?? '{"locations":[{"file":"src/uart.c","symbol":"uart_send"},{"file":"src/uart.c","symbol":"uart_close"}]}' };
        return undefined;
      },
    },
  ]);
  servers.push(s);
  const files: Record<string, string> = { 'src/uart.c': UART, 'README.md': '# demo\n' };
  for (let i = 0; i < 8; i++) files[`src/other${i}.c`] = `int other${i}(void) { return ${i}; }\n`;
  const root = tmpProject(files);
  const index = new ProjectIndex(root, join(root, '.kurultay'));
  index.build();
  const bus = recordingBus();
  const router = routerFor(config({ endpoints: [{ name: 'e', baseUrl: s.url }] }), [caps('loc', 'e')], bus);
  return { index, router, bus, prompts };
}

describe('localisation', () => {
  it('narrows files → functions → code with line numbers', async () => {
    const { index, router, bus, prompts } = await setup({});
    const loc = (await localize(index, router, 'uart_send must not write past len', { files: ['src/uart.c'] }, { budgetTokens: 2000, bus, source: 'T1' }))!;
    assert.deepEqual(loc.files, ['src/uart.c'], 'unknown paths from the model are dropped');
    assert.deepEqual(loc.locations.map((l) => [l.symbol, l.start]), [['uart_send, uart_close', 8]], 'adjacent functions are merged');
    assert.match(loc.context, /LIKELY EDIT LOCATIONS/);
    assert.match(loc.context, /\s9│ {5}for \(int i = 0; i < len; i\+\+\)/);
    assert.doesNotMatch(loc.context, /uart_init\(int baud\) \{/, 'unrelated functions are left out');
    assert.match(prompts[0], /- src\/uart\.c .*\[uart_init, uart_send, uart_close\]/);
    assert.match(prompts[1], /L8: int uart_send\(const char \*buf, int len\)/);
    assert.ok(bus.ofType('log.info').some((e) => /localised: src\/uart\.c:uart_send, uart_close/.test(e.message ?? '')));
  });

  it('falls back to the start of a file and gives up cleanly', async () => {
    const a = await setup({ elements: '{"locations":[{"file":"src/uart.c","symbol":"does_not_exist"}]}' });
    const loc = (await localize(a.index, a.router, 'change the uart driver', {}, { budgetTokens: 2000 }))!;
    assert.deepEqual(loc.locations.map((l) => [l.symbol, l.start, l.end]), [['(file)', 1, 16]]);
    const b = await setup({ files: '{"files":["ghost.c"]}' });
    assert.equal(await localize(b.index, b.router, 'uart', {}, { budgetTokens: 2000 }), undefined);
    const c = await setup({ files: 'not json at all' });
    assert.equal(await localize(c.index, c.router, 'uart', {}, { budgetTokens: 2000 }), undefined);
    assert.equal(await localize(c.index, c.router, 'zzzqqq', {}, { budgetTokens: 2000 }), undefined, 'no candidate files');
    const d = await setup({});
    assert.equal(await localize(d.index, d.router, 'uart_send', { files: ['src/uart.c'] }, { budgetTokens: 2000, bus: d.bus, signal: AbortSignal.abort() }), undefined);
    assert.ok(d.bus.ofType('log.warn').some((e) => /localisation skipped/.test(e.message ?? '')));
  });
});
