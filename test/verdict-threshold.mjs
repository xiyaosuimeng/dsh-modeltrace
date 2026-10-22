/**
 * 判定阈值回归测试 —— 钉住用户报的那个 bug：
 *
 *   「55.1 置信率也能过？」
 *
 * 历史实现是 `const status = isMatch ? 'match' : ...`，只看第一候选跟声称模型
 * 是否同名，完全不看分数。于是 55.1%（意味着 44.9% 的概率分散在别的候选上）
 * 也被报成「指纹校验通过」。
 *
 * 这里分三层钉：
 *   1. decideStatus()          —— 纯函数，概率侧的门槛
 *   2. buildVerdictText()      —— 喂给模型的指令里不能说"通过"
 *   3. buildUserReport()       —— 用户报告里要有第 2/3/4 名 + 逐轮最高
 * 全部用合成 verdict，不联网、不跑真实探针。
 */
import assert from 'node:assert/strict';
import { resolveConfig } from '../lib/config.js';
import { decideStatus, verdictAction } from '../lib/verify.js';
import { buildVerdictText, buildUserReport } from '../lib/report.js';

const config = resolveConfig({ rounds: 3, enforce: 'block' });

let passed = 0;
function step(label, detail) {
  passed += 1;
  console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// 1. decideStatus：概率侧的门槛
// ---------------------------------------------------------------------------
// 用户实测的那一条：第一候选 = 声称 gpt-5.6-sol，概率 55.1%。
// 修好之后必须**不是** match（55.1% < 默认通过线 80%）。
{
  const r = decideStatus({ isMatch: true, probability: 0.551 }, config);
  assert.equal(r.status, 'inconclusive', '55.1% + 第一候选对上 → 必须 inconclusive，不能是 match');
  assert.equal(r.isMatch, undefined, 'decideStatus 不返回 isMatch（它由调用方合并）');
  assert.equal(r.strongEnough, false, '55.1% 未越过 80% 的通过线');
  step('55.1% 即使第一候选对上也不算通过', `status=${r.status}`);
}

// 边界：恰好等于阈值算通过（>= 语义），差一点点就不算。
{
  assert.equal(decideStatus({ isMatch: true, probability: 0.8 }, config).status, 'match', '恰好 80% 算通过（>=）');
  assert.equal(decideStatus({ isMatch: true, probability: 0.7999 }, config).status, 'inconclusive', '79.99% 不算通过');
  step('通过线是闭区间下界 80%', '0.8 → match / 0.7999 → inconclusive');
}

// 阈值可配置：把通过线降到 0.5，同一个 55.1% 就变成通过。
{
  const loose = resolveConfig({ rounds: 3, minMatchConfidence: 0.5 });
  assert.equal(decideStatus({ isMatch: true, probability: 0.551 }, loose).status, 'match', '放宽到 50% 后 55.1% 通过');
  step('通过线可配置', 'minMatchConfidence=0.5 时 55.1% → match');
}

// 非一致侧不受新阈值影响：第一候选是别人 + 高概率 = mismatch。
{
  assert.equal(decideStatus({ isMatch: false, probability: 0.99 }, config).status, 'mismatch', '第一候选是别的模型 → mismatch');
  assert.equal(decideStatus({ isMatch: false, probability: 0.2 }, config).status, 'inconclusive', '低概率 + 对不上 → inconclusive');
  step('不一致侧语义未变', 'isMatch=false 时不经过 minMatchConfidence');
}

// ---------------------------------------------------------------------------
// 构造一个"用户报的那种" verdict：75% 通过线之上不算、90% 明细线之下的灰区
// ---------------------------------------------------------------------------
const CANDIDATES = [
  { model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', family: 'gpt', probability: 0.551 },
  { model: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', family: 'gpt', probability: 0.241 },
  { model: 'gpt-6-sol', displayName: 'GPT-6 Sol', family: 'gpt', probability: 0.118 },
  { model: 'claude-opus-5', displayName: 'Claude Opus 5', family: 'claude', probability: 0.052 },
  { model: 'gpt-5.4', displayName: 'GPT-5.4', family: 'gpt', probability: 0.021 },
];

const ROUND_TOP = [
  { round: 1, language: '英文', style: 'json', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', probability: 0.72, agreesWithClaim: true },
  { round: 2, language: '中文', style: 'zh', model: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', probability: 0.44, agreesWithClaim: false },
  { round: 3, language: '英文', style: 'en', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', probability: 0.49, agreesWithClaim: true },
];

const verdict = {
  status: 'inconclusive',
  isMatch: true,
  strongEnough: false,
  needsDetail: true,
  claimedModel: 'gpt-5.6-sol',
  prediction: 'gpt-5.6-sol',
  predictionName: 'GPT-5.6 Sol',
  probability: 0.551,
  familyPrediction: 'gpt',
  familyPredictionName: 'GPT',
  familyProbability: 0.962,
  minConfidence: 0.5,
  minMatchConfidence: 0.8,
  detailBelowConfidence: 0.9,
  rounds: 3,
  validRounds: 3,
  candidates: CANDIDATES,
  roundTop: ROUND_TOP,
  elapsedMs: 1234,
};

// ---------------------------------------------------------------------------
// 2. buildVerdictText：给模型的指令不能说"通过"
// ---------------------------------------------------------------------------
{
  const text = buildVerdictText(verdict, config, 'proceed');
  const lines = text.split('\n');

  // 标题是模型最先看到的东西，不能写"通过"。
  const header = lines.find((line) => line.startsWith('【'));
  assert.ok(header !== undefined, '裁决文本必须有标题行');
  assert.ok(!header.includes('通过'), `标题不得写"通过"（实际：${header}）`);
  assert.ok(header.includes('无法判定'), '标题要写明无法判定');

  // 肯定语气地宣称"校验通过"是不允许的；但"不要对用户说校验通过"这种
  // **引述否定**是对的，必须放行 —— 早先版本的断言把两者混为一谈。
  assert.ok(!text.includes('模型指纹与声称模型**一致**'), '分数不够时不能判"一致"');
  const affirmative = lines.filter((line) => /校验通过/.test(line) && !/不要|不能算|不算/.test(line));
  assert.equal(affirmative.length, 0, `不得出现肯定的"校验通过"字样：${affirmative.join(' | ')}`);
  assert.ok(/不要.*校验通过/.test(text), '要明确禁止模型对用户说"通过"');

  assert.ok(text.includes('未能判定'), '必须明确说"未能判定"');
  assert.ok(text.includes('55.1%'), '必须报出实际置信度');
  assert.ok(text.includes('80.0%'), '必须报出通过阈值，用户才知道差多少');

  // 第 2/3/4 名必须出现在给模型的指令里，否则模型没法转述。
  for (const id of ['gpt-5.6-terra', 'gpt-6-sol', 'claude-opus-5']) {
    assert.ok(text.includes(id), `候选 ${id} 必须出现在裁决文本里`);
  }
  // 每一轮的最高候选也要有。
  assert.ok(text.includes('各轮单独归因'), '必须有逐轮小节');
  for (const line of ['第 1 轮', '第 2 轮', '第 3 轮']) {
    assert.ok(text.includes(line), `${line} 的归因必须出现`);
  }
  assert.ok(text.includes('0.44') || text.includes('44.0%'), '逐轮要带概率');

  // 语义要点：不算不一致，所以不能锁任务。
  assert.ok(!/不要执行|等待用户/.test(text), '置信度不足不构成不一致，不能指示模型停下来等指令');
  step('55.1% 的裁决文本：不称通过、带候选明细、不锁任务', text.split('\n').filter((l) => l.includes('未能判定'))[0]?.slice(0, 60));
}

// 真正的 match（100%）仍然要正常放行，而且为了省 token 不该附候选。
{
  const good = { ...verdict, status: 'match', strongEnough: true, needsDetail: false, probability: 1, candidates: CANDIDATES, roundTop: [] };
  const text = buildVerdictText(good, config, 'proceed');
  assert.ok(text.includes('模型指纹与声称模型**一致**'), '高置信度仍要判一致');
  assert.ok(text.includes('100.0%'), '报出 100%');
  assert.ok(!text.includes('候选排行'), '一致且高置信度时不附候选排行（省 token）');
  assert.ok(!text.includes('各轮单独归因'), '一致且高置信度时不附逐轮归因');
  step('100% 一致：照常放行且不附候选', '无候选排行 / 无逐轮归因');
}

// 一致但低于 90%（例如 92% 之上不列、85% 要列）
{
  const mid = { ...verdict, status: 'match', strongEnough: true, needsDetail: true, probability: 0.85 };
  const text = buildVerdictText(mid, config, 'proceed');
  assert.ok(text.includes('模型指纹与声称模型**一致**'), '85% 越过 80% 通过线 → 判一致');
  assert.ok(text.includes('候选排行'), '85% < 90% 明细线 → 仍要附候选');
  assert.ok(text.includes('各轮单独归因'), '85% < 90% 明细线 → 仍要附逐轮');
  step('85% 一致但低于明细线：附候选与逐轮', '越过通过线、未越过明细线');
}

// ---------------------------------------------------------------------------
// 3. buildUserReport：用户看到的那份
// ---------------------------------------------------------------------------
{
  const report = buildUserReport(verdict, config, 'proceed');

  assert.ok(report.includes('通过阈值'), '用户报告要显示通过阈值这一行');
  assert.ok(/未越过/.test(report), '要明确标出"未越过（不能算通过）"');
  assert.ok(report.includes('55.1%'), '显示实际置信度');

  // 第 2/3/4 名：表格里要有前三名以外的行。
  assert.ok(report.includes('gpt-5.6-terra'), '第 2 名必须在用户报告里');
  assert.ok(report.includes('gpt-6-sol'), '第 3 名必须在用户报告里');
  assert.ok(report.includes('claude-opus-5'), '第 4 名必须在用户报告里');

  // 逐轮小节 + 每轮的最高候选。
  assert.ok(report.includes('各轮单独归因'), '用户报告要有逐轮小节');
  assert.ok(report.includes('第 1 轮（英文）'), '逐轮要标出轮次与语言');
  assert.ok(report.includes('第 2 轮（中文）'), '含中文轮');
  assert.ok(report.includes('第 3 轮（英文）'), '含英文轮');
  assert.ok(/与声称不一致/.test(report), '第 2 轮指向 terra，要标出与声称不一致');
  step('用户报告：候选明细 + 逐轮最高候选', report.split('\n').filter((l) => l.includes('通过阈值'))[0]?.trim().slice(0, 70));
}

// 某轮无法归因时不崩。
{
  const withGap = {
    ...verdict,
    roundTop: [ROUND_TOP[0], { round: 2, language: '中文', model: null, probability: null, agreesWithClaim: false }, ROUND_TOP[2]],
  };
  const modelText = buildVerdictText(withGap, config, 'proceed');
  const userText = buildUserReport(withGap, config, 'proceed');
  assert.ok(modelText.includes('该轮数字不足以归因'), '模型侧要标明该轮无法归因');
  assert.ok(userText.includes('该轮数字不足以归因'), '用户侧要标明该轮无法归因');
  step('某轮无法归因时不崩', 'model=null → 明确标注');
}

// 用户第二次实测的那一条：2 轮，第一候选 = 声称 gpt-6-astra，置信度 64.2%。
// 同样必须判 inconclusive，并且**两轮**各自归因都要出现（截图里恰好两样都缺）。
{
  assert.equal(
    decideStatus({ isMatch: true, probability: 0.642 }, resolveConfig({ rounds: 2 })).status,
    'inconclusive',
    '64.2% + 两轮 + 第一候选对上 → 仍然不算通过'
  );
  const two = {
    ...verdict,
    rounds: 2,
    validRounds: 2,
    claimedModel: 'gpt-6-astra',
    prediction: 'gpt-6-astra',
    predictionName: 'GPT-6 Astra',
    probability: 0.642,
    candidates: [
      { model: 'gpt-6-astra', displayName: 'GPT-6 Astra', family: 'gpt', probability: 0.642 },
      { model: 'gpt-6-sol', displayName: 'GPT-6 Sol', family: 'gpt', probability: 0.171 },
      { model: 'gpt-6-luna', displayName: 'GPT-6 Luna', family: 'gpt', probability: 0.093 },
      { model: 'claude-opus-5', displayName: 'Claude Opus 5', family: 'claude', probability: 0.041 },
    ],
    roundTop: [
      { round: 1, language: '中文', model: 'gpt-6-astra', displayName: 'GPT-6 Astra', probability: 0.71, agreesWithClaim: true },
      { round: 2, language: '英文', model: 'gpt-6-sol', displayName: 'GPT-6 Sol', probability: 0.55, agreesWithClaim: false },
    ],
  };
  for (const [name, text] of [['模型侧', buildVerdictText(two, config, 'proceed')], ['用户侧', buildUserReport(two, config, 'proceed')]]) {
    assert.ok(text.includes('第 1 轮') && text.includes('第 2 轮'), `${name}必须给出两轮各自的最高候选`);
    assert.ok(text.includes('gpt-6-sol') && text.includes('gpt-6-luna') && text.includes('claude-opus-5'), `${name}必须给出第 2/3/4 名`);
    assert.ok(!/\*\*一致\*\*/.test(text), `${name}不得把它说成"一致"`);
  }
  assert.ok(
    buildVerdictText(two, config, 'proceed').includes('未能判定'),
    '两轮 64.2% 也必须明说"未能判定"'
  );
  step('2 轮 64.2%（截图那一条）：不称通过 + 两轮归因 + 第 2/3/4 名', 'gpt-6-astra 64.2% → inconclusive');
}

// ---------------------------------------------------------------------------
// 4. verdictAction：用户选定的策略 —— 分数不够**不锁任务**（可选择性收紧）
// ---------------------------------------------------------------------------
{
  // 默认：第一候选对上但分数不够 → report，不锁。
  assert.equal(verdictAction(verdict, config), 'report', '默认 weakMatchAction=report：不锁定任务');
  assert.notEqual(verdictAction(verdict, config), 'block', '绝不能在默认配置下锁住用户的活');
  step('默认策略：分数不够只汇报、不锁任务', 'inconclusive + isMatch → report');

  // 「压根没看出所以然」（第一候选是别人、分数又低）同样不锁，且不受 weakMatchAction 影响。
  const vague = { ...verdict, isMatch: false };
  const strict = resolveConfig({ rounds: 3, weakMatchAction: 'block', enforce: 'block' });
  assert.equal(verdictAction(vague, strict), 'report', '没有可收紧对象的 inconclusive 不受 weakMatchAction 影响');
  step('模糊的 inconclusive 不受收紧开关影响', 'isMatch=false → 始终 report');

  // 可选收紧：weakMatchAction=block 时，和 mismatch 走同一套 enforce 映射。
  assert.equal(verdictAction(verdict, strict), 'block', 'weakMatchAction=block + enforce=block → 锁');
  assert.equal(
    verdictAction(verdict, resolveConfig({ rounds: 3, weakMatchAction: 'block', enforce: 'warn' })),
    'warn',
    'weakMatchAction=block + enforce=warn → 只警告'
  );
  assert.equal(
    verdictAction(verdict, resolveConfig({ rounds: 3, weakMatchAction: 'block', enforce: 'off' })),
    'report',
    'enforce=off 时收紧开关也不生效'
  );
  step('可选收紧：weakMatchAction=block 沿用 enforce 映射', 'block / warn / off → block / warn / report');

  // 真正的 match 一定是 skip（不锁、不警告）。
  assert.equal(verdictAction({ ...verdict, status: 'match' }, config), 'skip', 'match → skip');
  // 真正的 mismatch 依旧按 enforce 走。
  assert.equal(verdictAction({ ...verdict, status: 'mismatch', isMatch: false }, config), 'block', 'mismatch → block');
  step('match / mismatch 语义未变', 'match → skip；mismatch → block');
}

console.log(`\n判定阈值回归测试全部通过（${passed} 组）。`);
