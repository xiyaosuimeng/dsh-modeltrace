import { randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createScope } from '@deepseek-ai/dsh-scope';
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt';
import { composeProbe } from './prompts.js';

/**
 * Run one challenge through a fresh, tool-free DSH agent/session.
 * The caller owns scoring and injection into the parent session.
 * @returns {Promise<{text: string, truncated: boolean, meta: object, sessionId: string}>}
 */
export async function runSessionProbe(ctx, options) {
  const { provider, model, reasoningEffort, plan, templates, maxTokens, timeoutMs, signal, parentAgent } = options;
  if (!provider || !model) throw new TypeError('Session probe requires provider and model');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('Session probe timeoutMs must be a positive safe integer');
  if (signal?.aborted) throw new Error('Session probe canceled', { cause: signal.reason });
  for (const service of ['agents', 'agentPresets', 'systemPrompt', 'tools']) {
    if (!ctx.get(service)) throw new Error(`Session probe requires ctx.${service}`);
  }

  const composed = composeProbe({ ...plan, templates });
  const sessionId = `modeltrace-probe-${randomUUID()}`;
  // A disposable owner prevents per-call effects accumulating on the plugin.
  const owner = createScope(ctx, {});
  const probeCtx = owner.ctx;
  const control = new AbortController();
  const stopped = Promise.withResolvers();
  const completed = Promise.withResolvers();
  stopped.promise.catch(() => {});
  completed.promise.catch(() => {});
  let handle;
  let probeAgent;

  probeCtx.effect(() => {
    const abort = () => {
      stopped.reject(control.signal.reason);
      completed.reject(control.signal.reason);
      probeAgent?.cancel({ kind: 'user' });
    };
    control.signal.addEventListener('abort', abort, { once: true });
    const cancel = () => control.abort(new Error('Session probe canceled', { cause: signal?.reason }));
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => control.abort(new Error(`Session probe timed out (${timeoutMs} ms)`)), timeoutMs);
    if (signal?.aborted) cancel();
    return () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      control.abort(new Error('Session probe owner disposed'));
      control.signal.removeEventListener('abort', abort);
    };
  }, 'modeltrace.sessionProbe.control');

  const wait = (operation) => Promise.race([operation, stopped.promise]);
  try {
    const registry = probeCtx.get('agentPresets');
    const presets = await wait(registry.list());
    let presetId = presets.find((preset) => preset.id === 'minimal' && !preset.broken)?.id;
    if (presetId === undefined) {
      presetId = `${sessionId}-minimal`;
      // register() is async: the effect also owns a registration arriving
      // after cancellation, so it cannot leave a standing preset behind.
      await wait(probeCtx.effect(() => registry.register({
        id: presetId,
        name: 'ModelTrace probe (temporary)',
        plugins: [],
      }), 'modeltrace.sessionProbe.preset'));
    }
    control.signal.throwIfAborted();
    const input = createUserMessage({
      content: [{ type: 'text', text: composed.user }],
      source: { kind: 'plugin:dsh-modeltrace' },
    });

    const creating = probeCtx.get('agents').create({
      sessionId,
      agentOptions: {
        provider,
        model,
        maxTokens,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      },
      // Current SessionStore drops unknown header fields; the ID prefix is
      // the durable recursion marker. Do not inherit a seed or parent history.
      meta: { modeltraceProbe: true, agentPreset: presetId },
      ...(parentAgent === undefined ? {} : { parentAgent }),
      signal: control.signal,
      async setup(agentCtx, agent) {
        probeAgent = agent;
        await registry.mount(agentCtx, presetId);
        control.signal.throwIfAborted();
        agentCtx.tools.presentAs('native');
        agentCtx.tools.restrict({ allow: [] });
        agentCtx.tools.guard(() => 'ModelTrace session probes cannot execute tools');
        agentCtx.systemPrompt.section({
          name: PERSONA_PREFIX_SECTION,
          order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
          text: composed.system,
          interpolate: false,
          complete: true,
        });
        agentCtx.systemPrompt.suppressRuntimeContext();
        // prepend wraps global defaults; always delegate before fixing the
        // route so a deployment's model selector cannot silently retarget us.
        agentCtx.on('agent/request', async (_payload, next) => {
          const resolved = await next();
          const { reasoningEffort: _effort, ...rest } = resolved;
          return {
            ...rest,
            provider,
            model,
            maxTokens,
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          };
        }, { prepend: true });
        agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
          const assembly = await next();
          return { ...assembly, tools: [], contexts: [], variables: { ...assembly.variables, provider, model } };
        }, { prepend: true });
        agentCtx.on('agent/pre-step', async ({ step }, next) => {
          const decision = await next();
          if (decision.kind === 'reject') return decision;
          if (step > 1) return { kind: 'reject' };
          return { ...decision, messages: [input] };
        }, { prepend: true });

        let assistant;
        let running = false;
        const finish = (reason) => {
          if (reason && reason.kind !== 'completed' && reason.kind !== 'max-tokens') {
            completed.reject(new Error(`Session probe turn ${reason.kind}: ${reason.error?.message ?? reason.reason?.kind ?? ''}`));
          } else if (assistant === undefined) {
            completed.reject(new Error('Session probe ended without an assistant message'));
          } else {
            const text = assistant.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
            if (!text) {
              completed.reject(new Error('Session probe ended without assistant text'));
              return;
            }
            completed.resolve({
              text,
              truncated: reason?.kind === 'max-tokens',
              meta: composed.meta,
              sessionId,
            });
          }
        };
        agentCtx.on('session/event', (session, event) => {
          if (session.id !== sessionId) return;
          if (event.type === 'assistant/message') {
            assistant = event.data.message;
            if (event.data.interrupted || assistant.content.some((block) => block.type === 'tool-call')) {
              completed.reject(new Error('Session probe produced interrupted output or a tool call'));
              agent.cancel({ kind: 'user' });
            }
          } else if (event.type === 'turn/end') finish(event.data.reason);
        });
        agentCtx.on('agent/status', ({ status }) => {
          if (status === 'running') running = true;
          else if (status === 'idle' && running) finish();
        });
      },
    });
    // The current factory rolls back an aborted create. Also release any
    // late handle from implementations that finish publication at the race.
    creating.then((created) => {
      if (control.signal.aborted) created.dispose().catch((error) => ctx.logger.warn(error));
    }, () => {});
    handle = await wait(creating);
    control.signal.throwIfAborted();
    handle.agent.followup(input);
    return await wait(completed.promise);
  } finally {
    try {
      await handle?.dispose();
    } finally {
      await owner.dispose();
    }
  }
}
