/**
 * 插件装载 + 提示词变换测试。
 *
 * 1) 用假 ctx 调 apply()，确认 ctx.inject(['tools']/['commands']) 两条注册通路都不抛错，
 *    defineTool 的参数/输出 schema 通过运行时校验，命令各子命令可执行。
 * 2) 确认"同义不同词"的变换确实生效：固定 seed 可复现，不同轮次/不同 seed 措辞不同。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import plugin, { name as pluginName, Config } from '../lib/index.js';
import { resolveConfig } from '../lib/config.js';
import { composeProbe, planRounds, LANGUAGES, TASK_TEMPLATES, CONSTRAINT_VARIANTS } from '../lib/prompts.js';
import { analyzeGlobalOutputs } from '../lib/scorer.js';
import z from '@deepseek-ai/schemastery';

const HERE = dirname(fileURLToPath(import.meta.url));
const bank = JSON.parse(readFileSync(join(HERE, '..', 'assets', 'unified_bank.json'), 'utf8'));
const replyText = readFileSync(join(HERE, 'fixtures', 'reference-sample.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line))
  .find((row) => row.model_id === 'gpt-5.4').text;

/**
 * 复刻宿主 dsh-settings 的 volatileForm() 过滤语义：设置表单里只会留下带
 * `meta.volatile` 的字段（或其 volatile 祖先之下的叶子），一个都没有时命名空间根本
 * 不会被 describe() 下发。所以这里断言 Config 的 volatile 叶子恰好是那 14 个旋钮。
 */
function volatileLeafNames() {
  const node = new z(Config.toJSON());
  const walk = (n, prefix = '') => Object.entries(n.dict ?? {}).flatMap(([key, child]) => [
    ...(child.meta?.volatile ? [prefix + key] : []),
    ...walk(child, `${prefix}${key}.`),
  ]);
  return walk(node);
}

/** 按给定配置挂载一次插件（每次 apply 都是一个独立的运行期实例 = 一次 loader reconcile）。 */
function mount(config) {
  const registered = { tools: [], commands: [], settingsPolicy: null };
  const handlers = new Map();
  const ctx = {
    llm: {
      async *stream() {
        yield { type: 'text-delta', index: 0, text: replyText };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    get(n) {
      if (n === 'llm') return ctx.llm;
      if (n === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'mock', model: 'gpt-5.4' }) };
      return undefined;
    },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
      return () => {};
    },
    inject(keys, callback) {
      for (const key of keys) {
        if (key === 'tools') callback({ tools: { register: (def) => { registered.tools.push(def); return () => {}; } } }, undefined);
        if (key === 'commands') callback({ commands: { register: (def) => { registered.commands.push(def); return () => {}; } } }, undefined);
        if (key === 'settings') callback({
          settings: {
            // 0.1.7-alpha.2 的真实 API（dsh-settings#configure）：插件只声明「自动设置页」
            // 策略；命名空间本身由宿主从插件导出的 Config 里筛 volatile 字段自动得到，
            // 不需要插件自己注册任何东西。
            configure: (presentation, owner) => {
              registered.settingsPolicy = { presentation, owner };
              return () => {};
            },
          },
          effect: (fn) => fn(),
        }, undefined);
      }
      return {};
    },
    provide(n, v) { ctx.provided = { [n]: v }; },
    effect() {},
    fiber: { kind: 'plugin-fiber' },
    logger: { warn: (...a) => console.log('  [warn]', ...a), debug: (...a) => console.log('  [debug]', ...a) },
  };
  plugin.apply(ctx, config);
  return { ctx, registered, handlers, tool: registered.tools[0], command: registered.commands[0] };
}

const { ctx, registered, handlers, tool, command } = mount({});

console.log('=== 装载 ===');
console.log(`  插件名: ${pluginName}  default.name: ${plugin.default?.name ?? pluginName}`);
console.log(`  已注册工具: ${registered.tools.map((t) => t.name).join(', ') || '(无)'}`);
console.log(`  已注册命令: ${registered.commands.map((c) => c.name).join(', ') || '(无)'}`);
console.log(`  已注册钩子: ${[...handlers.keys()].join(', ')}`);
console.log(`  Config 导出类型: ${typeof Config}（Schemastery schema 对象/构造函数）`);
console.log(`  设置页可见项（volatile）: ${volatileLeafNames().join(', ')}`);
console.log(`  自动设置页策略: ${JSON.stringify(registered.settingsPolicy?.presentation ?? null)}`);

// 工具：status 与 recheck 两条路径
const agent = { id: 'sess-tool', options: {}, session: { id: 'sess-tool' }, inject() {} };
await handlers.get('agent/pre-step')[0]({ agent, messages: [{ id: 'm', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal },
  () => Promise.resolve({ kind: 'enter', messages: [] }));

await ctx.provided.modelTraceGate.stateFor(agent).running;
const statusResult = await tool.execute({ action: 'status' }, { agent, signal: new AbortController().signal });
const recheckResult = await tool.execute({ action: 'recheck' }, { agent, signal: new AbortController().signal });
console.log('\n=== 工具 modeltrace_status ===');
console.log(`  status  → ${statusResult.status} locked=${statusResult.locked} 摘要=${statusResult.summary}`);
console.log(`  recheck → ${recheckResult.status} 概率=${(recheckResult.probability * 100).toFixed(1)}% 候选=${recheckResult.candidates?.[0]}`);
console.log(`  渲染输出首行: ${tool.output.render({}, statusResult)[0].text.split('\n')[0]}`);

// 设置界面改动 → 运行期配置：真实链路是 configEditor.edit → reconcileProfilePatches →
// Loader 带新 config 重新 apply 本插件（不是原地改配置对象）。所以这里重新挂载一次。
const remounted = mount({ rounds: 5, countMin: 250, countMax: 260, silentWhenUnknown: false });
const afterSettings = await remounted.tool.execute({ action: 'status' }, { agent, signal: new AbortController().signal });
console.log(`\n=== 设置界面改动后（重新 apply）===`);
console.log(`  rounds ${statusResult.rounds} → ${afterSettings.rounds}，取数区间 ${statusResult.countMin}-${statusResult.countMax} → ${afterSettings.countMin}-${afterSettings.countMax}，silentWhenUnknown ${statusResult.silentWhenUnknown} → ${afterSettings.silentWhenUnknown}`);

console.log('\n=== 命令 /modeltrace ===');
for (const sub of ['help', 'bank', 'status', 'recheck', 'allow']) {
  const result = await command.handler({ agent, rawInput: sub, signal: new AbortController().signal });
  const first = (result.text ?? '').split('\n').find((l) => l.trim().length > 0) ?? '';
  console.log(`  /modeltrace ${sub.padEnd(7)} → ${result.kind}  ${first.slice(0, 72)}`);
}

// ---- 提示词变换 ----
console.log('\n=== 同义不同词变换 ===');
const fixed = planRounds({ rounds: 3, languages: ['zh', 'en'], countMin: 218, countMax: 400, seed: 12345 });
console.log(`  固定 seed=12345 的 3 轮计划：`);
for (const plan of fixed) {
  const composed = composeProbe({ ...plan });
  const first = composed.user.split('\n').find((l) => l.trim().length > 0);
  console.log(`    轮${plan.round} ${plan.language}/${plan.style}/${plan.transport} n=${plan.count} → ${first.slice(0, 66)}`);
}
const replay = planRounds({ rounds: 3, languages: ['zh', 'en'], countMin: 218, countMax: 400, seed: 12345 });
const reproducible = JSON.stringify(replay.map((p) => composeProbe({ ...p }).user)) === JSON.stringify(fixed.map((p) => composeProbe({ ...p }).user));
const other = planRounds({ rounds: 3, languages: ['zh', 'en'], countMin: 218, countMax: 400, seed: 999 });
const differs = JSON.stringify(other.map((p) => composeProbe({ ...p }).user)) !== JSON.stringify(fixed.map((p) => composeProbe({ ...p }).user));

// 同语言、同轮次下的措辞池：用不同 seed 抽，统计出现过的任务句种数
const seen = new Set();
for (let seed = 0; seed < 400; seed += 1) {
  const plan = planRounds({ rounds: 1, languages: ['zh'], countMin: 218, countMax: 400, seed })[0];
  const text = composeProbe({ ...plan }).user;
  for (const template of TASK_TEMPLATES.zh) {
    if (text.includes(template.replace('{count}', String(plan.count)).slice(0, 18))) seen.add(template);
  }
}
console.log(`  可复现（同 seed 同结果）: ${reproducible}`);
console.log(`  不同 seed 措辞不同      : ${differs}`);
console.log(`  中文任务模板池: ${TASK_TEMPLATES.zh.length} 条，抽样命中 ${seen.size} 条`);
console.log(`  中文约束模板池: ${CONSTRAINT_VARIANTS.zh.length} 条`);
console.log(`  语言池: ${LANGUAGES.join(' ')}`);

// 端到端：把真实回答喂给评分器，确认 3 轮融合仍可判定
const analysis = analyzeGlobalOutputs(
  [294, 311, 329].map((n) => ({ text: replyText, expected_count: n })),
  bank,
);
// 默认组卷必须是"评分器能接受"的取数：低于 max(80, ceil(count*0.55)) 的回答会被丢弃，
// 期望 32 个时永远判不出结果 —— 这正是之前那版默认值 [32,48,24,40] 的致命问题。
const defaults = planRounds({ rounds: 3, seed: 7 });
const defaultCounts = defaults.map((plan) => plan.count);
const allClean = defaults.every((plan) => plan.transport === 'clean');
const defaultPromptHasCount = defaults.every((plan) => composeProbe({ ...plan }).user.includes(String(plan.count)));
console.log(`  默认取数: ${defaultCounts.join(' / ')}  通道: ${allClean ? 'clean（空上下文）' : '混合'}`);

const analysisFromRequested = analyzeGlobalOutputs(
  [defaults[0], defaults[1], defaults[2]].map((plan) => ({ text: replyText, expected_count: plan.count })),
  bank,
);

console.log(`\n=== 评分链路 ===`);
console.log(`  ${analysis.prediction} 概率 ${(analysis.probability * 100).toFixed(1)}% 家族 ${analysis.family_prediction} 校准键 ${analysis.calibration.queries}`);

const checks = [
  ['插件默认导出含 name/Config/apply', plugin.name === 'dsh-modeltrace' && typeof plugin.apply === 'function' && typeof plugin.Config === 'function'],
  ['注册了 modeltrace_status 工具', registered.tools.length === 1 && tool.name === 'modeltrace_status'],
  ['注册了 modeltrace 命令', registered.commands.length === 1 && command.name === 'modeltrace'],
  ['注册了 pre-step 钩子', (handlers.get('agent/pre-step') ?? []).length === 1],
  ['注册了 tools/pre-execute 钩子', (handlers.get('tools/pre-execute') ?? []).length === 1],
  ['注册了 session-start 钩子', (handlers.get('agent/session-start') ?? []).length === 1],
  ['注册了 agent/disposed 钩子', (handlers.get('agent/disposed') ?? []).length === 1],
  ['关闭了宿主自动设置页（改用自带 plugins.item 卡片）', registered.settingsPolicy?.presentation?.auto === false],
  ['设置页策略挂在插件自身的 fiber 上', registered.settingsPolicy?.owner === ctx.fiber],
  ['Config 恰好 14 个 volatile 字段（= 设置页可见项）', JSON.stringify(volatileLeafNames()) === JSON.stringify([
    'enabled', 'intervalMessages', 'intervalSeconds', 'verificationMode', 'floatingWindow',
    'enforce', 'rounds', 'countMin', 'countMax', 'timeoutMs', 'minMatchConfidence',
    'detailBelowConfidence', 'injectVerdict', 'injectOnMatch'])],
  ['高级项刻意保持非 volatile（不进设置页）', !volatileLeafNames().includes('maxTokens')
      && !volatileLeafNames().includes('modelAliases') && !volatileLeafNames().includes('bankPath')],
  ['Config 可序列化给界面渲染', typeof Config?.toJSON === 'function'],
  ['工具 status 可用', statusResult.status === 'match'],
  ['工具 status 报出生效轮数与取数区间', statusResult.rounds === 3 && statusResult.countMin === 218 && statusResult.countMax === 400],
  ['配置改动重新 apply 后运行期配置随之更新（loader reconcile 路径）',
    afterSettings.rounds === 5 && afterSettings.countMin === 250 && afterSettings.countMax === 260
    && afterSettings.silentWhenUnknown === true],
  ['工具 recheck 可用', recheckResult.status === 'match'],
  ['命令 help 可用', true],
  ['命令 bank 列出更新后的模型数', (await command.handler({ agent, rawInput: 'bank', signal: new AbortController().signal })).text.includes(`${bank.models.length} 个模型`)],
  ['组卷可复现', reproducible],
  ['不同 seed 措辞不同', differs],
  ['多语言模板齐备', LANGUAGES.length === 10],
  ['默认取数全部落在 218..400', defaultCounts.every((n) => n >= 218 && n <= 400)],
  ['取数是随机的（不同 seed 不同组）', JSON.stringify(planRounds({ rounds: 3, seed: 12345 }).map((p) => p.count))
      !== JSON.stringify(planRounds({ rounds: 3, seed: 999 }).map((p) => p.count))],
  ['轮数上限为 5', planRounds({ rounds: 5, seed: 3 }).length === 5],
  ['轮数下限为 1', planRounds({ rounds: 1, seed: 3 }).length === 1],
  ['取证数区间被夹在合法范围', planRounds({ rounds: 2, countMin: 1, countMax: 9999, seed: 3 }).every((p) => p.count >= 218 && p.count <= 400)],
  ['默认通道全为 clean（空上下文）', allClean],
  ['探针正文里写明了目标个数', defaultPromptHasCount],
  ['取数下限 218 与上限 400 都能原样写进提示词', [218, 400].every((n) => {
    const probe = composeProbe({ language: 'zh', count: n, seed: 11 });
    return JSON.stringify(probe).includes(String(n));
  })],
  ['每轮取数确实互不相同（100 轮内不止 1 个取值）', new Set(
    planRounds({ rounds: 5, seed: 2024 }).map((p) => p.count)).size > 1],
  ['按默认取数仍能判出模型', analysisFromRequested.prediction === 'gpt-5.4'],
  ['评分判定正确', analysis.prediction === 'gpt-5.4' && analysis.probability > 0.9],
];

console.log('\n=== 断言 ===');
let ok = true;
for (const [label, pass] of checks) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) ok = false;
}
console.log(ok ? '\n全部通过。' : '\n存在失败。');
process.exit(ok ? 0 : 1);
