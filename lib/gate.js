/** Background verification, per-session cadence, and logged context injection. */
import { randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { PLUGIN, loadBank, matchBankModel, normalizeModelId, verdictAction, verifyModel } from './verify.js';
import { buildVerdictText } from './report.js';

export function createGate(ctx, config) {
  const states = new Map();
  let disposed = false;
  function stateFor(agent) {
    const id = String(agent?.id ?? '');
    if (!states.has(id)) states.set(id, { agent, key: '', verdict: null, action: 'skip', locked: false,
      at: 0, startedAt: 0, runId: null, running: null, controller: null, timer: null,
      messages: 0, lastCheckedMessage: 0, pendingChecks: 0, seen: new Set(), injectedRun: null });
    return states.get(id);
  }
  function selectionFor(agent) {
    // 五个来源全部读出来记录在案（诊断用：一眼看出哪个来源说了什么），
    // 再按优先级挑选第一个可用的。
    const candidates = {};

    let projectionState = null;
    try {
      projectionState = ctx.get('sessionProjections')?.stateOf?.(agent?.session, 'modelSelection') ?? null;
    }
    catch { /* 投影缺席 */ }
    candidates.pending = projectionState?.pending ?? null;
    candidates.lastUsed = projectionState?.lastUsed ?? null;

    let requestHeader = null;
    try {
      const logged = agent?.session?.requestHeader?.()?.config;
      if (logged !== undefined && logged !== null && logged.model !== undefined) {
        requestHeader = { provider: logged.provider, model: logged.model, reasoningEffort: logged.reasoningEffort };
      }
    }
    catch { /* 无请求头 */ }
    candidates.requestHeader = requestHeader === null ? null : { provider: requestHeader.provider, model: requestHeader.model };

    const options = agent?.options ?? {};
    candidates.agentOptions = (options.model !== undefined && options.model !== null && options.model !== '')
      ? { provider: options.provider, model: options.model }
      : null;

    let globalDefault = null;
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
      if (selection !== undefined && selection !== null) {
        globalDefault = { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort };
      }
    }
    catch { /* 服务缺席 */ }
    candidates.globalDefault = globalDefault === null ? null : { provider: globalDefault.provider, model: globalDefault.model };

    const ordered = [
      ['session-pending', candidates.pending],
      ['session-last-used', candidates.lastUsed],
      ['request-header', requestHeader],
      ['agent-options-snapshot', candidates.agentOptions === null ? null : { ...candidates.agentOptions, reasoningEffort: options.reasoningEffort }],
      ['global-default', globalDefault],
    ];

    for (const [name, picked] of ordered) {
      if (picked === null || picked === undefined) continue;
      if (picked.model === undefined || picked.model === null || picked.model === '') continue;
      return {
        provider: picked.provider ?? '',
        model: picked.model,
        reasoningEffort: picked.reasoningEffort,
        source: name,
        candidates,
      };
    }

    return { provider: '', model: '', reasoningEffort: undefined, source: 'none', candidates };
  }


  function targetKey(selection) {
    return `${normalizeModelId(selection.provider)}::${normalizeModelId(selection.model)}`;
  }
  function auxiliary(agent) {
    return String(agent?.id ?? '').startsWith('modeltrace-probe-') || agent?.session?.meta?.modeltraceProbe === true;
  }
  function supported(selection) {
    return matchBankModel(selection.model, config.modelAliases, loadBank(config)) !== null;
  }
  function cancel(state) {
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
    state.controller?.abort(new Error('ModelTrace target or lifecycle changed'));
    state.controller = null;
    state.running = null;
    state.runId = null;
    state.pendingChecks = 0;
  }
  function resetTarget(state, selection) {
    const key = targetKey(selection);
    if (state.key === key) return;
    cancel(state);
    Object.assign(state, { key, verdict: null, action: 'skip', locked: false, at: 0,
      startedAt: 0, lastCheckedMessage: state.messages, injectedRun: null });
  }
  function injectResult(agent, state, verdict) {
    if (!config.injectVerdict || state.injectedRun === state.runId) return;
    if (state.action === 'skip' && !config.injectOnMatch) return;
    try {
      agent.inject(createUserMessage({ content: [{ type: 'text', text: buildVerdictText(verdict, config, state.action) }],
        source: { kind: `plugin:${PLUGIN}` } }));
      state.injectedRun = state.runId;
    } catch (error) { ctx.logger?.warn?.('dsh-modeltrace: 注入裁决失败：%o', error); }
  }
  // Positive seconds use an actual background timer. Zero is message driven to avoid a busy loop.
  function schedule(agent, state) {
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
    if (disposed || !config.enabled || config.verifyOn === 'manual' || config.intervalMessages !== null || !(config.intervalSeconds > 0)) return;
    const token = state.runId;
    const remaining = config.intervalSeconds * 1000 - (Date.now() - state.at);
    state.timer = setTimeout(() => {
      state.timer = null;
      if (states.get(String(agent.id)) !== state || state.runId !== token) return;
      const selection = selectionFor(agent);
      resetTarget(state, selection);
      if (!supported(selection)) return;
      if (Date.now() - state.at < config.intervalSeconds * 1000) { schedule(agent, state); return; }
      void ensureVerified(agent, undefined, { force: true });
    // Node overflows delays above 2^31-1 ms to 1 ms. Re-arm long intervals.
    }, Math.min(2147483647, Math.max(1, remaining)));
    state.timer.unref?.();
  }
  async function ensureVerified(agent, signal, options = {}) {
    const state = stateFor(agent);
    const selection = selectionFor(agent);
    resetTarget(state, selection);
    if (disposed || !config.enabled || auxiliary(agent) || !supported(selection)) {
      cancel(state);
      state.verdict = null; state.locked = false; state.action = 'skip';
      return { status: 'skipped', claimedModel: selection.model, rounds: 0, validRounds: 0,
        probes: [], diagnostics: [], error: '插件已关闭或声称模型不在指纹库内。' };
    }
    if (state.running !== null) return state.running;
    if (!options.force && state.verdict !== null) return state.verdict;
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
    const controller = new AbortController();
    const runId = randomUUID();
    const key = state.key;
    state.controller = controller;
    state.runId = runId;
    state.verdict = null;
    state.action = 'skip';
    state.locked = false;
    state.startedAt = Date.now();
    if (!options.preserveCadence) state.lastCheckedMessage = state.messages;
    const callSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const running = Promise.resolve().then(async () => {
      let verdict;
      try {
        verdict = await verifyModel(ctx, { claimed: selection.model, claimedSource: selection.source,
          selectionCandidates: selection.candidates, provider: selection.provider, model: selection.model,
          reasoningEffort: selection.reasoningEffort, parentAgent: agent, signal: callSignal, config });
      } catch (error) {
        verdict = { status: 'error', claimedModel: selection.model, provider: selection.provider, model: selection.model,
          rounds: 0, validRounds: 0, probes: [], diagnostics: [], error: error instanceof Error ? error.message : String(error) };
      }
      // Reject stale completions after a selection change, cancellation, disposal, or plugin reload.
      if (disposed || callSignal.aborted || states.get(String(agent.id)) !== state || state.runId !== runId ||
          targetKey(selectionFor(agent)) !== key || !config.enabled) return verdict;
      state.verdict = verdict;
      state.action = verdictAction(verdict, config);
      state.locked = state.action === 'block';
      state.at = Date.now();
      injectResult(agent, state, verdict);
      return verdict;
    }).finally(() => {
      if (state.runId === runId && states.get(String(agent.id)) === state) {
        state.running = null; state.controller = null;
        if (!callSignal.aborted && state.verdict !== null && targetKey(selectionFor(agent)) === key) {
          if (state.pendingChecks > 0) {
            state.pendingChecks--;
            void ensureVerified(agent, undefined, { force: true, preserveCadence: true });
          } else schedule(agent, state);
        }
      }
    });
    state.running = running;
    return running;
  }
  function attach() {
    ctx.effect(() => () => {
      disposed = true;
      for (const state of states.values()) cancel(state);
      states.clear();
    });
    ctx.on('agent/session-start', ({ agent, source }) => {
      if (source === 'resume' && !config.reverifyOnResume) return;
      const state = states.get(String(agent?.id ?? ''));
      if (state) cancel(state);
      states.delete(String(agent?.id ?? ''));
    });
    ctx.on('agent/disposed', ({ agent }) => {
      const state = states.get(String(agent?.id ?? ''));
      if (state) cancel(state);
      states.delete(String(agent?.id ?? ''));
    });
    ctx.on('agent/pre-step', async ({ agent, signal, messages }, next) => {
      const decision = await next();
      if (decision.kind === 'reject' || signal?.aborted || auxiliary(agent)) return decision;
      const state = stateFor(agent);
      const selection = selectionFor(agent);
      resetTarget(state, selection);
      if (!config.enabled || !supported(selection)) {
        cancel(state); state.verdict = null; state.locked = false; state.action = 'skip';
        return decision;
      }
      let newMessages = 0;
      for (const message of messages ?? []) {
        if (message.role !== 'user' || message.source?.kind !== 'user') continue;
        const id = message.id ?? message;
        if (state.seen.has(id)) continue;
        state.seen.add(id); state.messages++; newMessages++;
      }
      if (config.verifyOn === 'manual' || newMessages === 0) return decision;
      const count = config.intervalMessages;
      const seconds = config.intervalSeconds;
      const first = state.verdict === null && state.running === null;
      const due = first || (count !== null
        ? state.messages - state.lastCheckedMessage >= Math.max(1, count)
        : seconds !== null && (seconds === 0 || (state.running === null && Date.now() - state.at >= seconds * 1000)));
      if (due) {
        const checks = first ? 1 : count !== null
          ? Math.floor((state.messages - state.lastCheckedMessage) / Math.max(1, count))
          : seconds === 0 ? newMessages : 1;
        state.lastCheckedMessage = first || count === null ? state.messages
          : state.lastCheckedMessage + checks * Math.max(1, count);
        state.pendingChecks += checks;
        if (state.running === null) {
          state.pendingChecks--;
          void ensureVerified(agent, undefined, { force: true, preserveCadence: true });
        }
      }
      return decision;
    });
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (!config.enabled || config.enforce !== 'block' || !exec.agent || auxiliary(exec.agent)) return next();
      const state = states.get(String(exec.agent.id));
      if (!state?.locked || state.key !== targetKey(selectionFor(exec.agent)) || !supported(selectionFor(exec.agent))) return next();
      if (config.allowedToolsWhenBlocked.includes(exec.name)) return next();
      return { kind: 'deny', reason: `dsh-modeltrace 已锁定任务：声称模型 ${state.verdict.claimedModel}，指纹判定 ${state.verdict.prediction || '未知'}。请汇报并等待用户决定；/modeltrace allow 可放行。` };
    });
  }
  return {
    attach, stateFor, ensureVerified,
    snapshot(agent) {
      const state = states.get(String(agent?.id ?? ''));
      const selection = selectionFor(agent);
      const valid = state?.key === targetKey(selection) && supported(selection) && config.enabled;
      return { verdict: valid ? state.verdict : null, action: valid ? state.action : 'skip', locked: valid ? state.locked : false,
        at: valid ? state.at : 0, selection, selectionCandidates: selection.candidates,
        running: valid && state.running !== null, runId: valid ? state.runId : null,
        startedAt: valid ? state.startedAt : 0, floatingWindow: config.floatingWindow, enabled: config.enabled,
        status: !valid || !state.runId ? 'idle' : state.running ? 'running' : 'complete' };
    },
    unlock(agent) {
      const state = stateFor(agent);
      state.locked = false;
      if (state.action === 'block') state.action = 'report';
      return true;
    },
    async reverify(agent, signal) {
      const state = stateFor(agent);
      cancel(state); state.verdict = null; state.locked = false;
      return ensureVerified(agent, signal, { force: true });
    },
    bank() { return loadBank(config); },
  };
}
