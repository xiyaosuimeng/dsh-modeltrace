/**
 * dsh-modeltrace — DeepSeek Harness 插件。
 *
 * 把 ModelTrace（https://github.com/xqy2006/ModelTrace）的**主动模型归因方法**与
 * **统一指纹库**搬进 DSH：主会话输出期间，在后台用数值挑战给当前模型做一次
 * 指纹测试，与用户当前选择的模型名称（provider-owned id，非显示名称）比对；
 * 完成后注入裁决；不一致时按配置锁定后续工具，并由模型向用户汇报。
 *
 * 官方插件红线遵循情况：
 *  - 默认导出是**插件对象**（不是返回 {apply} 的工厂函数），Loader 直接挂载 module.default
 *  - 全部注册走 ctx.on / ctx.inject(...).register / ctx.effect —— "注册即 effect"
 *  - 可调参数全部走 Schemastery Config，无硬编码
 *  - 模型可见内容走日志化的 agent.inject 通道（source.kind = 'plugin:dsh-modeltrace'）
 */
import { Config, resolveConfig } from './config.js';
import { createGate } from './gate.js';
import { modelTraceTool } from './tool.js';
import { modelTraceCommandDefinition } from './command.js';

export { Config, SettingsSchema, SETTINGS_NAMESPACE } from './config.js';
export { resolveConfig } from './config.js';
export { verifyModel, loadBank, matchBankModel, normalizeModelId, verdictAction, bankModelIds } from './verify.js';
export { createGate } from './gate.js';
export { buildVerdictText, buildUserReport, verdictSummary } from './report.js';
export { composeProbe, planRounds, resolveTemplates, LANGUAGES, TASK_TEMPLATES, CONSTRAINT_VARIANTS } from './prompts.js';
export { analyzeGlobalOutputs, parseNumbers, VALUE_MIN, VALUE_MAX, DIMENSION } from './scorer.js';

export const name = 'dsh-modeltrace';

export default {
  name,
  Config,
  apply(ctx, config = {}) {
    // 当前插件实例的配置；宿主更改设置时重新装配，并释放旧实例的后台任务。
    const resolved = resolveConfig(config);

    // 设置界面。命名空间本身**不需要**在这里注册：宿主 dsh-settings 直接读插件导出的
    // `Config`，用 `volatileForm()` 过滤出带 `.volatile()` 的字段自动生成表单，
    // 命名空间 id 就是 profile 里的 entry id（`modeltrace`），改完由
    // configEditor.edit → reconcileProfilePatches 重新 apply 本插件，天然 live。
    //
    // 这里唯一要做的是**关掉宿主自动生成的设置页**（`auto: false`）：本插件自带
    // 卡片（lib/client.js 注册到 `settings.plugins.tab` 与 `plugins.item` 槽），
    // 不关的话设置里会出现两张重复的表单。`configure` 的 owner 必须显式传
    // `ctx.fiber`（插件自身的 fiber）——默认值是当前调用方 fiber，会挂错实例。
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.effect(() => {
        try {
          return settingsCtx.settings.configure({ auto: false }, ctx.fiber);
        }
        catch (error) {
          // 同一 fiber 重复 apply（HMR / 热更新）时会抛 "already configured"，
          // 已有策略仍然有效，降级为一行日志。
          ctx.logger?.debug?.('dsh-modeltrace: 设置页策略已存在，沿用既有策略：%o', error);
          return undefined;
        }
      }, 'dsh-modeltrace: 关闭宿主自动设置页');
    });

    const gate = createGate(ctx, resolved);
    gate.attach();
    // 暴露给同一装配内的其它插件（非必需，纯增量）。
    try {
      ctx.provide('modelTraceGate', gate);
    }
    catch { /* 名称冲突或只读上下文时忽略 */ }

    ctx.inject(['webServer', 'agents', 'connection'], (webCtx) => {
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'exact', path: '/api/modeltrace',
        handler: async (req, res) => {
          const admission = webCtx.connection.admit(req);
          if ('rejection' in admission) { res.writeHead(admission.rejection); res.end(); return; }
          if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
          const url = new URL(req.url, 'http://localhost');
          const agent = webCtx.agents.get(url.searchParams.get('sessionId') ?? '');
          res.writeHead(agent ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(agent ? gate.snapshot(agent) : { error: 'session/not-found' }));
        },
      }), 'dsh-modeltrace: read-only session status');
    });

    // 模型可调用的状态工具（可选子服务：无 tools 注册表时只是少一条通路）。
    ctx.inject(['tools'], (toolCtx) => {
      toolCtx.tools.register(modelTraceTool(toolCtx, resolved, gate));
    });

    // 用户发起的校验报告（可选子服务）。
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register(modelTraceCommandDefinition(commandCtx, resolved, gate));
    });
  },
};
