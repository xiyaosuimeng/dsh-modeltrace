import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGate } from '../lib/gate.js';
import { loadBank, matchBankModel } from '../lib/verify.js';
import { resolveConfig } from '../lib/config.js';
const text = readFileSync(new URL('./fixtures/reference-sample.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map(JSON.parse).find(r => r.model_id === 'gpt-5.4').text;
function fixture(options = {}, deferred = false) {
  const handlers = new Map(), effects = [], releases = [], calls = [], injected = [];
  const selection = { provider: 'mock', model: 'gpt-5.4' };
  const ctx = { get: n => n === 'llm' ? llm : n === 'agentDefaultModel' ? { currentSelection: () => selection } : undefined,
    on: (n, fn) => handlers.set(n, fn), effect: fn => effects.push(fn()), logger: { warn() {} } };
  const llm = { async *stream(request) {
    calls.push(request);
    if (deferred) await new Promise(resolve => releases.push(resolve));
    yield { type: 'text-delta', index: 0, text }; yield { type: 'finish', reason: { kind: 'stop' } };
  }};
  const agent = { id: 'test-session', options: {}, session: { id: 'test-session' }, inject: m => injected.push(m) };
  const config = resolveConfig({ rounds: 1, countMin: 250, countMax: 250, ...options });
  const gate = createGate(ctx, config); gate.attach();
  const step = (id, kind = 'user') => handlers.get('agent/pre-step')({ agent,
    messages: [{ id, role: 'user', source: { kind }, content: [{ type: 'text', text: 'hello' }] }],
    signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }));
  const settle = async () => { while (gate.stateFor(agent).running) await gate.stateFor(agent).running; };
  const close = () => effects.forEach(fn => fn?.());
  return { agent, gate, calls, releases, injected, selection, config, step, settle, close, handlers };
}
for (const [options, expected] of [
  [{}, 1], [{ intervalMessages: '2' }, 3], [{ intervalMessages: '0' }, 5],
  [{ intervalSeconds: '0' }, 5], [{ intervalMessages: '2', intervalSeconds: '0' }, 3],
  [{ intervalMessages: '0', intervalSeconds: '999' }, 5], [{ intervalSeconds: '999' }, 1]
]) {
  const f = fixture(options);
  try {
    for (let i = 1; i <= 5; i++) { await f.step('m' + i); await f.settle(); }
    assert.equal(f.calls.length, expected, JSON.stringify(options));
    await f.step('m5'); await f.step('tool-context', 'plugin:other'); await f.settle();
    assert.equal(f.calls.length, expected, 'duplicate IDs and plugin injections do not count');
  } finally { f.close(); }
}
console.log('PASS interval matrix, precedence, blank vs zero, message identity/source');
{
  const f = fixture({ intervalMessages: '0' }, true);
  try {
    await f.step('m1');
    assert.equal(f.gate.snapshot(f.agent).running, true);
    assert.equal(f.injected.length, 0);
    await f.step('m2'); await f.step('m3');
    assert.equal(f.calls.length, 1, 'one run at a time');
    for (let i = 0; i < 3; i++) {
      const running = f.gate.stateFor(f.agent).running;
      f.releases.shift()(); await running; await Promise.resolve();
    }
    assert.equal(f.calls.length, 3, 'zero queues each message while background run is busy');
    assert.equal(f.injected.length, 3);
    assert.equal(f.injected[0].source.kind, 'plugin:dsh-modeltrace');
    assert.ok(f.injected[0].id);
  } finally { f.close(); }
}
console.log('PASS main pre-step returns with unresolved probe; busy-message checks queued; logged injection');
{
  const f = fixture({}, true);
  await f.step('m1');
  const running = f.gate.stateFor(f.agent).running;
  f.selection.model = 'not-in-bank'; await f.step('m2');
  f.releases.shift()(); await running;
  assert.equal(f.injected.length, 0); assert.equal(f.gate.snapshot(f.agent).status, 'idle');
  assert.equal(f.calls[0].signal.aborted, true);
  f.close();
}
console.log('PASS changed selection cancels and rejects stale completion; outside bank silent');
{
  const f = fixture({ intervalSeconds: '0.01' });
  await f.step('m1'); await f.settle();
  // Wait for the actual scheduled recheck, without relying on an arbitrary sleep.
  const deadline = AbortSignal.timeout(2000);
  await new Promise((resolve, reject) => {
    const start = f.gate.ensureVerified;
    const timer = setInterval(() => { if (f.calls.length >= 2) { clearInterval(timer); resolve(); } }, 5);
    deadline.addEventListener('abort', () => { clearInterval(timer); reject(new Error('timer recheck missing')); }, { once: true });
  });
  f.close(); const n = f.calls.length;
  assert.ok(n >= 2); assert.equal(f.gate.snapshot(f.agent).running, false);
}
console.log('PASS positive seconds use timer without another user message; disposal cancels');
for (const id of ['modeltrace-probe-aux', 'user-session']) {
  const f = fixture({ enabled: id === 'modeltrace-probe-aux' }); f.agent.id = id;
  await f.step('m1'); await f.settle(); assert.equal(f.calls.length, 0); f.close();
}
console.log('PASS auxiliary session and master-switch skip');
{
  const bank = loadBank(resolveConfig());
  assert.equal(matchBankModel('gpt', {}, bank), null);
  assert.equal(matchBankModel('gpt-5.4-mini', {}, bank), null);
  assert.equal(matchBankModel('gpt-5.4-20270101', {}, bank), null);
  assert.equal(matchBankModel('openai/gpt-5.4', {}, bank), 'gpt-5.4');
  assert.equal(matchBankModel('proxy-model', { 'proxy-model': 'gpt-5.4' }, bank), 'gpt-5.4');
  const f = fixture({ intervalSeconds: '9999999999' });
  await f.step('m1'); await f.settle();
  assert.equal(f.gate.stateFor(f.agent).timer._idleTimeout, 2147483647);
  f.close();
}
console.log('PASS outside-bank variants require explicit aliases; long timers avoid overflow');
