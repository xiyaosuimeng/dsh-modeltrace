/**
 * dsh-modeltrace 端到端门控测试（不联网、不真实调用模型）。
 *
 * 用一个假的 ctx（提供 llm / agentDefaultModel / on / get / logger）把 gate 的
 * 三条链路跑通：
 *   1. agent/pre-step   —— 校验并把裁决追加进进入本步的消息
 *   2. tools/pre-execute —— 不一致时拒绝工作类工具
 *   3. /modeltrace allow —— 放行后工具恢复
 * 假 LLM 返回的是 ModelTrace 仓库里的**真实参考回答**，所以评分链路是真的。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../lib/config.js';
import { createGate } from '../lib/gate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REFERENCE = readFileSync(join(HERE, 'fixtures', 'reference-sample.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

/** 从真实参考回答里取一条当假 LLM 的输出（评分链路是真的）。 */
function realText(modelId) {
  const row = REFERENCE.find((item) => item.model_id === modelId && typeof item.text === 'string');
  if (row === undefined) throw new Error(`no reference text for ${modelId}`);
  return row.text;
}

/** 假 ctx：记录所有注册的监听器与 LLM 调用次数。 */
function makeCtx(selection, replyText) {
  const handlers = new Map();
  const calls = [];
  const ctx = {
    calls,
    llm: {
      async *stream(options) {
        calls.push(options);
        yield { type: 'text-delta', index: 0, text: replyText };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    projection: null,
    get(name) {
      if (name === 'llm') return ctx.llm;
      if (name === 'agentDefaultModel') return { currentSelection: () => selection };
      if (name === 'sessionProjections') {
        return { stateOf: (_session, key) => (key === 'modelSelection' ? ctx.projection : undefined) };
      }
      return undefined;
    },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
      return () => {};
    },
    inject() { return {}; },
    provide() {},
    effect() {},
    logger: { warn: (...args) => console.log('  [warn]', ...args) },
  };
  return { ctx, handlers, calls, selection };
}

function makeAgent(id, options = {}) {
  const injected = [];
  return {
    injected,
    agent: {
      id,
      options,
      session: { id },
      inject(message) { injected.push(message); },
    },
  };
}

const allow = () => Promise.resolve({ kind: 'allow' });
const notAborted = () => new AbortController().signal;

/** 跑一个回合的 pre-step（按注册顺序串成 waterfall）。 */
async function runTurn(handlers, agent, turn, userText = '帮我重构这个模块') {
  const userMessage = { id: `m${turn}`, role: 'user', content: [{ type: 'text', text: userText }], source: { kind: 'user' } };
  const listeners = handlers.get('agent/pre-step') ?? [];
  let decision;
  for (const fn of listeners) {
    const next = () => Promise.resolve(decision ?? { kind: 'enter', messages: [userMessage] });
    decision = await fn({ agent, messages: [userMessage], turn, step: 1, signal: notAborted() }, next);
  }
  return decision;
}

/** 跑一次工具门控。 */
async function runTool(handlers, agent, name) {
  const listeners = handlers.get('tools/pre-execute') ?? [];
  let decision;
  for (const fn of listeners) decision = await fn({ name, agent, signal: notAborted() }, allow);
  return decision;
}

const results = [];
async function settle(gate, agent) { await gate.stateFor(agent).running; }


async function scenario(label, { selection, replyModel, turns = 1 }) {
  console.log(`\n=== ${label} ===`);
  const { ctx, handlers, calls } = makeCtx(selection, realText(replyModel));
  const config = resolveConfig({ rounds: 3, verifyOn: 'session-start', enforce: 'block' });
  const gate = createGate(ctx, config);
  gate.attach();

  const { agent, injected } = makeAgent(`session-${label}`);

  const preStepCountAtStart = calls.length;
  const turnDecisions = [];
  for (let turn = 1; turn <= turns; turn += 1) { turnDecisions.push(await runTurn(handlers, agent, turn)); await settle(gate, agent); }
  const decision = turnDecisions.at(-1);
  const firstDecision = turnDecisions[0];

  const snapshot = gate.snapshot(agent);
  const verdict = snapshot.verdict ?? { status: 'unknown', claimedModel: snapshot.selection.model, rounds: 0, validRounds: 0 };
  const injectedMessage = injected.at(-1);
  const injectedText = injectedMessage?.content?.[0]?.text ?? '';
  const injectedSource = injectedMessage?.source;
  const bash = await runTool(handlers, agent, 'bash');
  const statusTool = await runTool(handlers, agent, 'modeltrace_status');

  console.log(`  声称模型        : ${selection.model}`);
  console.log(`  指纹判定        : ${verdict.prediction ?? '(无)'}${verdict.probability !== undefined ? ` 概率 ${(verdict.probability * 100).toFixed(1)}%` : ''}`);
  console.log(`  状态 / 动作     : ${verdict.status} / ${snapshot.action}   锁定=${snapshot.locked}`);
  console.log(`  探针轮数        : ${verdict.rounds}（有效输出 ${verdict.validRounds}）`);
  console.log(`  LLM 调用次数    : ${calls.length}（${turns} 个回合共 ${calls.length - preStepCountAtStart} 次探针调用）`);
  console.log(`  进入本步消息数  : ${decision.messages.length}（原 1 + 裁决 ${decision.messages.length - 1}）`);
  console.log(`  注入正文首行    : ${injectedText.split('\n')[0] || '(未注入)'}`);
  console.log(`  注入 source.kind: ${injectedSource?.kind ?? '(无)'}${injectedSource && 'plugin' in injectedSource ? `（含退役字段 plugin=${injectedSource.plugin}）` : ''}`);
  console.log(`  bash 裁决       : ${bash.kind}${bash.reason ? ` — ${bash.reason.slice(0, 70)}…` : ''}`);
  console.log(`  modeltrace_status 裁决: ${statusTool.kind}`);

  const record = { verdict, snapshot, decision, firstDecision, turnDecisions, bash, statusTool, calls, agent, gate, handlers, injectedMessage, injectedSource, injected };
  results.push({ label, record });
  return record;
}

const a = await scenario('A 一致：声称 gpt-5.4，实际回答来自 gpt-5.4', {
  selection: { provider: 'mock', model: 'gpt-5.4' },
  replyModel: 'gpt-5.4',
  turns: 3, // 三个回合：只有第一回合应该真的发探针
});

const b = await scenario('B 不一致：声称 gpt-5.4，实际回答来自 claude-opus-4-6', {
  selection: { provider: 'mock', model: 'gpt-5.4' },
  replyModel: 'claude-opus-4-6',
});

const c = await scenario('C 库外：声称 deepseek-v4.1-flash（闭集之外）', {
  selection: { provider: 'mock', model: 'deepseek-v4.1-flash' },
  replyModel: 'gpt-5.4',
});

// 放行后工具恢复
b.gate.unlock(b.agent);
const bAfterUnlock = await runTool(b.handlers, b.agent, 'bash');
console.log(`\n  [B] /modeltrace allow 之后 bash 裁决: ${bAfterUnlock.kind}`);

// A 的裁决只注入在首回合；source.kind 校验要取那一条。
const aFirstSource = a.injectedMessage?.source;

// 换模型后应自动重新校验；且必须读**会话投影**而不是全局默认
const { ctx: swapCtx, handlers: swapHandlers, calls: swapCalls } = makeCtx({ provider: 'mock', model: 'gpt-5.4' }, realText('gpt-5.4'));
const swapGate = createGate(swapCtx, resolveConfig({ rounds: 3 }));
swapGate.attach();
const swapAgent = makeAgent('session-swap').agent;
await runTurn(swapHandlers, swapAgent, 1); await settle(swapGate, swapAgent); // 首回合：声称 gpt-5.4
const afterFirst = swapCalls.length;

// 用户在界面上把模型切到 claude-opus-4-6。这里**只改会话投影**，全局默认刻意保持
// gpt-5.4 不变 —— 用来证明读取顺序优先走会话投影（这正是之前报错 deepseek-flash 的根因）。
swapCtx.projection = { pending: { provider: 'mock', model: 'claude-opus-4-6' }, lastUsed: null };
swapCtx.llm.stream = async function* (options) {
  swapCalls.push(options);
  yield { type: 'text-delta', index: 0, text: realText('claude-opus-4-6') };
  yield { type: 'finish', reason: { kind: 'stop' } };
};
await runTurn(swapHandlers, swapAgent, 2); await settle(swapGate, swapAgent);
const swapState = swapGate.snapshot(swapAgent).verdict;
console.log(`\n=== D 会话中途切换到 claude-opus-4-6（全局默认仍是 gpt-5.4）===`);
console.log(`  首回合探针 ${afterFirst} 次，切换后合计 ${swapCalls.length} 次（应重新校验）`);
console.log(`  切换后裁决: 声称 ${swapState.claimedModel} / ${swapState.status} → ${swapState.prediction}`);

// E：复现用户实测踩到的坑 —— agent.options 是创建时的过期快照（gpt-6-sol），
// 而会话投影才反映用户当前真正的选择（deepseek-flash）。声称必须以会话为准。
const staleCtxBundle = makeCtx({ provider: 'dopenai', model: 'gpt-6-sol' }, realText('gpt-6-sol'));
staleCtxBundle.ctx.projection = { pending: null, lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' } };
const staleGate = createGate(staleCtxBundle.ctx, resolveConfig({ rounds: 3 }));
staleGate.attach();
const staleAgent = makeAgent('session-stale', { provider: 'dopenai', model: 'gpt-6-sol' }).agent;
await runTurn(staleCtxBundle.handlers, staleAgent, 1);
const staleSnap = staleGate.snapshot(staleAgent);
const staleVerdict = staleSnap.verdict ?? { status: 'unknown', claimedModel: staleSnap.selection.model, claimedSource: staleSnap.selection.source, selectionCandidates: staleSnap.selectionCandidates };
console.log(`\n=== E agent.options 过期快照 vs 会话投影 ===`);
console.log(`  agent.options = gpt-6-sol（创建时快照）  会话投影 lastUsed = deepseek-flash`);
console.log(`  裁定声称模型 : ${staleVerdict.claimedModel}（来源 ${staleVerdict.claimedSource}）`);
console.log(`  状态/动作    : ${staleVerdict.status} / ${staleGate.snapshot(staleAgent).action}`);
console.log(`  探针调用次数 : ${staleCtxBundle.calls.length}（库外模型应 0 次）`);
console.log(`  来源明细     : ${JSON.stringify(staleVerdict.selectionCandidates)}`);

console.log('\n=== 断言 ===');
const checks = [
  ['A 状态 match', a.verdict.status === 'match'],
  ['A 不锁定', a.snapshot.locked === false],
  ['A 放行 bash', a.bash.kind === 'allow'],
  ['A 完成后通过 agent.inject 注入裁决', a.injected.length === 1 && a.firstDecision.messages.length === 1],
  ['A 后续回合不重复注入裁决', a.decision.messages.length === 1],
  ['A 三个回合只发 3 次探针（不重复烧钱）', a.calls.length === 3],
  ['A 探针请求不含工具 schema', a.calls[0]?.tools === undefined],
  ['A 探针请求只带 1 条 user 消息', a.calls[0]?.messages?.length === 1],
  ['A 探针不带 sessionId（完全脱离会话）', a.calls.every((c) => !('sessionId' in c))],
  ['A 探针无 system / 无 tools（真·空上下文）', a.calls.every((c) => c.system === undefined && c.tools === undefined)],
  ['A 每轮探针取数 ≥ 218（满足评分器下限）', a.calls.every((c) => {
    const nums = (c.messages[0].content[0].text.match(/\d{3}/g) ?? []).map(Number);
    return nums.some((n) => n >= 218 && n <= 400);
  })],
  ['B 状态 mismatch', b.verdict.status === 'mismatch'],
  ['B 锁定', b.snapshot.locked === true],
  ['B 完成后注入裁决', b.injected.length === 1 && b.decision.messages.length === 1],
  ['B 拒绝 bash', b.bash.kind === 'deny'],
  ['B 仍放行 modeltrace_status', b.statusTool.kind === 'allow'],
  ['放行后 bash 恢复 allow', bAfterUnlock.kind === 'allow'],
  ['C 状态 unknown', c.verdict.status === 'unknown'],
  ['C 默认不锁定', c.snapshot.locked === false],
  ['C 库外静默：不注入任何内容', c.decision.messages.length === 1],
  ['C 不发探针（库外直接短路）', c.calls.length === 0],
  ['C 库外不锁定', c.snapshot.locked === false],
  ['D 换模型后重新校验', swapCalls.length > afterFirst],
  ['D 会话投影优先于全局默认', swapState.claimedModel === 'claude-opus-4-6'],
  ['D 切到 claude 后判为 match', swapState.status === 'match'],
  ['E 声称取会话投影而非过期 agent.options', staleVerdict.claimedModel === 'deepseek-flash'],
  ['E 来源标记为会话投影', staleVerdict.claimedSource === 'session-last-used'],
  ['E 库外模型判 unknown', staleVerdict.status === 'unknown'],
  ['E 库外模型不发探针', staleCtxBundle.calls.length === 0],
  ['E 来源明细里仍能看到过期的 agent 快照', staleVerdict.selectionCandidates?.agentOptions?.model === 'gpt-6-sol'],
  // —— v4 source 回归（0.1.1）：曾用退役写法 {kind:'plugin',plugin:...}，被 v4 写入路径拒收，
  //    报 "format v4 message requires a producer-owned source kind"。这里钉死正确形状。
  //    A 只在首回合注入（后续回合复用裁决），所以取 firstDecision 的最后一条。
  ['A 首回合注入消息 source.kind 是 producer-owned', typeof aFirstSource?.kind === 'string' && aFirstSource.kind.length > 0 && aFirstSource.kind !== 'plugin'],
  ['A 首回合注入消息 source.kind === plugin:dsh-modeltrace', aFirstSource?.kind === 'plugin:dsh-modeltrace'],
  ['A 首回合注入消息不带退役字段 plugin', aFirstSource !== undefined && !('plugin' in aFirstSource)],
  ['B 注入消息 source.kind === plugin:dsh-modeltrace', b.injectedSource?.kind === 'plugin:dsh-modeltrace'],
  ['B 注入消息不带退役字段 plugin', b.injectedSource !== undefined && !('plugin' in b.injectedSource)],
];

let ok = true;
for (const [label, pass] of checks) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) ok = false;
}
console.log(ok ? '\n全部通过。' : '\n存在失败。');
process.exit(ok ? 0 : 1);
