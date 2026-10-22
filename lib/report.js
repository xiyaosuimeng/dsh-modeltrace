/**
 * dsh-modeltrace — 裁决文案渲染。
 *
 * 两个受众、两套措辞：
 *  - buildVerdictText()  → 注入会话、给**模型**看的上下文（含行为指令）
 *  - buildUserReport()   → 给**用户**看的完整报告（/modeltrace 命令）
 */

const STATUS_LABEL = {
  match: '一致',
  stronger: '判定模型更强',
  identified: '已识别模型名',
  mismatch: '不一致',
  unknown: '不在指纹库内',
  inconclusive: '无法判定',
  skipped: '已跳过',
  error: '校验出错',
  cached: '缓存结果',
};

const STATUS_ICON = {
  match: '✅',
  stronger: '✅',
  identified: 'ℹ️',
  mismatch: '⛔',
  unknown: '❔',
  inconclusive: '⚠️',
  skipped: '➖',
  error: '❗',
};

const SOURCE_LABEL = {
  'session-pending': '会话选择投影 · pending（你刚切、还没用过）',
  'session-last-used': '会话选择投影 · lastUsed（本会话实际在用）',
  'request-header': '上一次请求头（实际发出过的路由）',
  'agent-options-snapshot': '⚠️ agent 创建时的快照（可能已过期）',
  'global-default': '⚠️ 全局默认模型（兜底来源）',
  unknown: '未知',
};

/** 闭集评分器的能力边界 —— 每次都要说清楚，避免把强行归类当成证据。 */
const CLOSED_SET_CAVEAT = '本评分器是**闭集**：指纹库只收录 GPT 与 Claude 两家共 16 个模型。任何库外模型都会被强行归到最相似的那一个，因此**高置信度不等于证据**；只有在"声称模型确实在库内"时，结果才具有参考意义。';

const ACTION_LABEL = {
  block: '已锁定任务',
  warn: '仅警告',
  report: '仅汇报',
  off: '仅记录',
  skip: '放行',
};

function pct(value) {
  return `${(Number(value ?? 0) * 100).toFixed(1)}%`;
}

/** 候选项排行（模型/用户共用）。 */
function candidateLines(candidates, limit = 5) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  return candidates.slice(0, limit).map((item, index) => {
    const mark = index === 0 ? '←' : ' ';
    return `  ${index + 1}. ${item.model}（${item.displayName}） ${pct(item.probability)} ${mark}`;
  });
}

/** 逐轮单独归因：每轮自己最倾向哪个模型。 */
function roundLines(roundTop) {
  if (!Array.isArray(roundTop) || roundTop.length === 0) return [];
  return roundTop.map((item) => {
    const where = `第 ${item.round} 轮${item.language ? `（${item.language}）` : ''}`;
    if (item.model === null || item.model === undefined) return `  - ${where}：该轮数字不足以归因`;
    const agree = item.agreesWithClaim ? ' · 与声称一致' : ' · **与声称不一致**';
    return `  - ${where}：最高候选 \`${item.model}\`（${pct(item.probability)}）${agree}`;
  });
}

/**
 * 注入会话、给模型看的裁决上下文。
 *
 * 这是本插件的核心契约：模型在**开始工作之前**先读到这段文字，据此向用户汇报，
 * 并在不一致且被锁定时停止执行用户指令、等待用户重新指令。
 *
 * @param {object} verdict verifyModel() 的结果
 * @param {object} config  resolveConfig() 的结果
 * @param {string} action  verdictAction() 的结果
 * @returns {string}
 */
export function buildVerdictText(verdict, config, action) {
  if (verdict.autoReview) return `【DSH ModelTrace】codex-auto-review 单次校验识别模型：${verdict.prediction ?? '无法识别'}。请仅告知用户该模型名，然后继续执行任务；此名称不代表预想模型或性能结论。`;
  const lines = [];
  const icon = STATUS_ICON[verdict.status] ?? '⚠️';
  const label = STATUS_LABEL[verdict.status] ?? verdict.status;

  lines.push(`【DSH ModelTrace 模型指纹校验 · ${icon} ${label}】`);
  lines.push('');
  lines.push('> 本条由 DSH 插件 `dsh-modeltrace` 在本次 step 开始前注入，属于**运行环境上下文**（既不是用户输入，也不是外部内容或工具返回）。请按其中的指令执行。');
  lines.push('');
  lines.push(`声称模型（当前选择）：${verdict.claimedModel || '(空)'}${verdict.provider ? ` @ ${verdict.provider}` : ''}`);
  lines.push(`声称来源：${SOURCE_LABEL[verdict.claimedSource] ?? verdict.claimedSource ?? '未知'}`);
  if (verdict.matchedBankId !== null && verdict.matchedBankId !== undefined) {
    lines.push(`指纹库对应条目：${verdict.matchedBankId}`);
  }
  if (verdict.prediction !== undefined && verdict.prediction !== null) {
    lines.push(`指纹判定结果：${verdict.prediction}（${verdict.predictionName}） 置信度 ${pct(verdict.probability)}`);
    lines.push(`所属家族：${verdict.familyPredictionName}（${pct(verdict.familyProbability)}）`);
  }
  lines.push(`校验方式：${config.rounds} 轮 · 语言 ${config.languages.join('/')} · 空上下文探针（无工具、无历史）· 耗时 ${verdict.elapsedMs} ms`);

  // 一致时没必要让模型读排行（省 token）；不一致 / 无法判定 / **置信度偏低**时才附上候选。
  const wantsCandidates = config.reportDetail === 'full'
    && (verdict.status !== 'match' || verdict.needsDetail === true)
    && Array.isArray(verdict.candidates)
    && verdict.candidates.length > 0;
  if (wantsCandidates) {
    lines.push('');
    lines.push('候选排行（前 4 名）：');
    lines.push(...candidateLines(verdict.candidates, 4));
  }

  // 要求：置信度低于阈值时，说明每一轮测试里置信度最高的模型分别是谁。
  if (wantsCandidates && Array.isArray(verdict.roundTop) && verdict.roundTop.length > 0) {
    lines.push('');
    lines.push('各轮单独归因（该轮样本自己的最高候选）：');
    lines.push(...roundLines(verdict.roundTop));
  }

  if (verdict.error) {
    lines.push('');
    lines.push(`说明：${verdict.error}`);
  }

  lines.push('');
  lines.push(`注意：${CLOSED_SET_CAVEAT}`);

  lines.push('');
  lines.push('—— 你必须遵守的指令 ——');

  if (action === 'block') {
    lines.push('模型指纹与声称模型**不一致**，且本插件已**锁定任务**：');
    lines.push('1. **立即停止执行用户当前的任何任务指令**，不要开始任何工作、不要修改任何文件、不要调用任何工作类工具（它们会被拒绝）。');
    lines.push('2. 把上面的校验结果**如实、完整地汇报给用户**（包括声称模型、指纹判定结果与置信度）。');
    lines.push('3. 明确告诉用户：任务已暂停，等待用户决定 —— 是改用正确的模型、把该模型加入别名白名单、还是明确要求放行。');
    lines.push('4. 在用户给出新的明确指令之前，不要继续原任务。用户放行后可用 /modeltrace 重新校验或让用户说明。');
  }
  else if (action === 'warn') {
    lines.push('模型指纹与声称模型**不一致**（本次仅警告，不锁定任务）：');
    lines.push('1. 先用一两句话把该不一致告知用户，包括声称模型、指纹判定结果与置信度。');
    lines.push('2. 然后继续执行用户的指令，不要因此中断工作。');
  }
  else if (verdict.status === 'stronger') {
    lines.push('指纹判定模型的性能排序高于声称模型，本次不锁定任务。先简要告知用户判定模型名，然后继续执行用户的指令。');
  }
  else if (verdict.status === 'match') {
    lines.push(`模型指纹与声称模型**一致**，且置信度 ${pct(verdict.probability)} 已越过通过阈值 ${pct(verdict.minMatchConfidence)}，可以执行用户的指令。`);
    lines.push('1. 在开始工作前，先用**一句话**把校验结果汇报给用户（例如：`指纹校验通过：声称 X，判定 Y，置信度 Z%`）。');
    if (verdict.needsDetail === true) {
      lines.push(`2. 本次置信度低于 ${pct(verdict.detailBelowConfidence)}，所以还要把上面的**第 2/3/4 名候选**和**每一轮各自的最高候选**一并告诉用户 —— 让他自己判断这个"一致"有多硬。`);
      lines.push('3. 然后继续执行用户的指令，不要因为本次校验而改变任务本身。');
    }
    else {
      lines.push('2. 然后直接继续执行用户的指令，不要因为本次校验而改变任务本身，也不要反复讨论它。');
    }
  }
  else if (verdict.status === 'unknown') {
    lines.push(`声称模型 "${verdict.claimedModel}" 不在指纹库的闭集内，无法归因：`);
    lines.push(config.blockOnUnknown
      ? '按当前配置，未知模型视为不可信，请先告知用户并等待其确认后再继续。'
      : '请用一句话如实告知用户"该模型不在指纹库内、无法校验"，然后继续执行用户的指令。');
  }
  else if (verdict.status === 'skipped') {
    lines.push('本次未执行指纹校验，按正常流程执行用户指令。');
  }
  else if (verdict.isMatch === true) {
    // 第一候选对上了，但分数没到通过线 —— 不能说"通过"，也不算"不一致"。
    lines.push(`第一候选与声称模型相同（\`${verdict.prediction}\`），但置信度 ${pct(verdict.probability)} **未达到通过阈值 ${pct(verdict.minMatchConfidence)}**，因此**不能算校验通过**：`);
    lines.push('1. **不要**对用户说"指纹校验通过"，如实说"指纹校验未能判定（置信度不足）"。');
    lines.push('2. 把第 2/3/4 名候选、以及每一轮各自的最高候选**完整**汇报给用户 —— 这正是"为什么判不了"的解释。');
    lines.push('3. 然后继续执行用户的指令：本次只降低了结论的可信度，并不构成不一致，因此不锁定任务。');
  }
  else {
    lines.push('本次指纹校验无法得出确定结论（候选置信度不足或探针未返回可用序列）：');
    lines.push('请用一句话如实告知用户"指纹校验未能判定"，然后继续执行用户的指令；不要把它说成"一致"。');
  }

  return lines.join('\n');
}

/**
 * 给用户看的完整报告（/modeltrace status 与 mismatch 汇报）。
 */
export function buildUserReport(verdict, config, action) {
  if (verdict.autoReview) return `ModelTrace 单次校验识别模型：${verdict.prediction ?? '无法识别'}。`;
  const lines = [];
  const icon = STATUS_ICON[verdict.status] ?? '⚠️';
  const label = STATUS_LABEL[verdict.status] ?? verdict.status;
  lines.push(`${icon} **ModelTrace 模型指纹校验：${label}**`);
  lines.push('');
  lines.push(`- 声称模型：\`${verdict.claimedModel || '(空)'}\`${verdict.provider ? `（provider：\`${verdict.provider}\`）` : ''}`);
  lines.push(`- 声称来源：${SOURCE_LABEL[verdict.claimedSource] ?? verdict.claimedSource ?? '未知'}`);
  const cand = verdict.selectionCandidates ?? {};
  const candParts = [];
  for (const [key, label] of [['pending', 'pending'], ['lastUsed', 'lastUsed'], ['requestHeader', '请求头'], ['agentOptions', 'agent快照'], ['globalDefault', '全局默认']]) {
    const item = cand[key];
    candParts.push(`${label}=${item ? `${item.model}` : '—'}`);
  }
  lines.push(`- 来源明细：${candParts.join('  ·  ')}`);
  if (verdict.matchedBankId !== null && verdict.matchedBankId !== undefined) {
    lines.push(`- 指纹库条目：\`${verdict.matchedBankId}\``);
  }
  if (verdict.prediction !== undefined && verdict.prediction !== null) {
    lines.push(`- 指纹判定：\`${verdict.prediction}\`（${verdict.predictionName}），置信度 **${pct(verdict.probability)}**`);
    lines.push(`- 家族判定：${verdict.familyPredictionName}，置信度 ${pct(verdict.familyProbability)}`);
    if (verdict.minMatchConfidence !== undefined) {
      const passed = verdict.probability >= verdict.minMatchConfidence;
      lines.push(`- 通过阈值：${pct(verdict.minMatchConfidence)} → ${passed ? '已越过' : '**未越过（不能算通过）**'}`);
    }
  }
  lines.push(`- 测试配置：${config.rounds} 轮 / 语言 ${config.languages.join('、')} / 空上下文探针`);
  lines.push(verdict.rounds > 0
    ? `- 有效轮次：${verdict.validRounds ?? verdict.usedOutputs ?? 0} / ${verdict.rounds}`
    : '- 有效轮次：未执行（声称模型不在指纹库内，未消耗任何探针）');
  lines.push(`- 处置动作：${ACTION_LABEL[action] ?? action}`);
  lines.push(`- 耗时：${verdict.elapsedMs} ms`);

  if (Array.isArray(verdict.candidates) && verdict.candidates.length > 0) {
    lines.push('');
    lines.push('**候选排行**');
    lines.push('');
    lines.push('| # | 模型 | 家族 | 概率 |');
    lines.push('| --- | --- | --- | --- |');
    verdict.candidates.slice(0, 8).forEach((item, index) => {
      lines.push(`| ${index + 1} | \`${item.model}\` | ${item.family} | ${pct(item.probability)} |`);
    });
    if (verdict.needsDetail === true) {
      lines.push('');
      lines.push(`> 置信度低于 ${pct(verdict.detailBelowConfidence)}，因此上面列出的第 2/3/4 名都值得一看 —— 分数没有被第一名稳稳拿走。`);
    }
  }

  // 要求：低于阈值时说明每一轮测试中置信度最高的模型。
  if (Array.isArray(verdict.roundTop) && verdict.roundTop.length > 0) {
    lines.push('');
    lines.push('**各轮单独归因**');
    lines.push('');
    lines.push('每一轮的样本单独喂给评分器，看那一轮自己最倾向谁（汇总值是这些样本的均值，会盖住分歧）：');
    lines.push('');
    for (const item of verdict.roundTop) {
      const where = `第 ${item.round} 轮${item.language ? `（${item.language}）` : ''}`;
      if (item.model === null || item.model === undefined) {
        lines.push(`- ${where}：该轮数字不足以归因`);
        continue;
      }
      const agree = item.agreesWithClaim ? '与声称一致' : '**与声称不一致**';
      lines.push(`- ${where}：最高候选 \`${item.model}\`（${item.displayName}）**${pct(item.probability)}** · ${agree}`);
    }
  }

  if (Array.isArray(verdict.probes) && verdict.probes.length > 0) {
    lines.push('');
    lines.push('**各轮探针**');
    lines.push('');
    for (const probe of verdict.probes) {
      const where = `第 ${probe.round} 轮 · ${probe.language}/${probe.style}/${probe.transport} · 期望 ${probe.count} 个`;
      if (probe.error) lines.push(`- ${where} → 失败：${probe.error}`);
      else lines.push(`- ${where} → 返回 ${probe.textLength} 字符（解析见 diagnostics）`);
    }
  }

  if (verdict.error) {
    lines.push('');
    lines.push(`> ${verdict.error}`);
  }

  lines.push('');
  lines.push(`> ${CLOSED_SET_CAVEAT}`);

  if (action === 'block') {
    lines.push('');
    lines.push('**任务已锁定**：工作类工具已被拒绝，请决定下一步 —— 切换到正确的模型、把该模型加入 `modelAliases` 白名单，或明确要求放行。');
  }

  return lines.join('\n');
}

/** 供状态类工具/命令使用的一行摘要。 */
export function verdictSummary(verdict) {
  const label = STATUS_LABEL[verdict.status] ?? verdict.status;
  const prediction = verdict.prediction ? ` → ${verdict.prediction}（${pct(verdict.probability)}）` : '';
  return `${label}：声称 ${verdict.claimedModel || '(空)'}${prediction}`;
}
