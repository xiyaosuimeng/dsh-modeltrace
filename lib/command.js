/**
 * dsh-modeltrace — `/modeltrace` 斜杠命令。
 *
 * 子命令：
 *   （空）/ status   查看本次会话的裁决
 *   recheck          立即重新跑一次校验（消耗 rounds 次模型调用）
 *   allow / unlock   放行被锁定的任务（用户明确要求继续时使用）
 *   bank / list      列出指纹库中的全部模型
 *   help             用法说明
 */
import { buildUserReport, verdictSummary } from './report.js';
import { bankModelIds } from './verify.js';

const HELP = [
  '**/modeltrace** — ModelTrace 模型指纹校验',
  '',
  '- `/modeltrace` 或 `/modeltrace status` — 查看本次会话的校验裁决',
  '- `/modeltrace recheck` — 按当前校验方式立即重校验（会消耗模型调用）',
  '- `/modeltrace allow` — 放行被锁定的任务，让模型继续执行当前指令',
  '- `/modeltrace bank` — 列出指纹库内的全部模型',
  '- `/modeltrace help` — 显示本说明',
].join('\n');

export function modelTraceCommandDefinition(ctx, config, gate) {
  return {
    name: 'modeltrace',
    description: 'ModelTrace 模型指纹校验：查看裁决 / 重新校验 / 放行锁定 / 列出指纹库',
    input: { hint: 'status | recheck | allow | bank | help' },
    handler: async (invocation) => {
      const agent = invocation.agent;
      const sub = (invocation.rawInput || '').trim().toLowerCase().split(/\s+/)[0] || 'status';
      const bank = gate.bank();
      const ids = bankModelIds(bank);

      if (sub === 'help') return { kind: 'success', text: HELP };

      if (sub === 'bank' || sub === 'list') {
        const lines = [
          `**指纹库：${ids.length} 个模型 / ${new Set(bank.models.map((model) => model.family)).size} 个家族**`,
          '',
          ...bank.models.map((model) => `- \`${model.id}\` — ${model.display_name}（${model.family_name ?? model.family}）`),
          '',
          `库标识：\`${bank.method ?? '统一全局稳健数字指纹'}\``,
        ];
        return { kind: 'success', text: lines.join('\n') };
      }

      if (agent === undefined) return { kind: 'error', text: '无法定位当前会话，/modeltrace 需要会话上下文。' };

      if (sub === 'allow' || sub === 'unlock') {
        const before = gate.snapshot(agent);
        if (!before.locked) return { kind: 'success', text: '当前任务并未处于锁定状态，无需放行。' };
        gate.unlock(agent);
        try {
          const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
          agent.inject?.(createUserMessage({
            content: [{ type: 'text', text: '【DSH ModelTrace】用户已明确放行：指纹不一致的警告已被用户接受，工作类工具已恢复。请继续执行用户的指令。' }],
            source: { kind: 'plugin:dsh-modeltrace' },
          }));
        }
        catch { /* 注入失败不影响放行 */ }
        return { kind: 'success', text: '已放行：任务锁定已解除，工作类工具恢复可用。\n\n> 提示：本次放行只针对当前会话的本次断言；下次校验会重新判定。' };
      }

      if (sub === 'recheck' || sub === 'verify') {
        const verdict = await gate.reverify(agent, invocation.signal);
        const snapshot = gate.snapshot(agent);
        return { kind: 'success', text: buildUserReport(verdict, config, snapshot.action) };
      }

      const snapshot = gate.snapshot(agent);
      const verdict = snapshot.verdict;
      if (verdict === null) {
        const selection = snapshot.selection;
        return {
          kind: 'success',
          text: [
            snapshot.running ? '**指纹校验正在后台运行**' : '**尚未执行指纹校验**',
            '',
            `- 当前模型选择：\`${selection.model || '(空)'}\`${selection.provider ? `（provider：\`${selection.provider}\`）` : ''}`,
            `- 触发方式：${config.verifyOn === 'session-start' ? '按设置中的 X1/X2 规则后台校验'  : '手动（仅本命令）'}`,
            '',
            '运行 `/modeltrace recheck` 立即校验一次。',
          ].join('\n'),
        };
      }

      const header = `${verdictSummary(verdict)}${snapshot.locked ? ' · **任务已锁定**' : ''}`;
      return { kind: 'success', text: `${header}\n\n${buildUserReport(verdict, config, snapshot.action)}` };
    },
  };
}
