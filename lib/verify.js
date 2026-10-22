/**
 * dsh-modeltrace — 校验引擎。
 *
 * 职责：在**完全隔离的上下文**里向当前模型发若干道数值挑战，用 ModelTrace 的
 * 统一全局稳健数字指纹评分器（lib/scorer.js）判归属，再与用户当前选择的模型
 * 名称（provider-owned model id，非显示名称）比对，产出一个可复现的裁决对象。
 *
 * "上下文为空"的实现要点：探针只带一条 user 消息（必要时再加一条 system 噪声），
 * 不带任何工具 schema、不带会话历史、不带 skill 注入 —— 这正是省钱的关键。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { analyzeGlobalOutputs } from './scorer.js';
import { runSessionProbe } from './session-probe.js';
import { composeProbe, planRounds, resolveTemplates, seedFrom } from './prompts.js';

export const PLUGIN = 'dsh-modeltrace';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BANK_PATH = join(HERE, '..', 'assets', 'unified_bank.json');

/** 指纹库缓存，按路径存放（同一进程内只解析一次）。 */
const bankCache = new Map();

/** 读取并解析指纹库；同一路径只读一次。 */
export function loadBank(config = {}) {
  const path = config.bankPath && config.bankPath.length > 0 ? config.bankPath : DEFAULT_BANK_PATH;
  if (bankCache.has(path)) return bankCache.get(path);
  const bank = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(bank.models) || bank.models.length === 0) {
    throw new Error(`dsh-modeltrace: 指纹库 ${path} 缺少 models 数组`);
  }
  bankCache.set(path, bank);
  return bank;
}

/** 已加载的指纹库模型 id 列表（供命令/工具列出）。 */
export function bankModelIds(bank) {
  return bank.models.map((model) => model.id);
}

/**
 * 归一化模型 id：小写、去 provider 前缀、统一分隔符、去掉常见的路由后缀。
 * 刻意**不**裁剪日期后缀 —— `claude-haiku-4-5-20251001` 这类 id 的日期是本体的一部分。
 */
export function normalizeModelId(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/^[a-z0-9_.-]+\//, '')
    .replace(/[_:](free|nitro|beta|latest|thinking|reasoning|preview)$/, '')
    .replace(/-latest$/, '');
}

/**
 * 把"用户当前选择的模型名称"映射到指纹库中的模型 id。
 * 顺序：显式别名表 → 归一化精确匹配。
 * @returns 库内模型 id，或 null（不在库内 = 闭集之外）
 */
export function matchBankModel(claimed, aliases, bank) {
  const raw = String(claimed ?? '').trim();
  if (raw.length === 0) return null;
  const ids = bankModelIds(bank);
  const target = normalizeModelId(raw);

  for (const [key, value] of Object.entries(aliases ?? {})) {
    if (normalizeModelId(key) === target && ids.includes(value)) return value;
  }
  const exact = ids.find((id) => normalizeModelId(id) === target);
  if (exact !== undefined) return exact;

  return null;
}

/** 取 LLM 运行时；服务缺席时给出可读错误而不是 undefined 解引用。 */
function llmOf(ctx) {
  let service;
  try {
    service = typeof ctx.get === 'function' ? ctx.get('llm') : undefined;
  }
  catch { /* ctx.get 在无该服务时可能抛错 */ }
  if (service === undefined || service === null) service = ctx.llm;
  if (service === undefined || service === null || typeof service.stream !== 'function') {
    throw new Error('dsh-modeltrace: LLM 服务（ctx.llm）不可用，无法执行指纹探针。');
  }
  return service;
}

/** 从组装好的内容块里取出纯文本。 */
function blocksToText(blocks) {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * 把任意抛出物变成一句能看的错误描述。
 * 之前的 `String(error)` 对普通对象会打出 `[object Object]`，等于没有诊断信息。
 */
export function describeError(error) {
  if (error instanceof Error) {
    const extra = [];
    if (error.code !== undefined) extra.push(`code=${error.code}`);
    if (error.status !== undefined) extra.push(`status=${error.status}`);
    return `${error.name}: ${error.message}${extra.length > 0 ? ` [${extra.join(', ')}]` : ''}`;
  }
  if (error === null || error === undefined) return String(error);
  if (typeof error === 'object') {
    const record = error;
    const message = typeof record.message === 'string' ? record.message : null;
    try {
      return message !== null ? `${message} ${JSON.stringify(error)}` : JSON.stringify(error);
    }
    catch { return Object.prototype.toString.call(error); }
  }
  return String(error);
}

/** 终止帧里的失败信息（适配器的 error/aborted 是 **finish 帧**，不会抛出）。 */
function finishFailure(finish) {
  if (finish === undefined || finish === null) return null;
  if (finish.kind !== 'error' && finish.kind !== 'aborted') return null;
  const failure = finish.failure ?? {};
  const parts = [failure.message ?? finish.kind];
  if (failure.code !== undefined) parts.push(`code=${failure.code}`);
  if (failure.status !== undefined) parts.push(`status=${failure.status}`);
  return `LLM ${finish.kind}: ${parts.join(' ')}`;
}

/**
 * 发一道探针并取回文本。
 * 只带一条 user 消息（可选一条 system 噪声），无工具、无历史 —— 空上下文。
 * @returns {Promise<{text: string, truncated: boolean, meta: object}>}
 */
async function runProbe(ctx, options) {
  const { provider, model, reasoningEffort, plan, templates, maxTokens, timeoutMs, signal } = options;
  const composed = composeProbe({ ...plan, templates });
  const messages = [createUserMessage({
    content: [{ type: 'text', text: composed.user }],
    source: { kind: `plugin:${PLUGIN}` },
  })];
  const signals = [];
  if (signal !== undefined) signals.push(signal);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  signals.push(timeoutSignal);
  const callSignal = AbortSignal.any(signals);

  // 刻意**不**传 sessionId：这是一次完全脱离会话的独立调用。
  // 既保证上下文为空（没有历史、没有工具、没有 skill、没有系统提示词），
  // 也保证探针回给我们的那几百个数字**不会**进入会话日志、不会出现在聊天框里。
  const request = {
    provider,
    model,
    messages,
    maxTokens,
    signal: callSignal,
  };
  if (composed.system.length > 0) request.system = composed.system;
  if (reasoningEffort !== undefined) request.reasoningEffort = reasoningEffort;

  const llm = llmOf(ctx);
  const assembler = new BlockAssembler();
  try {
    for await (const chunk of llm.stream(request)) {
      assembler.push(chunk);
    }
  }
  catch (error) {
    // 区分"自己超时/被取消"和"上游报错"，否则用户只会看到一句 AbortError。
    if (timeoutSignal.aborted && !(signal?.aborted === true)) {
      throw new Error(`探针超时（${timeoutMs} ms）`);
    }
    if (signal?.aborted === true) throw new Error('回合已被取消，探针中断');
    throw new Error(describeError(error));
  }

  // 适配器的失败是以 finish 帧送达的，不是抛异常 —— 不读就会把空文本当成"回答太短"。
  const failure = finishFailure(assembler.finish);
  if (failure !== null) throw new Error(failure);

  const text = blocksToText(assembler.blocks());
  return { text, truncated: assembler.finish?.kind === 'max-tokens', meta: composed.meta };
}

/**
 * 把「第一候选是否等于声称模型」+「概率」翻成裁决状态。
 *
 * 单独导出是为了让测试能直接钉住这条规则：历史上 `isMatch` 单独就判 'match'，
 * 于是 55.1% 也被报成「指纹校验通过」。现在「对上」只是必要条件，
 * 还必须越过 `minMatchConfidence`（默认 0.8）才算通过；够不上就如实报 inconclusive。
 */
export function modelStrength(id) {
  const name = normalizeModelId(id);
  const gpt = name.match(/^gpt-(\d+)(?:[.-](\d+))?(?:-(astra|sol|terra|luna))?(?:$|-)/);
  if (gpt) {
    const major = Number(gpt[1]);
    const minor = Number(gpt[2] ?? 0);
    if (major < 5 || (major === 5 && minor < 6)) return null;
    return { family: 'gpt', score: major * 1000 + minor * 10 + ({ astra: 4, sol: 3, terra: 2, luna: 1 }[gpt[3]] ?? 0) };
  }
  const claude = name.match(/^claude-(fable|opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?(?:$|-)/);
  if (claude) {
    const major = Number(claude[2]);
    const minor = Number(claude[3] ?? 0);
    // opus-5-5 高于 fable-5 与 fable-5-1。
    return { family: 'claude', score: major * 10000 + minor * 100 + ({ fable: 4, opus: 3, sonnet: 2, haiku: 1 }[claude[1]]) };
  }
  return null;
}

export function strongerThanClaim(prediction, claimed) {
  const actual = modelStrength(prediction);
  const expected = modelStrength(claimed);
  if (actual === null || expected === null || actual.family !== expected.family) return false;
  if (normalizeModelId(prediction) === 'claude-opus-5-5' && /^claude-fable-5(?:-1)?$/.test(normalizeModelId(claimed))) return true;
  return actual.score > expected.score;
}

export function decideStatus({ isMatch, probability, stronger = false }, config) {
  const confident = probability >= config.minConfidence;
  const strongEnough = probability >= config.minMatchConfidence;
  const status = isMatch
    ? (strongEnough ? 'match' : 'inconclusive')
    : (confident ? (stronger ? 'stronger' : 'mismatch') : 'inconclusive');
  return { status, confident, strongEnough };
}

/**
 * 执行一次完整校验（多轮探针 + 评分 + 比对）。
 *
 * @param {object} ctx        插件上下文（需要 ctx.llm）。
 * @param {object} options
 * @param {string} options.claimed    用户当前选择的模型名称（provider-owned id）
 * @param {string} options.provider   已注册的 provider 路由
 * @param {string} options.model      实际调用的模型 id（通常等于 claimed）
 * @param {string} [options.reasoningEffort]
 * @param {AbortSignal} [options.signal]
 * @param {object} options.config     resolveConfig() 的结果
 * @param {number} [options.seed]     固定组卷种子（测试用；缺省随机，使每次措辞不同）
 * @returns {Promise<object>} 裁决对象
 */
export async function verifyModel(ctx, options) {
  const { config } = options;
  const started = Date.now();
  const bank = options.bank ?? loadBank(config);
  const templates = resolveTemplates(config.templates);
  const claimedRaw = String(options.claimed ?? '');
  const autoReview = false;
  const matchedBankId = autoReview ? null : matchBankModel(claimedRaw, config.modelAliases, bank);

  const base = {
    status: 'inconclusive',
    claimedModel: claimedRaw,
    claimedSource: options.claimedSource ?? 'unknown',
    selectionCandidates: options.selectionCandidates ?? {},
    claimedNormalized: normalizeModelId(claimedRaw),
    matchedBankId,
    autoReview,
    provider: options.provider ?? '',
    model: options.model ?? '',
    probes: [],
    diagnostics: [],
    rounds: 0,
    validRounds: 0,
    elapsedMs: 0,
    error: null,
  };

  if (claimedRaw.trim().length === 0) {
    return { ...base, status: 'skipped', error: '没有可用的模型名称（模型选择为空）。', elapsedMs: Date.now() - started };
  }
  if (matchedBankId === null && !autoReview) {
    return {
      ...base,
      status: 'unknown',
      error: `声称的模型 "${claimedRaw}" 不在指纹库的 ${bank.models.length} 个模型之内（闭集归因无法判定）。`,
      elapsedMs: Date.now() - started,
    };
  }

  const seed = Number.isFinite(options.seed) ? Number(options.seed) : (Math.floor(Math.random() * 0xffffffff) >>> 0);
  const plans = planRounds({
    rounds: autoReview ? 1 : config.rounds,
    languages: config.languages,
    countMin: config.countMin,
    countMax: config.countMax,
    transports: config.transports,
    seed,
  });

  // 并行发探针：3 轮串行会把回合开头堵住近 70 秒（用户会以为卡死并点停止，
  // 一旦回合信号中断，后面的轮次就发不出去了，有效轮次只剩 1/3）。
  // 并行后总耗时≈最慢的一轮。可用 parallelProbes: false 换回串行（更保守、更慢）。
  const runOne = async (plan) => {
    if (options.signal?.aborted) return { plan, skipped: true };
    try {
      const executeProbe = config.verificationMode === 'session' ? runSessionProbe : runProbe;
      const probe = await executeProbe(ctx, {
        provider: options.provider,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        plan,
        templates,
        maxTokens: config.maxTokens,
        timeoutMs: config.timeoutMs,
        signal: options.signal,
        parentAgent: options.parentAgent,
      });
      return { plan, text: probe.text, truncated: probe.truncated, sessionId: probe.sessionId };
    }
    catch (error) {
      return { plan, error: describeError(error) };
    }
  };

  const settled = config.parallelProbes
    ? await Promise.all(plans.map(runOne))
    : await (async () => {
      const results = [];
      for (const plan of plans) results.push(await runOne(plan));
      return results;
    })();

  const outputs = [];
  const probeReports = [];
  let firstError = null;
  for (const item of settled) {
    const plan = item.plan;
    const where = {
      round: plan.round,
      language: plan.language,
      style: plan.style,
      transport: plan.transport,
      count: plan.count,
    };
    if (item.skipped === true) {
      probeReports.push({ ...where, error: '回合已取消，未发出' });
      continue;
    }
    if (item.error !== undefined) {
      if (firstError === null) firstError = item.error;
      ctx.logger?.warn?.('dsh-modeltrace: 第 %d 轮探针失败：%s', plan.round, item.error);
      probeReports.push({ ...where, error: item.error });
      continue;
    }
    const numbers = typeof item.text === 'string' ? item.text : '';
    outputs.push({ text: numbers, expected_count: plan.count });
    probeReports.push({
      ...where,
      // 只记录长度，不保存数字本身 —— 几百个数字不该出现在任何面向用户的输出里。
      textLength: numbers.length,
      ...(item.sessionId ? { sessionId: item.sessionId } : {}),
      ...(item.truncated === true ? { truncated: true } : {}),
    });
  }

  const withProbes = { ...base, probes: probeReports, rounds: plans.length };

  if (outputs.length === 0) {
    return {
      ...withProbes,
      status: 'inconclusive',
      error: firstError ?? '全部探针调用均未返回内容。',
      elapsedMs: Date.now() - started,
    };
  }

  let analysis = null;
  let analysisError = null;
  try {
    analysis = analyzeGlobalOutputs(outputs, bank);
  }
  catch (error) {
    analysisError = error instanceof Error ? error.message : String(error);
    // 合并样本被判为不可用时，退回逐份分析，取第一个可用结果。
    for (const output of outputs) {
      try {
        analysis = analyzeGlobalOutputs([output], bank);
        break;
      }
      catch { /* 继续尝试下一份 */ }
    }
  }

  if (analysis === null) {
    return {
      ...withProbes,
      status: 'inconclusive',
      error: analysisError ?? '没有可用回答：数字序列被拒答或严重截断。',
      diagnostics: [],
      elapsedMs: Date.now() - started,
    };
  }

  const prediction = analysis.prediction;
  const probability = analysis.probability;
  const familyMismatch = analysis.family_prediction !== bank.models.find((m) => m.id === matchedBankId)?.family;
  const isMatch = normalizeModelId(prediction) === normalizeModelId(matchedBankId);
  const stronger = strongerThanClaim(prediction, matchedBankId);
  const { status, confident, strongEnough } = autoReview
    ? { status: 'identified', confident: false, strongEnough: false }
    : decideStatus({ isMatch, probability, stronger }, config);

  /**
   * 逐轮归因：把每一轮的样本单独喂给评分器，看那一轮自己最倾向谁。
   * 汇总分是全部有效样本的均值，会掩盖"某几轮其实指向别的模型"——
   * 置信度不高时，这几行往往比汇总值更有信息量。
   */
  const roundTop = [];
  outputs.forEach((output, index) => {
    const where = probeReports.filter((p) => p.textLength !== undefined)[index] ?? {};
    try {
      const single = analyzeGlobalOutputs([output], bank);
      roundTop.push({
        round: where.round ?? index + 1,
        language: where.language ?? '',
        style: where.style ?? '',
        model: single.prediction,
        displayName: single.prediction_name,
        probability: single.probability,
        agreesWithClaim: normalizeModelId(single.prediction) === normalizeModelId(matchedBankId),
      });
    }
    catch {
      roundTop.push({ round: where.round ?? index + 1, language: where.language ?? '', style: where.style ?? '', model: null, displayName: null, probability: null, agreesWithClaim: false });
    }
  });

  // 前 4 名（第 1 名之外还要给第 2/3/4 名）—— 低置信度时用来解释"分数都跑到谁那儿去了"。
  const candidates = analysis.results.slice(0, 8).map((item) => ({
    model: item.model,
    displayName: item.display_name,
    family: item.family,
    probability: item.probability,
  }));
  const runnersUp = candidates.slice(1, 4);
  const needsDetail = probability < config.detailBelowConfidence;

  const runnerUp = analysis.results[1] ?? null;
  return {
    ...withProbes,
    status,
    prediction,
    predictionName: analysis.prediction_name,
    probability,
    minMatchConfidence: config.minMatchConfidence,
    detailBelowConfidence: config.detailBelowConfidence,
    needsDetail,
    isMatch,
    stronger,
    strongEnough,
    familyPrediction: analysis.family_prediction,
    familyPredictionName: analysis.family_prediction_name,
    familyProbability: analysis.family_probability,
    familyMismatch,
    runnerUp: runnerUp === null ? null : { model: runnerUp.model, displayName: runnerUp.display_name, probability: runnerUp.probability },
    runnersUp,
    roundTop,
    usedOutputs: analysis.used_outputs,
    validRounds: analysis.used_outputs,
    calibration: analysis.calibration,
    method: analysis.method,
    candidates,
    diagnostics: analysis.diagnostics,
    error: status === 'inconclusive'
      ? (isMatch
        ? `第一候选与声称模型一致（${analysis.prediction_name}），但置信度 ${(probability * 100).toFixed(1)}% 低于通过阈值 ${(config.minMatchConfidence * 100).toFixed(0)}%，不足以判定为一致。`
        : `第一候选 ${analysis.prediction_name}（${(probability * 100).toFixed(1)}%）低于置信阈值 ${(config.minConfidence * 100).toFixed(0)}%，无法断定不一致。`)
      : null,
    elapsedMs: Date.now() - started,
  };
}

/** 由裁决对象算出应当采取的动作，供门控使用。 */
export function verdictAction(verdict, config) {
  if (!config.enabled) return 'skip';
  switch (verdict.status) {
    case 'identified':
    case 'stronger':
      return 'report';
    case 'mismatch':
      return config.enforce === 'off' ? 'report' : config.enforce;
    case 'unknown':
      return config.blockOnUnknown && config.enforce === 'block' ? 'block' : 'report';
    case 'inconclusive':
      // 「第一候选对上、只是分数不够」和「压根没看出个所以然」要分开：
      // 前者是一个明确的、用户可能会想收紧的信号（weakMatchAction），后者没有可收紧的对象。
      // 收紧时沿用 mismatch 侧那套 enforce 映射，语义保持一致。
      if (verdict.isMatch === true && config.weakMatchAction === 'block') {
        return config.enforce === 'off' ? 'report' : config.enforce;
      }
      return 'report';
    default:
      return 'skip';
  }
}

/** 供缓存键使用：同一会话 + 同一模型 + 同一 provider 视为同一断言。 */
export function verificationKey(claimed, provider) {
  return `${normalizeModelId(claimed)}@${normalizeModelId(provider)}`;
}

/** 由 seed 派生（保留给需要在外部复现组卷的调用方）。 */
export { seedFrom };
