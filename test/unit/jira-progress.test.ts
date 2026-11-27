import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatJiraLine, plainLine, RunNarrator, type JiraLineKind } from '../../src/integrations/jira-progress.js';
import type { KEvent } from '../../src/util/events.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('Jira progress lines', () => {
  it('draws a heading per issue, labels, steps and symbols – long text goes on in the next line', () => {
    const head = strip(formatJiraLine('YNAVYS-3883\tSilah Muhimmat > Atesleme Bilgileri ekranindaki SARP-35 bilgileri tablosunda islevsel imha uygulandi', 'issue', 60));
    assert.match(head, /^\n── YNAVYS-3883 ─+\nSilah Muhimmat > Atesleme Bilgileri ekranindaki SARP-35\nbilgileri tablosunda islevsel imha uygulandi$/);
    assert.match(strip(formatJiraLine('1 issue to do: A-1 (new)', 'pass', 60)), /^\n── Jira ─+\n {2}1 issue to do: A-1 \(new\)$/);
    assert.equal(strip(formatJiraLine('branch\tkurultay/A-1 → dev (new)', 'info', 60)), '  branch   kurultay/A-1 → dev (new)');
    assert.equal(strip(formatJiraLine('0:45\tstep 3 · reading Foo.java', 'step', 60)), '   0:45  step 3 · reading Foo.java');
    const warn = strip(formatJiraLine('no model answered for 120 minutes – paused; the next issue goes on, this one continues later', 'warn', 60));
    assert.deepEqual(warn.split('\n'), ['  ⚠ no model answered for 120 minutes – paused; the next', '    issue goes on, this one continues later']);
    for (const [k, sym] of [['ok', '✓'], ['fail', '✗'], ['change', '↻']] as Array<[JiraLineKind, string]>) assert.ok(strip(formatJiraLine('x', k, 60)).startsWith(`  ${sym} x`));
    assert.equal(formatJiraLine('as is', 'plain'), 'as is');
    // the log file: no colours, a marker per kind
    assert.equal(plainLine('A-1\tsummary', 'issue'), '== A-1  summary');
    assert.equal(plainLine('careful', 'warn'), '! careful');
    assert.equal(plainLine('broke', 'fail'), 'x broke');
    assert.equal(plainLine('repo\turl', 'info'), 'repo  url');
  });

  it('tells every agent step, folds an outage into one line and says what it waits for after a quiet minute', () => {
    let t = 1_000_000;
    const out: Array<[string, JiraLineKind]> = [];
    const n = new RunNarrator((text, kind) => out.push([text, kind]), () => t);
    const ev = (type: string, data: Record<string, unknown> = {}, extra: Partial<KEvent> = {}) => n.onEvent({ ts: t, type, data, ...extra });
    ev('worker.start', { model: 'Qwen3.8@main' });
    t += 12_000;
    ev('worker.tool', { tool: 'read_file', args: { path: 'src/ui/Panel.java' } });
    ev('worker.tool', { tool: 'todo_write', args: {} });
    ev('log.warn', {}, { message: 'no build/test commands: the code will not be compiled or tested (kurultay init…)' });
    ev('llm.request', {}, { source: 'Qwen3.8@main' });
    t += 61_000;
    n.heartbeat();
    t += 1000;
    n.heartbeat(); // not quiet long enough again
    // the outage: many router warnings, one line; the answer after it is told
    for (const m of ['All models are unreachable; retrying in 5 s', 'Qwen3.8@main circuit breaker open (30 s)', 'no backup model left; retrying the models that failed earlier (x)']) ev('log.warn', {}, { message: m });
    ev('llm.error', {}, { source: 'Qwen3.8@main' });
    t += 90_000;
    n.heartbeat();
    ev('llm.response', {}, { source: 'gemma@main' });
    ev('worker.failover', { from: 'Qwen3.8@main', to: 'gemma@main' });
    ev('log.warn', {}, { message: 'Qwen3.8@main stopped answering (timeout); continuing on gemma@main' });
    ev('worker.inbox', { messages: 1 });
    ev('run.verify', { ok: false, skipped: false });
    ev('run.verify', { ok: true, skipped: false });
    ev('run.verify', { skipped: true });
    ev('worker.end', { status: 'done', files: 2 });
    ev('run.merge', {});
    ev('log.warn', {}, { message: 'something else\nmore' });
    assert.deepEqual(out, [
      ['0:00\tthe agent starts on Qwen3.8', 'step'],
      ['0:12\tstep 1 · reading Panel.java', 'step'],
      ['0:12\tstep 2 · updating its todo list', 'step'],
      ['no build/test commands – the changes are not compiled or tested', 'warn'],
      ['1:13\tstill working · waiting for Qwen3.8 for 1m 01s', 'step'],
      ['no model answers – Kurultay keeps trying', 'warn'],
      ['2:44\tno model answers for 1m 30s – still trying', 'step'],
      ['gemma answers again after 1m 30s', 'ok'],
      ['Qwen3.8 stopped answering – continuing on gemma', 'warn'],
      ['the agent read the change of the issue and follows it from now on', 'change'],
      ['build/tests failed – the agent gets the errors', 'warn'],
      ['2:44\tbuild/tests: passed', 'step'],
      ['2:44\tthe agent is done – 2 files changed', 'step'],
      ['2:44\tchanges written to the work tree', 'step'],
      ['something else', 'warn'],
    ]);
    // a quiet minute without a request open
    t += 60_000;
    n.heartbeat();
    assert.deepEqual(out.at(-1), ['3:44\tstill working', 'step']);
    ev('worker.end', { status: 'failed', files: 0 });
    assert.deepEqual(out.at(-1), ['3:44\tthe agent stopped (failed)', 'step']);
  });
});
