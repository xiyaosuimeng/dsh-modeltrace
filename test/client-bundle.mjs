/**
 * 浏览器半侧（lib/client.js）的离线验证台。
 *
 * 它模拟 DSH 客户端模块加载器与槽位服务的**真实契约**，验证：
 *  1. bundle 的 loader 包装形状正确（window.__ModuleLoader__.load({id, factory})）；
 *  2. factory 在桩 require 下能跑出 exports，且只 require 平台种子词；
 *  3. apply() 注册卡片的槽位键、命名空间键、组件形态都对得上官方契约；
 *  4. inject 回调的返回值符合 `() => SlotInjectionEffect`（单个 disposer 或 disposer 的可迭代）；
 *  5. **浏览器半侧镜像的字段表与 Host 侧 SettingsSchema 完全同构**（防漂移）。
 *
 * 注意：这里**不渲染 React 组件**（DSH 的 react 由页面提供，Node 里没有）。
 * 「卡片在真实浏览器里长什么样」不在本测试的覆盖范围内，报告里已如实标注。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Config, SettingsSchema, resolveConfig, SETTINGS_NAMESPACE } from '../lib/config.js';

let loaded = null;
globalThis.window = globalThis;
globalThis.__ModuleLoader__ = {
  load(spec) {
    loaded = spec;
  },
};

await import('../lib/client.js?client-bundle-test');

const checks = [];
const check = (label, fn) => {
  try {
    const ok = fn();
    checks.push([label, ok === undefined ? true : Boolean(ok)]);
  }
  catch (error) {
    checks.push([label, false, error instanceof Error ? error.message : String(error)]);
  }
};

check('bundle 通过 window.__ModuleLoader__.load 注册自己', () => loaded !== null);
check('bundle id 是 dsh-modeltrace', () => loaded?.id === 'dsh-modeltrace');
check('bundle 暴露 factory 函数', () => typeof loaded?.factory === 'function');

// --- 桩 require：只放行平台种子词，其它一律炸出来（纯净度门禁的离线等价物）---
const visitedModules = [];
const reactStub = {
  createElement: (...args) => ({ $$el: args }),
  Fragment: Symbol('react.Fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  memo: (fn) => fn,
};
const jsxRuntimeStub = {
  jsx: reactStub.createElement,
  jsxs: reactStub.createElement,
  Fragment: reactStub.Fragment,
};
const fakeRequire = (id) => {
  visitedModules.push(id);
  if (id === 'react') return reactStub;
  if (id === 'react/jsx-runtime') return jsxRuntimeStub;
  throw new Error(`bundle 试图 require 未被允许的模块：${id}`);
};

let client = null;
check('factory(fakeRequire) 能跑出 exports', () => {
  client = loaded.factory(fakeRequire);
  return client !== null && typeof client === 'object';
});
check('bundle 只 require 平台种子词（无跨插件值导入）',
  () => visitedModules.every((id) => id === 'react' || id === 'react/jsx-runtime'));
check('exports 是 cordis 插件形状 {name, inject, apply}',
  () => typeof client?.name === 'string' && Array.isArray(client?.inject) && typeof client?.apply === 'function');
check('客户端插件名与包名一致', () => client?.name === 'dsh-modeltrace');

// --- 用与官方相同的契约驱动 apply() ---
const slotInjections = [];
const registrations = [];
const scopeBindings = [];
const servedNamespaces = [];
let injectReturnShape = null;

// --- 假 document：接住 injectStyles() 注入的 <style>，供主题令牌断言检查 ---
const injectedStyles = [];
globalThis.document = {
  querySelector: () => null,
  createElement: () => {
    const tag = { dataset: {}, textContent: '' };
    injectedStyles.push(tag);
    return tag;
  },
  head: { appendChild: () => {} },
};
const readCardCss = () => injectedStyles.map((tag) => tag.textContent).join('\n');

const slotsStub = {
  inject(key, callback) {
    const effect = callback();
    slotInjections.push(key);
    injectReturnShape = Array.isArray(effect) ? 'array'
      : (effect !== null && typeof effect === 'object' && typeof effect[Symbol.iterator] === 'function') ? 'iterable'
        : typeof effect;
    return () => {};
  },
  register(spec, component) {
    registrations.push({ spec, component });
    return () => {};
  },
};
// 真实契约见 dsh-client-ui-settings/lib/client.js 的 ConfigForms / ConfigFormController：
// configForms.get(ns) → 表单控制器，有 getSnapshot() / subscribe(listener) / set(field,value) /
// unset(field) / mutate(ops, expectedRevision)；configForms.whileServed(nss, register) 只在宿主
// 提供该命名空间时才跑 register，返回一个 disposer。
const configFormsStub = {
  whileServed(namespaces, register) {
    servedNamespaces.push(namespaces);
    return register(new Set(namespaces));
  },
  get(namespace) {
    scopeBindings.push({ namespace });
    const snapshot = { status: 'ready', value: { ...resolveConfig({}) }, base: {}, user: {}, revision: '1', writable: true, mode: 'user' };
    return {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      set: async () => {},
      unset: async () => {},
      mutate: async () => {},
    };
  },
};
const clientCtx = {
  effect: (fn) => fn(),
  inject: (keys, callback) => callback({ slots: slotsStub, configForms: configFormsStub, effect: (fn) => fn() }),
};

check('apply() 不抛异常', () => {
  client.apply(clientCtx);
  return true;
});
check('设置弹窗与插件面板均注册官方入口', () => slotInjections.includes('plugins.item') && slotInjections.includes('settings.plugins.tab'));
check('结果窗注册session槽位并绑定sessionId', () => {
  const row = registrations.find(row => row.spec.name === 'conversation.session.header.utilities');
  return row?.spec.inject('test-session').sessionId === 'test-session';
});
check('inject 回调返回的是合法 SlotInjectionEffect（单 disposer 或可迭代）',
  () => injectReturnShape === 'function' || injectReturnShape === 'iterable' || injectReturnShape === 'array');
check('卡片仅在该命名空间被宿主提供时才注册（whileServed）',
  () => servedNamespaces.length === 1 && JSON.stringify(servedNamespaces[0]) === JSON.stringify([SETTINGS_NAMESPACE]));
check('卡片以 settings 命名空间为 id 注册', () => registrations[0]?.spec?.id === SETTINGS_NAMESPACE);
check('卡片注册声明了槽位名', () => registrations[0]?.spec?.name === 'plugins.item');
check('卡片组件是函数组件（或 memo 包装）', () => typeof registrations[0]?.component === 'function');
check('configForms 绑定到 modeltrace 命名空间',
  () => scopeBindings[0]?.namespace === SETTINGS_NAMESPACE);
check('configForms 的命名空间与 Host 侧常量一致', () => SETTINGS_NAMESPACE === 'modeltrace');

// --- 关键：镜像的字段表不能与 Host 侧 schema 漂移 ---
const schemaJson = SettingsSchema.toJSON();
// Schemastery 的 toJSON 是「引用图」：顶层 {uid, refs}，根对象节点在 refs[uid]，字段表在它的 dict。
const schemaRoot = schemaJson.refs?.[String(schemaJson.uid)] ?? schemaJson;
const schemaFields = Object.keys(schemaRoot.dict ?? {}).sort();
const clientFields = (client?.FIELDS ?? []).map((field) => field.key).sort();
check('浏览器半侧的字段表与 SettingsSchema 完全同构',
  () => schemaFields.length > 0 && JSON.stringify(clientFields) === JSON.stringify(schemaFields));

// --- 设置页可见性的真正来源：宿主 dsh-settings 是从插件导出的 **Config** 里用
// volatileForm() 筛出带 `.volatile()` 的字段来生成表单的（不是 SettingsSchema）。
// 一个 volatile 字段都没有 → volatileForm() 返回 undefined → describe() 跳过该 entry →
// 命名空间不下发 → configForms.whileServed() 永假 → 卡片永不注册。当前 Config 已满足这道闸；
// 另一道可见性闸是 settings.plugins.tab 注册，上面的双入口断言覆盖它。Config 的 volatile 叶子必须与 SettingsSchema
// 的字段集完全一致 —— 既保证设置页有东西可显示，也保证两个 schema 不会各自漂移。
const configRoot = (() => {
  const json = Config.toJSON();
  return json.refs?.[String(json.uid)] ?? json;
})();
// toJSON 是引用图：dict 里存的是 ref 编号（数字），节点体在 refs 里，逐个解引用。
const configRefs = Config.toJSON().refs ?? {};
const deref = (node) => (typeof node === 'number' ? configRefs[String(node)] : node);
const volatileLeaves = [];
(function walk(node, prefix = '') {
  const current = deref(node);
  if (current === undefined) return;
  for (const [key, child] of Object.entries(current.dict ?? {})) {
    if (deref(child)?.meta?.volatile) volatileLeaves.push(prefix + key);
    walk(child, `${prefix}${key}.`);
  }
})(configRoot);
check('Config 的 volatile 字段与表单一致（宿主设置页的真实数据源）',
  () => JSON.stringify([...volatileLeaves].sort()) === JSON.stringify(schemaFields));
check('高级项刻意保持非 volatile（不进设置页）',
  () => !volatileLeaves.includes('maxTokens') && !volatileLeaves.includes('modelAliases')
    && !volatileLeaves.includes('bankPath') && !volatileLeaves.includes('transports'));

check('浏览器半侧默认值与 Host 侧 resolveConfig({}) 一致', () => {
  const host = resolveConfig({});
  // 逐字段比较（不比较键序：Schemastery 的 dict 顺序与镜像表顺序无契约关系）
  return schemaFields.every((key) => {
    // Optional intervals are empty strings on the config wire, null in the runtime.
    const value = ['intervalMessages', 'intervalSeconds'].includes(key) && host[key] === null ? '' : host[key];
    return client?.DEFAULTS?.[key] === value;
  })
    && Object.keys(client?.DEFAULTS ?? {}).length === schemaFields.length;
});

// --- 主题令牌回归：卡片整体发灰那次事故的守门断言 ---------------------------
// 事故：CSS 里写了一个不存在的 `--dsh-text`，回退值 #e6e6e6 在浅色主题下就是「一片灰」。
// DSH web 的设计令牌命名空间是 `--dsw-alias-*` / `--dsw-static-*` / `--dsw-font-*` …
const tokenFixture = JSON.parse(readFileSync(new URL('./fixtures/dsw-tokens.json', import.meta.url), 'utf8'));
const knownTokens = new Set(tokenFixture.tokens);
const cssText = readCardCss();

check('卡片的 CSS 只引用真实存在的 DSH 设计令牌', () => {
  const used = [...new Set((cssText.match(/var\(\s*(--[a-z0-9-]+)/g) ?? [])
    .map((m) => m.replace(/var\(\s*/, '')))];
  const unknown = used.filter((token) => !knownTokens.has(token));
  if (unknown.length > 0) console.log('    未知名令牌:', unknown.join(', '));
  return unknown.length === 0 && used.length > 0;
});

check('卡片 CSS 不再出现不存在的 --dsh-* 命名空间', () => /--dsh-/.test(cssText) === false);

check('卡片里的文字颜色一律走令牌，不硬编码', () => {
  // 只允许 `color:var(--token…)`；禁止 `color:#rgb` / `color:white` 之类直接写死
  const colors = cssText.match(/[;{]\s*color\s*:\s*[^;}]+/g) ?? [];
  return colors.length > 0 && colors.every((decl) => /color\s*:\s*var\(--/.test(decl));
});

check('每个令牌都带中性回退值（令牌缺席时至少可读）', () => {
  const calls = cssText.match(/var\(\s*--[a-z0-9-]+[^)]*\)/g) ?? [];
  const missing = calls.filter((call) => !call.includes(','));
  if (missing.length > 0) console.log('    没有回退值的令牌:', missing.join(', '));
  return calls.length > 0 && missing.length === 0;
});

check('每个字段都带 label 与控件类型',
  () => (client?.FIELDS ?? []).every((field) => typeof field.key === 'string'
    && typeof field.label === 'string' && typeof field.type === 'string'));

console.log('=== 浏览器半侧 bundle ===');
console.log(`  bundle id / 插件名 : ${loaded.id} / ${client.name}`);
console.log(`  require 过的模块   : ${[...new Set(visitedModules)].join(', ') || '(无)'}`);
console.log(`  槽位注册           : ${slotInjections.join(', ')} → key=${registrations[0]?.spec?.key}`);
console.log(`  镜像字段(${clientFields.length})      : ${clientFields.join(' ')}`);
console.log(`  Host schema(${schemaFields.length})     : ${schemaFields.join(' ')}`);

let failed = 0;
for (const [label, ok, detail] of checks) {
  if (ok) {
    console.log(`  PASS  ${label}`);
  }
  else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? '' : `  (${detail})`}`);
  }
}
console.log(failed === 0 ? '\n浏览器半侧全部通过。' : `\n存在失败：${failed} 条。`);
process.exit(failed === 0 ? 0 : 1);
