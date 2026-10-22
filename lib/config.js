/**
 * dsh-modeltrace — 插件配置。
 *
 * 全部可调参数都在这里声明为 Schemastery `Schema<Config>`（官方红线：不得硬编码
 * 可调参数），并由 resolveConfig() 逐字段防御性兜底，使部分配置与测试输入都能得到
 * 一个完整的 ResolvedConfig。
 */
import z from '@deepseek-ai/schemastery';

/**
 * Schemastery schema：向 Loader 与设置界面声明配置形状。
 *
 * ⚠️ 设置界面只认 `.volatile()` 字段 —— 宿主 dsh-settings 的 `describe()` 会先用
 * `volatileForm(schema)` 过滤：一个字段只有当它（或它的某个祖先）带 `meta.volatile`
 * 时才会留在表单里；整个 schema 一个 volatile 字段都没有时 `volatileForm` 返回
 * undefined，该 entry 直接被 `describe()` 跳过 —— 命名空间不会下发到前端，
 * `configForms.whileServed()` 永远为 false，设置卡片也就永远不注册。已有 volatile
 * 字段还需要前端注册新版 `settings.plugins.tab` 槽位。写入侧 `write()` 对非 volatile 字段直接抛
 * `Config field "x" is not volatile`。
 *
 * 因此下面这 14 个「用户真的会去调」的旋钮必须带 `.volatile()`，
 * 其余高级项（模板池、指纹库路径、语言池、工具白名单……）刻意保持非 volatile，
 * 只能走 profile 的 cordis.patch.yml —— 它们不该出现在设置页里。
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  intervalMessages: z.string().default('').volatile(),
  intervalSeconds: z.string().default('').volatile(),
  verificationMode: z.union([z.const('probe'), z.const('session')]).default('probe').volatile(),
  floatingWindow: z.boolean().default(true).volatile(),

  /**
   * 指纹不一致时的动作：
   *  - block：锁死任务 —— 拒绝一切工作类工具，只放行白名单，模型只能向用户汇报并等待指令
   *  - warn ：只在注入的裁决里提示，不阻塞工具
   *  - off  ：只记录与汇报，不做任何干预
   */
  enforce: z.union([z.const('block'), z.const('warn'), z.const('off')]).default('block').volatile(),

  /** 何时触发校验：session-start（按 X1/X2 调度后台校验）或 manual（只由命令/工具触发）。 */
  verifyOn: z.union([z.const('session-start'), z.const('manual')]).default('session-start'),

  /** 旧宿主 resume 事件是否重置状态（默认关闭）。 */
  reverifyOnResume: z.boolean().default(false),

  /** 多轮测试轮数，1..5（上游建议 3 轮：3 份有效回答时校准表 cv_accuracy = 1.0）。 */
  rounds: z.number().min(1).max(5).default(3).volatile(),

  /** 提示词语言池，按顺序在轮次间轮换（同义不同词的变换维度之一）。 */
  languages: z.array(z.string()).default(['zh', 'en']),

  /**
   * 每轮期望整数个数的随机区间（含端点）。每轮独立随机取值。
   * 下限必须 ≥ 218：评分器只接受 max(80, ceil(期望数 × 0.55)) 以上的有效数字，
   * 低于上游最小挑战规模就判不出结果，钱会白花。上限 400 是上游实测区间上界。
   */
  countMin: z.number().min(218).max(400).default(218).volatile(),
  countMax: z.number().min(218).max(400).default(400).volatile(),

  /**
   * 探针通道：clean = 完全空上下文（默认）；system / user = 把背景噪声注入对应通道，
   * 用于更强的"同义不同词"变换。默认只用 clean，探针里除挑战本身之外什么都没有。
   */
  transports: z.array(z.string()).default(['clean']),

  /**
   * 单次探针调用的最大输出 token。
   * 320 个整数约 1.3k 字符，给 4000 是留足余量 —— 一旦被截断，该轮有效数字不足，
   * 评分器会直接判为"无可用回答"，这一轮的钱就白花了。
   */
  maxTokens: z.number().min(256).max(16000).default(4000),

  /** 单次探针调用超时（毫秒）。 */
  timeoutMs: z.number().min(1000).max(1800000).default(300000).volatile(),

  /**
   * 多轮探针是否并行发出。两种方式均独立于主会话执行。
   */
  parallelProbes: z.boolean().default(true),

  /** 判定为"确实不一致"所需的最小置信度；低于此值判为 inconclusive（不拦截）。 */
  minConfidence: z.number().min(0).max(1).default(0.5),

  /**
   * 判定"通过"所需的最低置信度。
   *
   * 只要求"第一候选 == 声称模型"是不够的：55.1% 意味着剩下 44.9% 分散在其他候选上，
   * 那更像一次抛硬币，不能当作证据。低于此值时判为 inconclusive
   * —— 既不算通过（不注入"校验通过"），也不按不一致处理（不锁定任务）。
   */
  minMatchConfidence: z.number().min(0).max(1).default(0.8).volatile(),

  /**
   * 置信度低于此值时，裁决里附上候选明细（第 2/3/4 名）与**每一轮各自的最高候选**。
   * 默认 0.9：高分时不必让模型读排行，省 token。
   */
  detailBelowConfidence: z.number().min(0).max(1).default(0.9).volatile(),

  /**
   * 第一候选与声称模型同名、但置信度未达 `minMatchConfidence` 时的处理：
   *  - `report`（默认）：只汇报，不锁定任务。分数不够 ≠ 不一致，中转站抖动时不该卡住工作。
   *  - `block` ：与"确实不一致"同样处理 —— 锁定任务，等用户 `/modeltrace allow` 放行。
   * 只在 `enforce: 'block'` 时才会真的拦住（和 mismatch 侧一致）。
   *
   * 刻意不进设置卡片（卡片已有 14 项，够挤了）；需要更严时改 cordis.yml 的这一行即可。
   */
  weakMatchAction: z.union([z.const('report'), z.const('block')]).default('report'),

  /**
   * 声称模型不在指纹库内时**直接不运行**：不发探针、不注入裁决、不拦截，
   * 兼容旧配置，现固定为 true。
   */
  silentWhenUnknown: z.boolean().default(true),

  /** 旧配置兼容字段，现固定 false，库外模型不拦截。 */
  blockOnUnknown: z.boolean().default(false),

  /**
   * 旧配置兼容字段，不再参与调度；由 X1/X2 决定重校验。
   */
  cacheMinutes: z.number().min(0).max(10080).default(0),

  /**
   * 声称模型 id → 指纹库模型 id 的别名映射。
   * 例如中转站暴露 `my-gpt5`，实际指向库内 `gpt-5.4` 时可写 {"my-gpt5":"gpt-5.4"}。
   */
  modelAliases: z.dict(z.string()).default({}),

  /** 锁定任务时仍然放行的工具名（状态/停止/汇报类），其余工作工具一律拒绝。 */
  allowedToolsWhenBlocked: z.array(z.string()).default(['modeltrace_status']),

  /** 是否把裁决作为模型可见上下文注入当轮（模型据此向用户汇报）。 */
  injectVerdict: z.boolean().default(true).volatile(),

  /** 注入的裁决正文详略：brief 只给结论，full 附带全部候选概率与解析统计。 */
  reportDetail: z.union([z.const('brief'), z.const('full')]).default('full'),

  /**
   * 提示词模板覆盖：按语言给出语义等价、措辞不同的候选句。
   * 只覆盖给出的语言；未给出的语言沿用内置默认（见 lib/prompts.js）。
   */
  templates: z.object({
    task: z.dict(z.array(z.string())).default({}),
    constraint: z.dict(z.array(z.string())).default({}),
    background: z.dict(z.array(z.string())).default({}),
  }).default({}),

  /** 覆盖内置指纹库路径（留空则用包内 assets/unified_bank.json）。 */
  bankPath: z.string().default(''),

  /** 校验通过后是否也注入一条简短确认（默认 true：用户要求"获得结果后汇报给用户"）。 */
  injectOnMatch: z.boolean().default(true).volatile(),
});

/** 把 0..1 的配置值夹紧；非有限数落回默认值（`Number(undefined)` 之类不该产生 NaN）。 */
function clamp01(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** 空值与 0 必须区分；不合法输入由前端阻止，此处防御性视作未填写。 */
export function optionalInterval(value, integer = false) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) return null;
  return n;
}

/** resolveConfig() 的输出形状。 */
export function resolveConfig(config = {}) {
  const languages = Array.isArray(config.languages) && config.languages.length > 0
    ? config.languages.filter((item) => typeof item === 'string' && item.length > 0)
    : ['zh', 'en'];
  const transports = Array.isArray(config.transports) && config.transports.length > 0
    ? config.transports.filter((item) => ['clean', 'system', 'user'].includes(item))
    : ['clean'];
  // 取数区间：下限硬夹在 [218, 400]，上限不低于下限。
  const rawMin = Math.floor(Number(config.countMin) || 218);
  const rawMax = Math.floor(Number(config.countMax) || 400);
  const countMin = Math.min(400, Math.max(218, rawMin));
  const countMax = Math.min(400, Math.max(countMin, rawMax));
  return {
    enabled: config.enabled ?? true,
    intervalMessages: optionalInterval(config.intervalMessages, true),
    intervalSeconds: optionalInterval(config.intervalSeconds),
    verificationMode: config.verificationMode === 'session' ? 'session' : 'probe',
    floatingWindow: config.floatingWindow ?? true,
    enforce: ['block', 'warn', 'off'].includes(config.enforce) ? config.enforce : 'block',
    verifyOn: config.verifyOn === 'manual' ? 'manual' : 'session-start',
    reverifyOnResume: config.reverifyOnResume ?? false,
    rounds: Math.min(5, Math.max(1, Math.floor(Number(config.rounds) || 3))),
    languages: languages.length > 0 ? languages : ['zh', 'en'],
    countMin,
    countMax,
    transports: transports.length > 0 ? transports : ['clean'],
    maxTokens: Math.min(16000, Math.max(256, Math.floor(Number(config.maxTokens) || 4000))),
    timeoutMs: Math.min(1800000, Math.max(1000, Math.floor(Number(config.timeoutMs) || 300000))),
    parallelProbes: config.parallelProbes ?? true,
    minConfidence: clamp01(config.minConfidence, 0.5),
    minMatchConfidence: clamp01(config.minMatchConfidence, 0.8),
    detailBelowConfidence: clamp01(config.detailBelowConfidence, 0.9),
    weakMatchAction: config.weakMatchAction === 'block' ? 'block' : 'report',
    silentWhenUnknown: true,
    blockOnUnknown: false,
    cacheMinutes: Math.min(10080, Math.max(0, Number(config.cacheMinutes ?? 0))),
    modelAliases: (config.modelAliases && typeof config.modelAliases === 'object') ? { ...config.modelAliases } : {},
    allowedToolsWhenBlocked: Array.isArray(config.allowedToolsWhenBlocked) && config.allowedToolsWhenBlocked.length > 0
      ? config.allowedToolsWhenBlocked.slice()
      : ['modeltrace_status'],
    injectVerdict: config.injectVerdict ?? true,
    reportDetail: config.reportDetail === 'brief' ? 'brief' : 'full',
    templates: {
      task: (config.templates && typeof config.templates.task === 'object' && config.templates.task) || {},
      constraint: (config.templates && typeof config.templates.constraint === 'object' && config.templates.constraint) || {},
      background: (config.templates && typeof config.templates.background === 'object' && config.templates.background) || {},
    },
    bankPath: typeof config.bankPath === 'string' ? config.bankPath : '',
    injectOnMatch: config.injectOnMatch ?? true,
  };
}

/**
 * 设置界面（通用设置 → 插件设置）里暴露的可调项。
 *
 * 只有这几个"用户真的会去调"的旋钮进设置界面；其余高级项（模板池、指纹库路径、
 * 走哪些语言、工具白名单……）仍走 profile 的 cordis.patch.yml。
 * 这些项 applies: 'live' —— 改完立即生效，不需要重启。
 */
export const SettingsSchema = z.object({
  enabled: z.boolean().default(true).description('总开关：关闭后不校验'),
  intervalMessages: z.string().default('').description('X1：间隔多少条用户消息重新校验（留空不使用；0 为每条消息）'),
  intervalSeconds: z.string().default('').description('X2：校验完成后间隔多少秒重新校验（留空不使用；0 为每条消息）；同时填写时优先 X1，两项留空则每个会话仅首条消息校验一次'),
  verificationMode: z.union([z.const('probe'), z.const('session')]).default('probe').description('校验方式：probe 空上下文探针（默认）；session 极简 DSH 会话（实验性）'),
  floatingWindow: z.boolean().default(true).description('结果悬浮窗：关闭本次窗口后，下次校验自动重显'),
  injectVerdict: z.boolean().default(true).description('将结果注入主会话上下文（保留旧版提示方式）'),
  timeoutMs: z.number().min(1000).max(1800000).default(300000).step(1000).description('每轮超时（毫秒），默认 5 分钟；后台校验不阻塞主会话输出'),
  enforce: z.union([z.const('block'), z.const('warn'), z.const('off')]).default('block').description('指纹不一致时：block 锁定后续工具 / warn 提示 / off 仅记录'),
  rounds: z.number().min(1).max(5).default(3).step(1).description('校验轮数（1-5）'),
  countMin: z.number().min(218).max(400).default(218).step(1).description('每轮随机整数个数下限'),
  countMax: z.number().min(218).max(400).default(400).step(1).description('每轮随机整数个数上限'),
  minMatchConfidence: z.number().min(0).max(1).default(0.8).step(0.05).description('判定通过的最低置信度'),
  detailBelowConfidence: z.number().min(0).max(1).default(0.9).step(0.05).description('低于此置信度时附候选与逐轮结果'),
  injectOnMatch: z.boolean().default(true).description('通过校验也注入结果'),
});

/** 该插件设置命名空间（会作为一张卡片出现在设置界面里）。 */
export const SETTINGS_NAMESPACE = 'modeltrace';
