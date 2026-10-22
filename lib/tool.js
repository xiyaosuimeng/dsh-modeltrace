/**
 * dsh-modeltrace — 模型可调用的状态工具。
 *
 * 存在的意义：当任务被锁定时，它是白名单里唯一还能用的工具 —— 模型可以用它
 * 重新读取裁决（供向用户汇报），或在用户明确要求后触发一次重新校验。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { buildUserReport, verdictSummary } from './report.js';
import { bankModelIds } from './verify.js';

const PARAMETERS = {
  action: {
    type: 'string',
    description: 'status = 读取当前指纹校验裁决（默认）；recheck = 立即重新跑一次校验（会消耗一次模型调用，仅在用户要求时使用）',
    enum: ['status', 'recheck'],
  },
};

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: {
      type: 'string',
      required: true,
      enum: ['identified', 'stronger', 'match', 'mismatch', 'unknown', 'inconclusive', 'skipped', 'error', 'none', 'running'],
      description: '校验结论：match 一致 / mismatch 不一致 / unknown 不在指纹库 / inconclusive 无法判定 / none 尚未校验 / running 后台校验中',
    },
    locked: { type: 'boolean', required: true, description: '任务是否因不一致被锁定（锁定后工作类工具会被拒绝）' },
    action: { type: 'string', description: '本插件采取的处置动作：block / warn / report / skip' },
    claimedModel: { type: 'string', description: '用户当前选择声称的模型名称' },
    prediction: { type: 'string', description: '指纹判定出的模型 id' },
    probability: { type: 'number', description: '指纹判定置信度 0..1' },
    familyPrediction: { type: 'string', description: '判定出的模型家族' },
    summary: { type: 'string', required: true, description: '一句话结论' },
    report: { type: 'string', description: '完整报告（markdown）' },
    candidates: {
      type: 'array',
      items: { type: 'string' },
      description: '候选模型排行（前 8，格式 "模型id 概率"）',
    },
    bankSize: { type: 'number', description: '指纹库内的模型数量' },
    bankModels: { type: 'array', items: { type: 'string' }, description: '指纹库内的全部模型 id' },
    rounds: { type: 'number', required: true, description: '生效的测试轮数' },
    countMin: { type: 'number', required: true, description: '生效的每轮数字个数随机下限' },
    countMax: { type: 'number', required: true, description: '生效的每轮数字个数随机上限' },
    minMatchConfidence: { type: 'number', description: '判定「通过」所需的最低置信度；低于它就只算无法判定' },
    detailBelowConfidence: { type: 'number', description: '低于此置信度时报告候选明细与逐轮最高候选' },
    silentWhenUnknown: { type: 'boolean', description: '声称模型不在库内时是否完全静默（不探测、不注入、不拦截）' },
  },
};

export function modelTraceTool(ctx, config, gate) {
  return defineTool({
    name: 'modeltrace_status',
    description: '读取本次会话的 ModelTrace 模型指纹校验裁决：声称模型 vs 指纹判定结果、置信度、是否已锁定任务。只读、无副作用（action=recheck 除外，它会重新跑一次校验并消耗模型调用）。',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.report ?? value.summary }],
    },
    timeoutMs: config.timeoutMs * (config.parallelProbes ? 1 : config.rounds) + 30_000,
    execute: async (args, exec) => {
      const agent = exec.agent;
      const bank = gate.bank();
      const ids = bankModelIds(bank);
      const action = args.action === 'recheck' ? 'recheck' : 'status';

      const effective = {
        rounds: config.rounds,
        countMin: config.countMin,
        countMax: config.countMax,
        minMatchConfidence: config.minMatchConfidence,
        detailBelowConfidence: config.detailBelowConfidence,
        silentWhenUnknown: config.silentWhenUnknown,
      };

      if (agent === undefined) {
        return {
          status: 'error',
          locked: false,
          summary: '无法定位当前会话（modeltrace_status 仅在会话上下文中可用）。',
          bankSize: ids.length,
          ...effective,
        };
      }

      let snapshot = gate.snapshot(agent);
      if (action === 'recheck') {
        const verdict = await gate.reverify(agent, exec.signal);
        snapshot = gate.snapshot(agent);
        return {
          ...effective,
          status: verdict.status,
          locked: snapshot.locked,
          action: snapshot.action,
          claimedModel: verdict.claimedModel,
          ...(verdict.prediction !== undefined ? { prediction: verdict.prediction } : {}),
          ...(verdict.probability !== undefined ? { probability: verdict.probability } : {}),
          ...(verdict.familyPrediction !== undefined ? { familyPrediction: verdict.familyPrediction } : {}),
          summary: verdictSummary(verdict),
          report: buildUserReport(verdict, config, snapshot.action),
          ...(Array.isArray(verdict.candidates)
            ? { candidates: verdict.candidates.map((item) => `${item.model} ${(item.probability * 100).toFixed(1)}%`) }
            : {}),
          bankSize: ids.length,
          bankModels: ids,
        };
      }

      const verdict = snapshot.verdict;
      if (verdict === null) {
        return {
          ...effective,
          status: snapshot.running ? 'running' : 'none',
          locked: false,
          action: snapshot.action,
          claimedModel: snapshot.selection.model,
          summary: snapshot.running ? '指纹校验正在后台运行，主会话可以继续。' : '本次会话尚未执行指纹校验。',
          bankSize: ids.length,
          bankModels: ids,
        };
      }

      return {
        ...effective,
        status: verdict.status,
        locked: snapshot.locked,
        action: snapshot.action,
        claimedModel: verdict.claimedModel,
        ...(verdict.prediction !== undefined ? { prediction: verdict.prediction } : {}),
        ...(verdict.probability !== undefined ? { probability: verdict.probability } : {}),
        ...(verdict.familyPrediction !== undefined ? { familyPrediction: verdict.familyPrediction } : {}),
        summary: verdictSummary(verdict),
        report: buildUserReport(verdict, config, snapshot.action),
        ...(Array.isArray(verdict.candidates)
          ? { candidates: verdict.candidates.map((item) => `${item.model} ${(item.probability * 100).toFixed(1)}%`) }
          : {}),
        bankSize: ids.length,
        bankModels: ids,
      };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.action === 'recheck' ? '重新校验模型指纹' : '读取模型指纹裁决',
      kind: args.action === 'recheck' ? 'execute' : 'read',
      rawInput: args.action ?? 'status',
    }),
  });
}
