/**
 * 设置页可见性回归测试 —— 直接拉起宿主 `@deepseek-ai/dsh-settings` 跑真实的
 * `describe()` / `write()`。
 *
 * 宿主 describe() 只保留 Config 的 volatile 字段。这是设置可见性的数据闸：
 * 缺失时命名空间不下发，configForms.whileServed() 永远为假。
 * 当前 Config 已通过此闸；前端还必须注册设置弹窗消费的 settings.plugins.tab，
 * 双入口注册由 client-bundle.mjs 覆盖。本测试使用真 schema、fiber、describe/write。
 */
import { Context } from '@deepseek-ai/cordis';
import SettingsForms from '@deepseek-ai/dsh-settings';
import { Context as CordisContext } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import plugin from '../lib/index.js';

const NS = 'modeltrace';
let ok = true;
const check = (label, pass) => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) ok = false;
};

// ---- 宿主环境：一个真实的 cordis 根上下文 + 真实的 settings 服务 ----------------
// configEditor / profileContext 是 settings 服务的两个注入依赖，这里用最小实现替身：
// 只填 describe()/write() 真正会读的那几个方法，其余留给被测代码的自然路径。
const root = new Context();
root.loader = { await: async () => {} };

const modeltraceEntry = { id: NS, options: { id: NS, name: 'dsh-modeltrace', config: {} } };
const plainEntry = { id: 'plain-plugin', options: { id: 'plain-plugin', name: 'plain-plugin', config: {} } };

const editor = {
  documentPath: '/tmp/dsh-modeltrace-settings-test.yml',
  configuration: () => [
    { entry: modeltraceEntry, inherited: {}, override: {} },
    { entry: plainEntry, inherited: {}, override: {} },
  ],
  entries: () => [modeltraceEntry, plainEntry],
  inherited: () => ({}),
  // 模拟 configEditor 的真实契约：把 change(raw, inherited) 的结果落回 entry.config。
  async edit(target, change) {
    target.options.config = change(structuredClone(target.options.config ?? {}), {}) ?? target.options.config;
  },
};
root.configEditor = editor;
root.profileContext = { dir: '/tmp', installAnchor: '/tmp' };

const settings = new SettingsForms(root);
check('宿主 settings 服务可用', typeof settings.describe === 'function');

// ---- 挂载本插件：拿到真实 fiber ------------------------------------------------
const mounted = root.plugin(plugin, {});
await mounted.await();

// ⚠️ ctx.plugin() 返回的是 Object.create(fiber) 包装体（带 then），
// 而 describes() 是按 entry.fiber 这个"真身"去查设置的呈现策略的。
// 真实 loader 里 entry.fiber 就是这个真身，所以这里从 configure() 的记录里取回来。
const pluginFiber = [...settings.presentations.keys()][0];
check('插件 apply 时确实声明了设置页策略（configure 被调用）', settings.presentations.size === 1);
check('策略是 auto:false —— 关掉宿主自动页，避免和自带卡片重复', settings.presentations.get(pluginFiber)?.auto === false);
modeltraceEntry.fiber = pluginFiber ?? mounted;
check('插件 fiber 处于 active 状态（describe 只认 state===2）', modeltraceEntry.fiber.state === 2);

// ---- 反向对照：一个没有 volatile 字段的插件，必须被判为"不可配置" --------------
const plainFiber = root.plugin({
  name: 'plain-plugin',
  Config: z.object({ alpha: z.boolean().default(true), beta: z.number().default(1) }),
  apply() {},
});
await plainFiber.await();
plainEntry.fiber = plainFiber;

// ---- 断言 1：命名空间被下发（这就是"设置不显示"那个 bug 的守门断言）------------
const descriptors = settings.describe({ redactSecrets: true });
const mine = descriptors.find((row) => row.ns === NS);
check('describe() 下发了 modeltrace 命名空间（bug 回归守门）', mine !== undefined);
check('没有 volatile 字段的插件被跳过（反向对照，证明断言 1 确实在测 volatile）',
  descriptors.every((row) => row.ns !== 'plain-plugin') && descriptors.length === 1);

// ---- 断言 2：表单字段恰好是可编辑旋钮 --------------------------------------
const formJson = mine?.schema ?? {};
const formRoot = formJson.refs?.[String(formJson.uid)] ?? formJson;
const formFields = Object.keys(formRoot.dict ?? {}).sort();
check('表单字段恰好是 14 个可调旋钮', JSON.stringify(formFields) === JSON.stringify([
  'countMax', 'countMin', 'detailBelowConfidence', 'enabled', 'enforce', 'floatingWindow',
  'injectOnMatch', 'injectVerdict', 'intervalMessages', 'intervalSeconds', 'minMatchConfidence', 'rounds', 'timeoutMs', 'verificationMode']));
check('高级项没有泄漏进设置页（模板池 / 指纹库路径 / token 上限 / 别名表）',
  ['templates', 'bankPath', 'maxTokens', 'modelAliases', 'transports', 'languages']
    .every((key) => !formFields.includes(key)));

// ---- 断言 3：describe() 带回的当前值与真实运行期配置一致 -----------------------
check('describe() 的值等于 Config 默认值', Object.entries({
  enabled: true, enforce: 'block', rounds: 3, countMin: 218, countMax: 400,
  minMatchConfidence: 0.8, detailBelowConfidence: 0.9, injectOnMatch: true,
  intervalMessages: '', intervalSeconds: '', verificationMode: 'probe', floatingWindow: true, injectVerdict: true, timeoutMs: 300000,
}).every(([key, value]) => mine?.value[key] === value));
check('applies 为 live', mine?.applies === 'live');

// ---- 断言 4：写入通道 ---------------------------------------------------------
let volatileWriteError = null;
try {
  await settings.write(NS, (value) => ({ ...value, rounds: 5, enforce: 'warn' }), undefined, [['rounds'], ['enforce']]);
} catch (error) {
  volatileWriteError = error;
}
check('volatile 字段可写（设置页能存住改动）', volatileWriteError === null);

let nonVolatileError = null;
try {
  await settings.write(NS, (value) => ({ ...value, maxTokens: 1234 }), undefined, [['maxTokens']]);
} catch (error) {
  nonVolatileError = error;
}
check('非 volatile 字段被宿主拒绝写入（高级项只能走 cordis.patch.yml）',
  /is not volatile/.test(String(nonVolatileError?.message ?? '')));

console.log(ok ? '\n设置页可见性全部通过。' : '\n设置页可见性存在失败。');
process.exit(ok ? 0 : 1);
