import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { presetBody, presetFor } from '../../src/llm/presets.js';
import { withNoThink } from '../../src/llm/router.js';
import { bestEditFormat } from '../../src/probe/probe.js';
import { evaluateToolEdit, evaluateWholeAnswer, EDIT_TASKS, lastCodeBlock } from '../../src/probe/bench.js';
import { caps, config, routerFor } from '../helpers.js';

describe('sampling presets', () => {
  it('maps model ids to the publishers\' recommended settings', () => {
    assert.equal(presetFor('Qwen3-Coder-30B-A3B-Instruct')!.family, 'qwen3-coder');
    assert.equal(presetFor('qwen3-coder:30b')!.repetition_penalty, 1.05);
    assert.equal(presetFor('Qwen3-235B-A22B-Thinking-2507')!.temperature, 0.6);
    assert.equal(presetFor('Qwen3-30B-A3B-Instruct-2507')!.family, 'qwen3-instruct');
    assert.equal(presetFor('qwen3:14b')!.hybridThinking, true);
    assert.equal(presetFor('devstral-small-2507')!.temperature, 0.15);
    assert.equal(presetFor('gpt-oss-120b')!.top_p, 1);
    assert.equal(presetFor('qwen2.5-coder:32b'), undefined, 'no published preset → server defaults');
    assert.equal(presetFor('qwen3.5-27b'), undefined);
    assert.deepEqual(presetBody(presetFor('qwen3-coder')!), { top_p: 0.8, top_k: 20, repetition_penalty: 1.05, repeat_penalty: 1.05 });
  });

  it('router: preset for agentic calls, config wins, /no_think for hybrid Qwen3', () => {
    const cfg = config({ endpoints: [{ name: 'e', baseUrl: 'http://e/v1' }], models: { 'devstral@e': { temperature: 0.4 }, 'qwen3:8b@e': { thinking: true } } });
    const r = routerFor(cfg, [caps('qwen3-coder-30b', 'e'), caps('devstral', 'e'), caps('qwen3:14b', 'e'), caps('qwen3:8b', 'e'), caps('llama3', 'e')]);
    const get = (k: string) => r.get(k)!;
    assert.deepEqual(r.samplingFor(get('qwen3-coder-30b@e'), { messages: [], agentic: true, temperature: 0.2 }), { temperature: 0.7, body: presetBody(presetFor('qwen3-coder')!), noThink: false });
    assert.equal(r.samplingFor(get('qwen3-coder-30b@e'), { messages: [], temperature: 0 }).temperature, 0, 'structured calls keep their temperature');
    assert.equal(r.samplingFor(get('devstral@e'), { messages: [], agentic: true }).temperature, 0.4, 'configured temperature wins');
    assert.equal(r.samplingFor(get('qwen3:14b@e'), { messages: [] }).noThink, true);
    assert.equal(r.samplingFor(get('qwen3:8b@e'), { messages: [] }).noThink, false, 'thinking: true keeps reasoning on');
    assert.deepEqual(r.samplingFor(get('llama3@e'), { messages: [], agentic: true, temperature: 0.2 }), { temperature: 0.2, body: undefined, noThink: false });
    const off = routerFor(config({ endpoints: [{ name: 'e', baseUrl: 'http://e/v1' }], llm: { samplingPresets: false } }), [caps('qwen3-coder', 'e')]);
    assert.equal(off.get('qwen3-coder@e')!.preset, undefined);
  });

  it('adds the /no_think switch once', () => {
    assert.deepEqual(withNoThink([{ role: 'user', content: 'hi' }]), [{ role: 'system', content: '/no_think' }, { role: 'user', content: 'hi' }]);
    const once = withNoThink([{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }]);
    assert.equal(once[0].content, 'S\n/no_think');
    assert.equal(withNoThink(once), once);
  });
});

describe('edit formats', () => {
  it('scores whole-file answers and edit_file calls, and picks the best format', () => {
    const t = EDIT_TASKS[1]; // queue guard
    const fixed = t.original.replace('    out = items_[head_];', '    if (count_ == 0) {\n        return false;\n    }\n    out = items_[head_];');
    assert.equal(evaluateWholeAnswer(t, '```cpp\n' + fixed + '```'), 1);
    assert.equal(evaluateWholeAnswer(t, '```cpp\nif (count_ == 0) return false;\n```'), 0, 'a snippet is not a whole file');
    assert.equal(evaluateWholeAnswer(t, ''), 0);
    assert.equal(lastCodeBlock('no fences'), 'no fences');
    assert.equal(evaluateToolEdit(t, [{ name: 'edit_file', arguments: { old_text: '    out = items_[head_];', new_text: '    if (count_ == 0) {\n        return false;\n    }\n    out = items_[head_];' } }]), 1);
    assert.equal(evaluateToolEdit(t, [{ name: 'edit_file', arguments: { old_text: 'not there', new_text: 'x' } }]), 0);
    assert.equal(evaluateToolEdit(t, [{ name: 'edit_file', arguments: { old_text: 1 } }]), 0);
    assert.equal(evaluateToolEdit(t, [{ name: 'read_file', arguments: {} }]), 0);
    assert.equal(bestEditFormat({ tool: 1, search_replace: 1, whole: 1 }), 'tool', 'ties go to the cheapest format');
    assert.equal(bestEditFormat({ tool: 0, search_replace: 0.25, whole: 1 }), 'whole');
    assert.equal(bestEditFormat({ search_replace: 0.5, whole: 0.5 }), 'search_replace');
  });
});

describe('quick structured answers: thinking off for plans and localisation', () => {
  it('sends the switch only where it is safe and useful', () => {
    const cfg = config({ endpoints: [{ name: 'e', baseUrl: 'http://e/v1' }], models: { 'qwen3-32b-keep@e': { thinking: true } } });
    const r = routerFor(cfg, [caps('Qwen3.8-Flash-Next-FP8', 'e'), caps('gpt-oss-120b', 'e'), caps('llama3', 'e'), caps('mystery', 'e', { thinking: true }), caps('qwen3-32b-keep', 'e'), caps('qwen3:14b', 'e')]);
    const g = (k: string) => r.get(k)!;
    assert.deepEqual(r.quickThinking(g('Qwen3.8-Flash-Next-FP8@e'), { messages: [], purpose: 'plan.draft' }), { chat_template_kwargs: { enable_thinking: false } });
    assert.deepEqual(r.quickThinking(g('mystery@e'), { messages: [], purpose: 'localize.files' }), { chat_template_kwargs: { enable_thinking: false } }, 'probe saw reasoning output');
    assert.deepEqual(r.quickThinking(g('gpt-oss-120b@e'), { messages: [], purpose: 'summary.file' }), { reasoning_effort: 'low' });
    assert.equal(r.quickThinking(g('llama3@e'), { messages: [], purpose: 'plan.draft' }), undefined, 'not a reasoning model');
    assert.equal(r.quickThinking(g('Qwen3.8-Flash-Next-FP8@e'), { messages: [], purpose: 'council.review' }), undefined, 'reviews keep thinking');
    assert.equal(r.quickThinking(g('Qwen3.8-Flash-Next-FP8@e'), { messages: [], purpose: 'worker:T1-1', agentic: true }), undefined, 'coding keeps thinking');
    assert.equal(r.quickThinking(g('qwen3-32b-keep@e'), { messages: [], purpose: 'plan.draft' }), undefined, 'thinking: true in the config');
    assert.deepEqual(r.samplingFor(g('qwen3:14b@e'), { messages: [], purpose: 'plan.judge' }).body, { chat_template_kwargs: { enable_thinking: false } });
    const off = routerFor(config({ endpoints: [{ name: 'e', baseUrl: 'http://e/v1' }], llm: { quickStructured: false } }), [caps('qwen3-coder', 'e')]);
    assert.equal(off.quickThinking(off.get('qwen3-coder@e')!, { messages: [], purpose: 'plan.draft' }), undefined);
  });

  it('a server that rejects the switch is asked again without it, once', async () => {
    const { startMockServer } = await import('../../src/mock/server.js');
    const s = await startMockServer([{ id: 'qwen3-32b', quality: 'good', tools: true, ctx: 32768, rejectTemplateKwargs: true, handler: () => ({ content: '{"files":[]}' }) }]);
    try {
      const r = routerFor(config({ endpoints: [{ name: 'e', baseUrl: s.url }] }), [caps('qwen3-32b', 'e')]);
      const res = await r.chat({ messages: [{ role: 'user', content: 'x' }], purpose: 'localize.files', maxTokens: 50 });
      assert.equal(res.content, '{"files":[]}');
      assert.equal(r.get('qwen3-32b@e')!.thinkOffRejected, true);
      await r.chat({ messages: [{ role: 'user', content: 'y' }], purpose: 'plan.draft', maxTokens: 50 });
      assert.equal(s.log.filter((l) => 'chat_template_kwargs' in l.body).length, 1, 'not sent again');
    } finally {
      await s.close();
    }
  });
});

describe('helpers do not stand in for excluded models', () => {
  it('rolesOnly: reviewers exclude the authors without falling back to the helper', () => {
    const cfg = config({ endpoints: [{ name: 'e', baseUrl: 'http://e/v1' }], models: { 'tiny@e': { roles: ['fast', 'summarizer'], rolesOnly: true } } });
    const r = routerFor(cfg, [caps('big', 'e'), caps('mid', 'e'), caps('tiny', 'e')]);
    assert.deepEqual(r.pick('reviewer', 3, ['big@e', 'mid@e']).map((h) => h.caps.key), []);
    assert.deepEqual(r.pick('reviewer', 3, ['big@e']).map((h) => h.caps.key), ['mid@e']);
    const solo = routerFor(cfg, [caps('tiny', 'e')]);
    assert.deepEqual(solo.pick('reviewer', 1).map((h) => h.caps.key), ['tiny@e'], 'the only model left still works');
  });
});
