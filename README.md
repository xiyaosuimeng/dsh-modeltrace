# dsh-modeltrace

把 [ModelTrace](https://xqy2006.github.io/ModelTrace/) 的长整数生成指纹校验接入 DSH。主会话正常输出，插件在后台校验，完成后把裁决注入主会话上下文，并可通过悬浮窗显示精简结果。

默认采用空上下文探针，只有数值挑战、不携带历史或工具。实验性极简 DSH 会话模式默认关闭：每轮自动创建独立 `minimal` 会话，固定主会话当前的 provider/model，禁用工具及运行时上下文，收集回答后使用相同评分算法。辅助会话使用 `modeltrace-probe-` ID 防止递归触发校验，完成或取消后释放 agent；校验记录可保留在宿主会话日志中。

悬浮窗有独立开关，显示声称模型、前三候选及置信度、每轮最高候选和错误。关闭本次窗口后，下次校验自动出现。旧版上下文注入保留，开关与悬浮窗互相独立。若校验不一致，`enforce=block` 会在结果完成后拒绝后续工作工具；已经输出的内容不会被撤回。

### 一次校验要花多少钱

上游协议本身就是"让模型写出 300 个随机数字"，所以输出 token 是主要成本：

**每轮的数字个数是在 218..400 之间独立随机的**（可在设置界面调），所以每轮成本也是浮动的。
按均值 ~309 个数算：

| 轮数 | 输出 | 说明 |
| --- | --- | --- |
| 1 轮 | ~309 个数 ≈ 0.5k output token | 上游校准表 `cv_accuracy = 96.1%` |
| **3 轮（默认）** | ~927 个数 ≈ 1.4k output token | 上游校准表 `cv_accuracy = 100%` |
| 5 轮 | ~1545 个数 ≈ 2.3k output token | 收益递减，一般不需要 |

默认 X1/X2 均留空时，每个会话仅在首条用户消息校验一次。填写间隔后，每次重校验都会产生相应开销。
想更省就把 `rounds` 设成 `1`，上游校准准确率从 100% 降到 96.1%。

> **为什么下限死守 218**：评分器只接受 `max(80, ceil(期望数 × 0.55))` 以上的有效数字。
> 上游 12 套题的最小规模就是 218，低于这个数**永远判不出结果**——钱花了，结论是"无可用回答"。

**声称模型不在指纹库内时一个 token 都不花** —— 直接短路，不发明知判不出来的探针。

---

## 校验调度

两项都可留空，空值与 `0` 不同。设置卡片内同时写明以下规则：

| X1（用户消息条数） | X2（秒） | 行为 |
| --- | --- | --- |
| 留空 | 留空 | 每个会话仅首条用户消息校验一次；不想校验请关闭最上方总开关 |
| 非负整数 | 留空或已填写 | 优先 X1：首条校验，之后每新增 X1 条用户消息重校验；X1=0 时每条用户消息校验 |
| 留空 | 正数 | 首条校验，之后每次完成后等待 X2 秒，后台自动重校验，无需新消息 |
| 留空 | 0 | 每条用户消息校验 |

只统计真实用户消息，插件注入、工具消息、同条消息重复进入步骤均不计数。已有校验未完成时，消息触发的检查排队执行，主会话不等待。时间模式从校验完成计时，避免重叠发起。切换声称模型会取消旧校验，下条用户消息按新模型校验；旧结果不会写回。库外模型始终不运行：不调用模型、不注入结果、不锁定任务。

默认每轮超时 **300000 ms（5 分钟）**，可在设置里调到 30 分钟。主会话停止当前回复不会自动取消后台校验；卸载插件、关闭总开关、释放会话或切换模型会取消相应检查。

锁定后用 `/modeltrace allow` 放行；`/modeltrace recheck` 手动校验。手动命令会等待报告，自动校验则在后台进行。

---

## 安装状态

已装入 web profile。**注意这里有两份物理拷贝，改动要同步**：

- 插件目录（开发副本，profile 的 `node_modules/dsh-modeltrace` 软链指向它）：
  `/root/dsha-modeltrace`
- 包源副本（profile `package.json` 里声明 `"dsh-modeltrace": "link:/root/.dsh/plugin-src/dsh-modeltrace"`）：
  `/root/.dsh/plugin-src/dsh-modeltrace`
- profile：`/root/.dsh/profiles/web`（`dsh.profile.bundles` 已追加 `dsh-modeltrace`）
- 校验：`dsh --profile web --dump-config` 输出含 `- id: modeltrace` / `name: dsh-modeltrace`
- profile 的 `cordis.patch.yml` 末尾有 `- id: modeltrace` / `disabled: false`：插件管理器的
  `plugin-activations.json` 会在内容指纹变化后把插件停用（写 `node_modules/dsh-modeltrace.disabled`），
  这条 patch 保证它仍被启用。

> `patchReload: "startup"` —— **需要重启 DSH web 进程**插件才会真正生效。

### 打包成可导入的归档

```bash
cd /root/dsha-modeltrace && tar --exclude='./node_modules' --exclude='./.git' \
  -czf <输出路径> --transform 's,^\.,plugins/dsh-modeltrace,' .
```

**顶层目录必须是 `plugins/<插件名>/`** —— 这是 `dsha-plugin export` 的布局，导入时
`find_plugin_roots()` 会在一层子目录里找 `package.json`。归档只需源码，**不要带 `node_modules`**：
`prepare_dependencies()` 导入时会自己按 `dependencies` 装（实测 pnpm 装出 `schemastery` 379 KB）。

导入验证链（按插件管理器自己的校验器跑过）：

1. `zipfile.is_zipfile()` 为假 → 走 tarfile 分支；条目均为普通文件/目录，无设备文件
2. `plugin_package()`：`builtin.valid_name('dsh-modeltrace')` → `True`；`dsh.bundle.patch` 指向的
   `./cordis.patch.yml` 存在；`main` 指向的 `lib/index.js` 存在；**不在** `OFFICIAL_BUNDLES` 里
3. `prepare_dependencies()`：`dependencies` 里没有 `workspace:` / `link:` / `file:` 前缀
4. 实测把归档解到 `/root/.dsh/profiles/web/node_modules/` 下（复制而非软链）后加载：
   入口 `name`/`apply` 就位、`resolveConfig` 读出 0.8/0.9/report、指纹库 17 个模型且
   `gpt-6-astra` 在库内、`decideStatus(64.2% + 对上)` → `inconclusive`、设置项 14 个。

> ⚠️ **依赖放置踩过的坑**：`@deepseek-ai/schemastery` 必须放在 **`dependencies`**（官方
> `adding-a-package.md` 原话：it is a runtime validator），它要和 agent-loop 的用法一致。
> 其余 dsh 包放 `peerDependencies`。
>
> 而且 peer 版本**不能写 `*`**：`*` 会让 pnpm 解析到 npm 上的 `0.0.1-rc.1` 老线，那条线的
> `dsh-session` / `dsh-agent` 声明了 `@deepseek-ai/dsh-type-meta@^0.0.1-rc.1`，而
> **该包从未发布到 npm registry**（`GET /@deepseek-ai%2Fdsh-type-meta` → 404），于是
> `pnpm install` 直接 `ERR_PNPM_FETCH_404` 失败。改成支持 0.1.5–0.1.7 预发布的版本范围
> 后 peer 树干净、安装成功。`npm` 因为不解析 peer 而侥幸成功 —— **别用 npm 的假成功判断**。


---

## 命令与工具

| 入口 | 作用 |
| --- | --- |
| `/modeltrace status` | 查看当前会话的裁决状态、声称模型、指纹判定、是否锁定 |
| `/modeltrace recheck` | 强制重新校验一次 |
| `/modeltrace allow` | **解除锁定**，放行后续工具 |
| `/modeltrace bank` | 列出指纹库覆盖的 17 个模型 / 2 个家族 |
| `/modeltrace help` | 用法 |
| 工具 `modeltrace_status` | 同上 status / recheck，供模型在锁定时自查并向你汇报 |

---

## 配置

**常用的 14 个旋钮在设置界面里直接改**（见下一节），其余高级项写在 profile 的
`cordis.patch.yml` 里（`- id: modeltrace` 下加 `config:`）。入口配置是"组装层"，
设置界面里被你改过的字段优先于它。全部字段都有默认值。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `intervalMessages` | `''` | X1，非负整数字符串，空值不用；优先于 X2 |
| `intervalSeconds` | `''` | X2，非负数字字符串；正值按后台计时重校验 |
| `verificationMode` | `'probe'` | `'probe'` 空上下文探针；`'session'` 实验性极简 DSH 会话 |
| `floatingWindow` | `true` | 结果悬浮窗，与上下文注入独立 |
| `enforce` | `'block'` | `block` 锁死 / `warn` 只提示 / `off` 只记录 |
| `verifyOn` | `'session-start'` | `session-start` 自动 / `manual` 只由命令触发 |
| `reverifyOnResume` | `false` | resume 会话是否重新校验 |
| `rounds` | `3` | 探测轮数 **1–5**（3 轮时上游校准 cv_accuracy = 1.0） |
| `languages` | `['zh','en']` | 语言池，轮次间轮换 |
| `countMin` | `218` | 每轮数字个数的**随机下限**，硬夹在 218–400。低于 218 永远判不出结果 |
| `countMax` | `400` | 每轮数字个数的**随机上限**，硬夹在 218–400，且不得小于 `countMin` |
| `transports` | `['clean']` | 探针通道。`clean` = 完全空上下文；`system`/`user` 会注入背景噪声（更强变换，但不再是空上下文） |
| `maxTokens` | `4000` | 单次探测最大输出 token。320 个整数约 1.3k 字符，给小了会被截断 → 该轮作废、钱白花 |
| `timeoutMs` | `300000` | 每轮超时毫秒，设置可调整，最多 1800000 |
| `parallelProbes` | `true` | 每轮并行调用；串行或并行都不阻塞主会话 |
| `minMatchConfidence` | `0.8` | **判定"通过"的最低置信度。** 即使第一候选与声称模型同名，只要低于此值也判 `inconclusive`（未通过、但不锁定任务） |
| `detailBelowConfidence` | `0.9` | 低于此置信度时，报告里附上**第 2/3/4 名候选**与**每一轮各自的最高候选** |
| `minConfidence` | `0.5` | 只作用于"不一致"侧：低于此置信度时不算 mismatch（不拦截） |
| `weakMatchAction` | `'report'` | 第一候选对上但分数不够时的处理：`report` 只汇报不锁任务 / `block` 与"不一致"同样锁定。**刻意不进设置卡片**，需要更严时改 `cordis.yml` |
| `silentWhenUnknown` | `true` | 旧配置兼容字段，现固定静默跳过库外模型 |
| `blockOnUnknown` | `false` | 旧配置兼容字段，现不对库外模型拦截 |
| `cacheMinutes` | `0` | 旧配置兼容字段，不再用于调度；请重新填写 X1/X2 |
| `modelAliases` | `{}` | 声称模型 id → 库内 id，如 `{"my-gpt5":"gpt-5.4"}` |
| `allowedToolsWhenBlocked` | `['modeltrace_status']` | 锁定时仍放行的工具 |
| `injectVerdict` | `true` | 是否把裁决注入给模型（模型据此向你汇报） |
| `injectOnMatch` | `true` | 一致时也注入一条简短确认 |
| `reportDetail` | `'full'` | `brief` 只给结论 / `full` 附候选概率 |
| `templates` | `{}` | 按语言覆盖任务/约束/干扰句模板池 |
| `bankPath` | `''` | 覆盖内置指纹库路径 |

### 设置界面

在 **设置 → 插件 → ModelTrace** 修改 14 个常用选项。新版设置弹窗消费 `settings.plugins.tab`，旧插件仅挂载 `plugins.item` 导致卡片消失；本版同时注册两个入口。宿主通过 `Config` 的 `.volatile()` 字段下发 `modeltrace` 命名空间，`auto:false` 避免重复自动表单。

更改设置由宿主 `configForms` 写入 profile，并重新装配插件，配置立即生效；正在运行的旧检查随实例释放取消。首次替换本版服务端代码需要重启 DSHA Web，因为当前 profile 的 Host HMR 关闭。此后日常设置改动无需重启。

#### 什么才算"通过"：为什么 55.1% 不算

**第一候选与声称模型同名，本身不是证据。** 评分器是个闭集 softmax：库外模型也会被强行
归到最相似的那一个。55.1% 意味着剩下 44.9% 的概率分散在别的候选上 —— 这是"像，但没像到
能下结论"，不是"通过"。

历史上 `lib/verify.js` 的判定是：

```js
const status = isMatch ? 'match' : (confident ? 'mismatch' : 'inconclusive');
```

`isMatch` 单独就判 `match`，**完全没看概率** —— 于是 55.1% 也被报成「指纹校验通过」。
现在改成两段式（`decideStatus()`，已单独导出以便测试直接钉住）：

```js
const strongEnough = probability >= config.minMatchConfidence;   // 默认 0.8
const status = isMatch
  ? (strongEnough ? 'match' : 'inconclusive')
  : (confident ? 'mismatch' : 'inconclusive');
```

三种结果的区别：

| 情况 | status | 动作 | 模型该说什么 |
| --- | --- | --- | --- |
| 第一候选对上 **且** ≥ `minMatchConfidence` | `match` | 放行 | "指纹校验通过" |
| 第一候选对上 **但** < `minMatchConfidence` | `inconclusive` | **放行**（不锁任务） | "指纹校验未能判定（置信度不足）" |
| 第一候选是别人 且 ≥ `minConfidence` | `mismatch` | 按 `enforce` 拦截 | "声称 X，指纹指向 Y" |

注意"分数不够"**不构成不一致**，所以默认**不锁定任务** —— 它只是降低结论的可信度。
想更严的话把 `weakMatchAction` 设为 `'block'`（见配置表），它就会和"不一致"一样锁住工具、
等你 `/modeltrace allow` 放行；这个开关刻意没放进设置卡片，卡片已经够挤了。

置信度低于 `detailBelowConfidence`（默认 0.9）时，裁决里会多两块内容：

- **候选排行（前 4 名）**：第 2/3/4 名分别是谁、各多少概率；
- **各轮单独归因**：把每一轮的样本**单独**喂给评分器，看那一轮自己最倾向谁。汇总值是这些
  样本的均值，会盖住分歧 —— 逐轮表专门用来暴露"某几轮其实指向别的模型"。

这两块同时进入给模型的指令和给用户的报告，模型被明确要求把它们**完整**转述。
`test/verdict-threshold.mjs` 专门钉住这条链路（含"退回旧写法必须变红"的变异测试）。

#### 浏览器半侧与设置入口

浏览器模块使用 `configForms.get({ namespace: 'modeltrace' })`，通过
`whileServed()` 等待宿主下发配置。卡片同时注册到 `settings.plugins.tab` 和
`plugins.item`；结果窗注册到会话的 `conversation.session.header.utilities`。
14 个设置字段和默认值与 Host schema 保持一致，测试会检查两侧是否漂移。

浏览器 bundle 使用宿主的 lazy-CJS 加载器，只依赖平台提供的 `react`。
`package.json` 必须导出 `./package.json`，以便宿主发现 client 模块。
同源结果接口 `/api/modeltrace?sessionId=...` 执行宿主的认证与来源检查，只返回对应会话的状态。

当前安装没有运行 `pnpm run dev:web` 构建监听器。首次替换完整插件后重启 DSHA Web，
随后刷新当前页面；日常设置写入由宿主重新装配插件并即时生效。

自备提示词模板（防优化最强的一档）：

```yaml
- id: modeltrace
  config:
    rounds: 4
    templates:
      task:
        zh:
          - "凭直觉依次写下 {count} 个 1 到 355 的整数，可重复。"
          - "为下面 {count} 个位置各挑一个 1~355 的数，允许撞车。"
      constraint:
        zh:
          - "只能由你当场直接给出，不得借助任何工具或外部随机源，不得等差或按规律生成。"
      background:
        zh:
          - "以下内容是格式示例，与你要做的事无关。"
```

---

## ⚠️ 这个评分器的能力边界（必读）

指纹库是**闭集**，只有 GPT 与 Claude 两家共 17 个模型。这意味着：

- **任何库外模型都会被强行归到最像的那一个**，并且给出一个很高的"置信度"。实测中
  `deepseek-flash` 被归成了 `gpt-6-sol / 98.1%` —— 这个 98.1% **不是证据**，只是闭集里
  最接近的那个。
- 上游 README 原文也写了："若待测模型不在指纹库中，得到任何结果都是有可能的"。
- 所以插件在**声称模型不在库内时直接短路**（`unknown`、不发探针、不拦截）。这是唯一
  诚实的处理方式。只有在"声称模型确实在库内"时，比对结果才有参考意义。
- 如果你的日常模型是 DeepSeek 系（不在库内），这个插件对你**保持静默跳过**，
  除非你把该模型加入指纹库（需要自己按上游 `bank_builder.py` 采集建库）。

---

## 声称模型从哪里读（踩过的坑）

"用户当前选择的模型"必须从**会话**读，不能从 `agent.options` 读 —— 后者是官方
`dsh-api-session-controller/lib/types/agent.js:506` 在**创建 agent 那一刻**对全局默认拍的
快照，之后用户在界面上换模型它**永不更新**。实测踩到的坑：重启 DSH 时停在 `gpt-6-sol`，
agent 就以 `gpt-6-sol` 创建并被冻住；用户切回 `deepseek-flash` 后请求确实走 deepseek-flash，
但插件仍报 `gpt-6-sol`，于是把库外模型错当成库内模型去比对，还给出了假的 98.1%。

现在的优先级（前两个才是真来源）：

| 顺序 | 来源 | 含义 |
| --- | --- | --- |
| 1 | `session-pending` | 会话选择投影的 pending —— 你刚切、还没用过 |
| 2 | `session-last-used` | 会话选择投影的 lastUsed —— 本会话实际在用 |
| 3 | `request-header` | 上一次请求头里实际发出过的路由 |
| 4 | `agent-options-snapshot` | ⚠️ agent 创建时的快照（可能已过期） |
| 5 | `global-default` | ⚠️ 全局默认（兜底） |

`/modeltrace status` 会同时列出**全部五个来源**的取值，声称错了能一眼看出是哪个来源的问题。

---

## 指纹库

内置 `assets/unified_bank.json`（882659 字节），由指定的 [git.yylx.win 镜像](https://git.yylx.win/raw.githubusercontent.com/xqy2006/ModelTrace/main/data/unified_bank.json) 仅下载该数据文件。构建时间 `2026-09-30T22:05:57.774800+00:00`，SHA-256 `e514c76928ea38d23bc0f14d3935f23c97b1efb6d96b18a19bdc88ad2d830536`。评分器和挑战提示词保持原实现。

覆盖 GPT 与 Claude 两个家族共 **17 个模型**：

- `gpt-5.4`
- `gpt-5.5`
- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`
- `gpt-6-astra`
- `gpt-6-sol`
- `gpt-6-luna`
- `claude-haiku-4-5-20251001`
- `claude-sonnet-4-6`
- `claude-sonnet-5`
- `claude-opus-4-6`
- `claude-opus-4-7`
- `claude-opus-4-8`
- `claude-opus-5`
- `claude-opus-5-5`
- `claude-sonnet-5-5`

其他模型直接跳过，不产生探针调用或裁决提示。

上游免责同样适用：指纹库是**候选库内**的归因；系统提示词会显著影响采样偏好，作者不建议在 Claude Code 里测。

---

## 测试

```bash
cd /root/dsha-modeltrace && npm test
```

核心测试都是离线的（假 LLM 喂的是上游仓库的**真实参考回答**，所以评分链路是真的）：

| 文件 | 覆盖 |
| --- | --- |
| `test/scorer-regression.mjs` | 评分器移植保真度：16 模型 × 3 回答逐条判定是否与库内 id 一致 |
| `test/cadence-background.mjs` | X1/X2 优先级、空值/0、消息去重、后台非阻塞、忙时排队、定时触发、旧结果丢弃与取消 |
| `test/session-probe.mjs` | 真实宿主 keyless 组合：新会话、固定模型路由、无工具/历史、成功/失败/取消/超时与清理 |
| `test/gate-e2e.mjs` | 门控行为：一致放行 / 不一致拒绝 `bash` 且仍放行 `modeltrace_status` / 库外短路不发探针 / 解锁恢复 / 换模型自动重测 / 3 个回合只发 3 次探针 |
| `test/plugin-load.mjs` | `apply()` 装载、钩子与命令注册、命令各子命令、组卷可复现、同义不同词抽样覆盖 |
| `test/client-bundle.mjs` | 浏览器半侧契约：lazy-CJS 注册、只 require 平台种子词、槽位键 = 命名空间、**字段表/默认值与 Host `SettingsSchema` 防漂移**（已做变异测试验证非空断言） |
| `test/client-bundle-stub.mjs` | 浏览器半侧渲染：14 个字段、控件数量与上下界、写入/重置调用、summary 视图、`ownerProps = {}` 回落 |

`npm run test:client-host` 另跑两个**依赖本机 DSH 安装路径**的测试（故不并入 `npm test`）：

| 文件 | 覆盖 |
| --- | --- |
| `test/client-bundle-host-resolve.mjs` | 用**真实宿主 `ClientModuleRegistry.resolveMeta()`** 验证本包被解析成 client bundle。它钉住的正是 `exports["./package.json"]` 那个坑。 |
| `test/theme-contrast.mjs` | **设置卡片的可读性**：跑一遍 bundle 抓出注入的 CSS，再按 WCAG 2.1 逐条算颜色对比度（见下节）。 |

`test/fixtures/reference-sample.jsonl` 是从上游 `data/*_reference.jsonl` 抽出的真实回答（16 模型 × 3 条，147 KB）。
`test/fixtures/dsw-tokens.json` 是从全部客户端 bundle 里刮出的 358 个**真正被赋值过**的 `--dsw-*` 设计令牌。

---

## 设置卡片"灰成一片"事故复盘

第一版卡片上线后，界面上的文字和选项**全部呈浅灰、几乎看不清**，长标签还被挤成竖排。

**根因一（颜色）**：CSS 里写了 `color:var(--dsh-text,#e6e6e6)`，但 **`--dsh-*` 这个命名空间根本不存在** ——
DSH web 的设计令牌是 `--dsw-alias-*` / `--dsw-static-*` / `--dsw-font-*`。浏览器于是取回退值 `#e6e6e6`，
在浅色主题的白底上对比度只有 **1.25:1**（WCAG AA 要求 4.5:1）。

**根因二（布局）**：`.mt-row-top` 是单行 flex，`label{flex:1}` + `control{flex:0 0 auto}`，
窄屏下拉长的下拉框会把标签压成竖排。

**修法**：全部改用 `--dsw-alias-*` 令牌且**每个都带回退值**；行布局改成官方
`dsh-client-ui-settings-plugins` 的 `fields.module.css` 惯用法（布尔控件的 checkbox 留在标题行，
数字/枚举控件另起一行）；错误态不再用低对比红字，改为**红色调表面 + 红色边框 + 主文字色**。

三个防回归手段：

1. `test/client-bundle.mjs` 断言卡片 CSS **只引用真实存在的令牌**（对照 `test/fixtures/dsw-tokens.json`）、
   不再出现 `--dsh-*`、文字颜色一律走令牌、每个令牌都带回退值。
2. `test/client-bundle-stub.mjs` 断言宽控件必须独占一行、标题行里不许有 input/select。
3. `test/theme-contrast.mjs` 做**量化**守门：它不看你"打算"用什么令牌，而是跑一遍 bundle 抓出真实的 CSS，
   解析每条规则的 `color` / `background`（取最后一条，符合 CSS 层叠），把 `var()` 链解开
   （令牌未定义时落回退值，**带 alpha 的背景先按 alpha 合成**），再算对比度：正文 ≥4.5:1、提示级小字 ≥3:1。
   末尾还有一条反向断言 —— 当年那个 `#e6e6e6` 必须仍被判为不合格 —— 保证测试有分辨力。

四个手工变异（错误文字改回红字 / 禁用态改回 tertiary / 主文字色换成 `#e6e6e6` / hint 换回退值）**全部被抓到**。

> ⚠️ 令牌规则：只使用 `test/fixtures/dsw-tokens.json` 里出现过的 `--dsw-*`。
> 已知 `--dsw-alias-label-error` 和 `--dsw-alias-bg-layer-4` **在上游全仓从未被赋值**（官方 settings-plugins 自己也引用了后者），
> 本插件已分别改用 `--dsw-alias-state-error-primary` 与 `--dsw-alias-interactive-bg-hover`。

首次升级包含 Host 代码的本版插件，需要重启 DSHA Web 并刷新页面。
当前 web profile 禁用了 Host HMR；仅刷新浏览器无法替换已经加载的服务端模块。
日常更改设置会触发宿主重新装配，不需要手动重启。


---

## 实现要点

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 插件对象默认导出：`name` + `Config` + `apply(ctx, config)` |
| `lib/config.js` | Schemastery `Config` + `resolveConfig()` 防御性兜底 |
| `lib/prompts.js` | 提示词模板池、组卷器、`planRounds()` 多轮计划 |
| `lib/scorer.js` | ModelTrace 评分算法（自上游 `fingerprint-core.mjs` 原样移植） |
| `lib/verify.js` | 指纹库加载/匹配、`runProbe()` 隔离调用、`verifyModel()` |
| `lib/session-probe.js` | 实验性极简真实 DSH 会话的创建、固定路由、收集与释放 |
| `lib/gate.js` | 后台调度与门控状态机 + 钩子挂载（`agent/session-start` / `agent/pre-step` / `tools/pre-execute` / `agent/disposed`） |
| `lib/report.js` | 给模型的裁决文案与给你的 markdown 报告 |
| `lib/client.js` | 浏览器半侧设置卡片（手写 lazy-CJS，唯一 require 是 `react`） |
| `lib/tool.js` / `lib/command.js` | `modeltrace_status` 工具与 `/modeltrace` 命令 |

遵循的官方红线：注册即 effect（一律 `ctx.effect()` / `ctx.on()` / 服务 `register()`，不手动 removeListener）；
waterfall 监听器必定调用 `next()`；不硬编码可调参数（全部进 `Config`）；探针不复用 agent 上下文，也不带 `purpose` 字段
（`GenerateOptions.purpose` 只允许 `'compaction' | 'session-title'`）；凭据由适配器自己解析，插件不碰。

## 变更记录

### 0.1.2 — DSH 0.1.7-alpha.2 兼容与后台校验

- 补齐新版设置弹窗槽位，增加 X1/X2 调度规则、5 分钟超时、校验方式与独立悬浮窗开关。
- 自动校验后台运行，裁决通过日志化的 `agent.inject` 写入主会话；新增可关闭、下次重显的候选/逐轮结果悬浮窗。
- 实验性极简 DSH 会话默认关闭，固定路由、禁止工具、防递归并清理辅助 agent。
- 仅更新统一指纹库到 2026-09-30 的 17 模型版本，保持原评分器与挑战提示词。



### 0.1.1 — 修复 v4 source kind 导致会话写入失败

**症状**：新会话首个 step 报
`SessionFormatError: format v4 message requires a producer-owned source kind`，
该回合的会话追加失败，此后每个新会话都会被污染。

**根因**：插件用 v3 已退役的写法 `source: { kind: 'plugin', plugin: '<name>' }` 构造注入消息。
DSH 0.1.7 的原生 v4 写入路径（`releasedV4SessionFormatCodec.encodeEvent` →
`assertV4RowAdmission` → `source()`）**只接受 producer-owned kind**，`kind === 'plugin'`
一律拒收；v3→v4 迁移里的 `rewriteV3MessageSource()` 只作用于 v3 老文件，救不了运行期注入。

**修复**（3 处调用点 + 1 处注释）：

| 文件 | 位置 | 作用 |
| --- | --- | --- |
| `lib/gate.js` | `verdictMessage()` | `agent/pre-step` 注入的裁决消息（真正触发报错的那条） |
| `lib/verify.js` | `runProbe()` | 探针 user 消息 |
| `lib/command.js` | `/modeltrace allow` | 放行后注入的提示消息 |
| `lib/index.js` | 文件头注释 | 与实际写法同步 |

统一改为 `source: { kind: \`plugin:${PLUGIN}\` }`（即 `plugin:dsh-modeltrace`）。

**新增回归测试**：`test/source-kind-regression.mjs` —— 静态扫描 `lib/` 不得再出现
`kind: 'plugin'` 字面量，并在可解析到 DSH 校验器时动态确认「退役写法被拒 / 正确写法放行」；
`test/gate-e2e.mjs` 另加 5 条断言，钉死注入消息的 `source.kind === 'plugin:dsh-modeltrace'`
且不带退役字段 `plugin`。

## 许可

评分算法与指纹库版权归上游 [xqy2006/ModelTrace](https://github.com/xqy2006/ModelTrace) 作者；本插件为 DSH 封装。
