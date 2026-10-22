import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import SessionStore from '@deepseek-ai/dsh-session';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt, { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt';
import ToolRegistry from '@deepseek-ai/dsh-tools';
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry';
import { composeProbe, planRounds } from '../lib/prompts.js';
import { runSessionProbe } from '../lib/session-probe.js';

const plan = planRounds({ rounds: 1, languages: ['en'], seed: 7 })[0];
const options = { provider: 'keyless', model: 'target-model', reasoningEffort: 'high', plan, maxTokens: 2048, timeoutMs: 1000 };
const reply = '[27,142,8,315,67,221,43,183]';

async function fixture(t, { minimal = false, behavior } = {}) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  for (const [plugin, config] of [
    [Loader, { baseUrl: import.meta.url }],
    [SessionStore], [AgentRegistry], [SessionProjectionRegistry], [SystemPrompt, { personaPrefix: 'GLOBAL_PERSONA' }],
    [ToolRegistry], [LlmRuntime], [AgentPresetRegistry, { default: 'default' }], [AgentLoop],
  ]) {
    const fiber = ctx.plugin(plugin, config);
    await fiber.await();
    assert.equal(fiber.state, 2, `${plugin.name} is active`);
  }
  if (minimal) await ctx.effect(() => ctx.agentPresets.register({ id: 'minimal', plugins: [] }));
  await ctx.loader.await();
  // Real global host contributions must not leak into the probe's request.
  ctx.systemPrompt.context({ name: 'host-skills', order: 0, text: 'SKILLS_AND_AGENTS_GUIDANCE' });
  let toolCalls = 0;
  ctx.tools.register({
    name: 'host_tool', description: 'Global fixture tool', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (value) => value },
    execute: async () => { toolCalls++; return 'ran'; },
  });
  ctx.on('agent/request', async (_payload, next) => ({ ...await next(), provider: 'wrong', model: 'wrong', reasoningEffort: 'low', maxTokens: 1 }));
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next();
    return { ...assembled, sections: [{ name: 'injected', text: 'INJECTED_PROMPT' }], contexts: [{ name: 'injected', text: 'INJECTED_CONTEXT' }], tools: [{ name: 'host_tool', parameters: {} }] };
  });
  ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next();
    return decision.kind === 'reject' ? decision : { ...decision, messages: [...decision.messages, createUserMessage({ content: [{ type: 'text', text: 'GLOBAL_HISTORY_INJECTION' }] })] };
  });
  const requests = [];
  const created = [];
  const disposed = [];
  const events = [];
  ctx.on('agent/created', ({ agent }) => { created.push(agent); });
  ctx.on('agent/disposed', ({ agent }) => { disposed.push(agent.id); });
  ctx.on('session/event', (session, event) => events.push({ sessionId: session.id, event }));
  class KeylessAdapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, reasoning: { efforts: [{ id: 'high', name: 'High' }] } };
    }
    async *stream(request) {
      requests.push(request);
      if (behavior) yield* behavior(request);
      else {
        yield { type: 'text-delta', index: 0, text: reply };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  }
  ctx.llm.registerAdapter(['keyless'], new KeylessAdapter());
  const snapshot = async () => ({
    effects: JSON.stringify(ctx.fiber.getEffects()),
    agents: ctx.agents.list().map((agent) => agent.id),
    sessions: ctx.sessions.list().map((session) => session.id),
    presets: await ctx.agentPresets.list(),
    policy: ctx.agentPresets.policy(),
  });
  return { ctx, requests, created, disposed, events, snapshot, toolCalls: () => toolCalls };
}

function assertRequest(request, composed) {
  assert.equal(request.provider, options.provider);
  assert.equal(request.model, options.model);
  assert.equal(request.reasoningEffort, options.reasoningEffort);
  assert.equal(request.maxTokens, options.maxTokens);
  assert.equal(request.tools?.length ?? 0, 0);
  const texts = request.messages.flatMap((message) => message.content.filter((block) => block.type === 'text').map((block) => block.text));
  assert.deepEqual(texts, composed.system ? [composed.system, composed.user] : [composed.user]);
  assert.equal(request.messages.filter((message) => message.role === 'user').length, 1);
  assert.equal(request.messages.filter((message) => message.role === 'assistant').length, 0);
  assert.match(request.sessionId, /^modeltrace-probe-/);
}

test('real host: fallback empty preset, routed minimal transcript, turn completion and effect cleanup', async (t) => {
  const f = await fixture(t);
  const before = await f.snapshot();
  const signal = new AbortController().signal;
  const result = await runSessionProbe(f.ctx, { ...options, signal });
  assert.equal(result.text, reply);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.meta, composeProbe(plan).meta);
  assert.equal(result.sessionId, f.requests[0].sessionId);
  assertRequest(f.requests[0], composeProbe(plan));
  assert.equal(f.requests.length, 1);
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.disposed, [result.sessionId]);
  assert.equal(f.toolCalls(), 0);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  assert.deepEqual(await f.snapshot(), before);
  const turn = f.events.find(({ event }) => event.type === 'turn/end');
  assert.equal(turn.event.data.reason.kind, 'completed');
  // The current host normalizes unknown meta out; prefix remains durable.
  assert.equal(f.created[0].session.header.modeltraceProbe, undefined);
});

test('real host: existing minimal reused, system challenge literal text, repeated calls remain isolated', async (t) => {
  const f = await fixture(t, { minimal: true });
  const before = await f.snapshot();
  const literal = { ...plan, transport: 'system', prefixWords: 80 };
  const results = [];
  for (let round = 0; round < 3; round++) results.push(await runSessionProbe(f.ctx, { ...options, plan: literal }));
  assert.equal(new Set(results.map((result) => result.sessionId)).size, 3);
  for (const request of f.requests) assertRequest(request, composeProbe(literal));
  assert.ok(f.created.every((agent) => agent.session.header.agentPreset === 'minimal'));
  assert.deepEqual(await f.snapshot(), before);
});

test('real host: parent ownership does not copy parent history or scoped persona', async (t) => {
  const f = await fixture(t);
  const parent = await f.ctx.agents.create({
    sessionId: 'fixture-parent', agentOptions: { provider: 'keyless', model: 'parent-model' },
    setup(agentCtx, agent) {
      agentCtx.systemPrompt.section({ name: PERSONA_PREFIX_SECTION, order: 0, text: 'PARENT_PERSONA', complete: true });
      agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'PRIVATE_PARENT_HISTORY' }] }), { surfaceOp: 'append' });
    },
  });
  t.after(() => parent.dispose());
  const before = await f.snapshot();
  const result = await runSessionProbe(f.ctx, { ...options, parentAgent: parent.agent });
  assertRequest(f.requests[0], composeProbe(plan));
  assert.notEqual(result.sessionId, parent.agent.id);
  assert.deepEqual(await f.snapshot(), before);
});

test('real host: max-tokens returns truncated', async (t) => {
  const f = await fixture(t, { behavior: async function* () {
    yield { type: 'text-delta', index: 0, text: reply };
    yield { type: 'finish', reason: { kind: 'max-tokens' } };
  } });
  const before = await f.snapshot();
  const result = await runSessionProbe(f.ctx, options);
  assert.equal(result.truncated, true);
  assert.deepEqual(await f.snapshot(), before);
});

test('real host: timeout and cancel active turns, dispose session/agent/preset/listeners', async (t) => {
  for (const mode of ['timeout', 'cancel']) await t.test(mode, async (t) => {
    const started = Promise.withResolvers();
    const f = await fixture(t, { behavior: async function* ({ signal }) {
      started.resolve();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      signal.throwIfAborted();
    } });
    const before = await f.snapshot();
    const controller = new AbortController();
    const run = runSessionProbe(f.ctx, { ...options, timeoutMs: mode === 'timeout' ? 60 : 1000, signal: controller.signal });
    const rejected = assert.rejects(run, mode === 'timeout' ? /timed out/ : /canceled/);
    await started.promise;
    if (mode === 'cancel') controller.abort('fixture cancel');
    await rejected;
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(f.created.length, 1);
    assert.equal(f.disposed.length, 1);
  });
});

test('real host: cancel during create announcement rolls back before followup', async (t) => {
  const f = await fixture(t);
  const announcing = Promise.withResolvers();
  f.ctx.on('agent/created', async ({ signal }) => {
    announcing.resolve();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  });
  const before = await f.snapshot();
  const controller = new AbortController();
  const run = runSessionProbe(f.ctx, { ...options, signal: controller.signal });
  const rejected = assert.rejects(run, /canceled/);
  await announcing.promise;
  controller.abort();
  await rejected;
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await f.snapshot(), before);
});

test('real host: creation observer failure rolls back all state', async (t) => {
  const f = await fixture(t);
  f.ctx.on('agent/created', () => { throw new Error('fixture publication failure'); });
  const before = await f.snapshot();
  await assert.rejects(runSessionProbe(f.ctx, options), /fixture publication failure/);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await f.snapshot(), before);
});

test('real host: timeout during create announcement rolls back before followup', async (t) => {
  const f = await fixture(t);
  f.ctx.on('agent/created', async ({ signal }) => {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  });
  const before = await f.snapshot();
  await assert.rejects(runSessionProbe(f.ctx, { ...options, timeoutMs: 60 }), /timed out/);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await f.snapshot(), before);
});

test('real host: an unexpected tool call is rejected and never executes', async (t) => {
  const f = await fixture(t, { behavior: async function* () {
    yield { type: 'tool-call-delta', index: 0, id: 'fixture-call', name: 'host_tool', argumentsDelta: '{}' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } });
  const before = await f.snapshot();
  await assert.rejects(runSessionProbe(f.ctx, options), /tool call/);
  assert.equal(f.toolCalls(), 0);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(await f.snapshot(), before);
});

test('real host: absent effort clears a deployment default', async (t) => {
  const f = await fixture(t);
  const result = await runSessionProbe(f.ctx, { ...options, reasoningEffort: undefined });
  assert.equal(result.text, reply);
  assert.equal(f.requests[0].reasoningEffort, undefined);
});

test('real host: missing assistant reply rejects rather than scoring empty text', async (t) => {
  const f = await fixture(t, { behavior: async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; } });
  const before = await f.snapshot();
  await assert.rejects(runSessionProbe(f.ctx, options), /without assistant text|without an assistant message/);
  assert.deepEqual(await f.snapshot(), before);
});

test('real host: pre-aborted signal never creates a probe', async (t) => {
  const f = await fixture(t);
  const before = await f.snapshot();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runSessionProbe(f.ctx, { ...options, signal: controller.signal }), /canceled/);
  assert.equal(f.created.length, 0);
  assert.deepEqual(await f.snapshot(), before);
});
