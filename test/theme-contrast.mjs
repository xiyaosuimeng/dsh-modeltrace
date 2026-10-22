/**
 * 主题对比度验证台 —— 「设置界面灰成一片」那次事故的量化守门。
 *
 * 事故复盘：`lib/client.js` 里写了 `color:var(--dsh-text,#e6e6e6)`。
 * `--dsh-text` 这个命名空间**根本不存在**（DSH web 用 `--dsw-alias-*`），
 * 于是浏览器取回退值 `#e6e6e6`；在浅色主题的白底上，那个颜色的对比度是
 * **1.25:1**（WCAG AA 要求 4.5:1），肉眼就是「一片灰」。
 *
 * 本测试**不看作者"打算"用什么令牌**，而是：
 *   1. 用真实的 loader 契约跑一遍 `apply()`，把 `injectStyles()` 注入的 CSS 抓出来；
 *   2. 解析每条规则里的 `color` / `background` 声明；
 *   3. 用真实主题 bundle 的令牌取值把 `var()` 链解开（未定义时落到 CSS 自带的回退值）；
 *   4. 按 WCAG 2.1 算实际对比度。
 *
 * 也就是说，它验的是「浏览器最终会把字画成什么颜色」，而不是源码里有没有写 `var()`。
 *
 * 依赖 `/usr/local/lib/node_modules/@deepseek-ai/dsh` 的绝对路径（环境相关），
 * 因此归在 `npm run test:client-host` 里，不并入默认的 `npm test`。
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const DSH = '/usr/local/lib/node_modules/@deepseek-ai/dsh';
const THEME = `${DSH}/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js`;
const BUNDLE = new URL('../lib/client.js', import.meta.url);

if (!existsSync(THEME)) {
  console.log(`跳过：找不到主题 bundle（${THEME}）。`);
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * 1. 用真实 loader 契约跑一遍 bundle，抓住注入的 CSS
 * ------------------------------------------------------------------ */

let loaded = null;
globalThis.window = globalThis;
globalThis.__ModuleLoader__ = { load(spec) { loaded = spec; } };

const injected = [];
globalThis.document = {
  querySelector: () => null,
  createElement: () => {
    const tag = { dataset: {}, textContent: '' };
    injected.push(tag);
    return tag;
  },
  head: { appendChild: () => {} },
};

await import(`${BUNDLE.href}?theme-contrast`);

const reactStub = {
  createElement: (...args) => ({ $$el: args }),
  Fragment: Symbol('react.Fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useMemo: (f) => f(),
  useRef: (v) => ({ current: v }), useCallback: (f) => f, memo: (f) => f,
};
loaded.factory((id) => {
  if (id === 'react') return reactStub;
  if (id === 'react/jsx-runtime') return { jsx: reactStub.createElement, jsxs: reactStub.createElement, Fragment: reactStub.Fragment };
  throw new Error(`未允许的模块：${id}`);
}).apply({
  effect: (fn) => fn(),
  inject: (_keys, cb) => cb({
    effect: fn => fn(),
    slots: { inject: (_k, f) => { f(); return () => {}; }, register: () => () => {} },
    configForms: { whileServed: (_ns, fn) => fn(), get: () => ({ getSnapshot: () => ({ status: 'ready', value: {}, writable: true }), subscribe: () => () => {}, set: async () => {}, unset: async () => {}, mutate: async () => {} }) },
  }),
});

const css = injected.map((tag) => tag.textContent).join('\n');
assert.ok(css.length > 200, '没能从 bundle 里抓到注入的 CSS（loader 契约变了？）');

/* ------------------------------------------------------------------ *
 * 2. 解析主题令牌（浅色 / 深色两套）
 * ------------------------------------------------------------------ */

const themeSrc = readFileSync(THEME, 'utf8');

function blocks(selector) {
  const out = [];
  let from = 0;
  for (;;) {
    const i = themeSrc.indexOf(`${selector}{`, from);
    if (i < 0) return out;
    let depth = 0;
    let j = i + selector.length;
    for (; j < themeSrc.length; j += 1) {
      if (themeSrc[j] === '{') depth += 1;
      else if (themeSrc[j] === '}') { depth -= 1; if (depth === 0) break; }
    }
    out.push(themeSrc.slice(i + selector.length + 1, j));
    from = j + 1;
  }
}

function merge(selector) {
  const map = new Map();
  for (const block of blocks(selector)) {
    for (const decl of block.split(';')) {
      const k = decl.indexOf(':');
      if (k < 0) continue;
      const name = decl.slice(0, k).trim();
      if (name.startsWith('--')) map.set(name, decl.slice(k + 1).trim());
    }
  }
  return map;
}

/** 顺着 `var(--x)` 链解到字面颜色；链断了返回 null。 */
function deref(map, name, depth = 0) {
  if (depth > 12) return null;
  const value = map.get(name);
  if (value === undefined) return null;
  const m = value.match(/^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]*))?\)$/);
  if (m) return deref(map, m[1], depth + 1) ?? (m[2] ? literal(m[2]) : null);
  return literal(value);
}

function literal(text) {
  const t = String(text).trim();
  return /^#[0-9a-f]{3,8}$/i.test(t) ? t : null;
}

/**
 * 把 CSS 声明里的颜色值解析成字面颜色：`var(--x, fallback)` 时，
 * 令牌在主题里没定义就落到 fallback —— 这正是浏览器干的事。
 */
function resolveCssColor(map, value) {
  const direct = literal(value);
  if (direct !== null) return direct;
  const m = String(value).match(/^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*(.+))?\)$/);
  if (!m) return null;
  const fromTheme = deref(map, m[1]);
  if (fromTheme !== null) return fromTheme;
  return m[2] === undefined ? null : resolveCssColor(map, m[2].trim());
}

/* ------------------------------------------------------------------ *
 * 3. WCAG 2.1 对比度
 * ------------------------------------------------------------------ */

function rgba(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [...[0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)), a];
}

function hex([r, g, b]) {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 把带 alpha 的颜色叠到不透明底色上。
 * 这一步很关键：`.mt-badge` 的背景是 `--dsw-alias-interactive-bg-hover` = `#2631480f`，
 * 那是 **6% alpha 的灰**，叠在白底上几乎是白的。早先的版本把 alpha 直接丢掉、
 * 当成不透明的深灰 `#263148` 去算，于是报出假的 2.24:1。
 */
function composite(fgHex, bgHex) {
  const [r, g, b, a] = rgba(fgHex);
  if (a >= 1) return hex([r, g, b]);
  const [br, bg2, bb] = rgba(bgHex);
  return hex([r * a + br * (1 - a), g * a + bg2 * (1 - a), b * a + bb * (1 - a)]);
}

function relativeLuminance(hexColor) {
  const [r, g, b] = rgba(hexColor).slice(0, 3).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

/* ------------------------------------------------------------------ *
 * 4. 逐条规则检查卡片真正画出来的颜色
 * ------------------------------------------------------------------ */

// 提示级小字（`.mt-hint` / `.mt-ns` / `.mt-dim`）与官方 fields.module.css 同源，
// 量级允许低一档；其余文字必须过 AA。
const HINT_SELECTORS = ['.mt-hint', '.mt-ns', '.mt-dim'];
const AA = 4.5;
const HINT_FLOOR = 3;

const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1].trim(),
  decls: m[2],
}));
assert.ok(rules.length >= 15, `只解析出 ${rules.length} 条规则，CSS 结构变了？`);

const themes = { light: merge('body'), dark: merge('body[data-ds-dark-theme]') };
const PANEL_BGS = ['--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2'];

let checks = 0;
const rows = [];
const offenders = [];

for (const [mode, map] of Object.entries(themes)) {
  for (const rule of rules) {
    // 取**最后**一条 color：CSS 同规则内后者覆盖前者，取第一条会测出浏览器不用的值。
    const colorDecls = [...rule.decls.matchAll(/(?:^|;)\s*color\s*:\s*([^;]+)/g)];
    if (colorDecls.length === 0) continue;
    const colorDecl = colorDecls[colorDecls.length - 1];
    const fgRaw = resolveCssColor(map, colorDecl[1].trim());
    // `inherit` 之类解析不出字面值的，交给宿主自己的文字色，天然可读 —— 跳过。
    if (fgRaw === null) continue;

    const bgDecl = rule.decls.match(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/);
    const ownBgRaw = bgDecl ? resolveCssColor(map, bgDecl[1].trim()) : null;

    const isHint = HINT_SELECTORS.some((s) => rule.selector.includes(s));
    const floor = isHint ? HINT_FLOOR : AA;

    // 规则自带不透明背景时只测它；否则叠在每个面板底色上各测一遍。
    // 自带半透明背景时，先叠到面板底色，再用叠加结果当背景。
    const cases = [];
    for (const name of PANEL_BGS) {
      const panel = deref(map, name);
      if (panel === null) continue;
      const bg = ownBgRaw === null ? panel : composite(ownBgRaw, panel);
      const label = ownBgRaw === null
        ? name.replace('--dsw-alias-', '')
        : `${rule.selector} 自身背景叠在 ${name.replace('--dsw-alias-', '')} 上`;
      cases.push([label, bg, composite(fgRaw, bg)]);
    }

    for (const [bgLabel, bg, fg] of cases) {
      const ratio = contrast(fg, bg);
      checks += 1;
      rows.push(`${mode.padEnd(5)} ${rule.selector.padEnd(26)} ${String(colorDecl[1]).trim().padEnd(40)} → ${fg} on ${bg} ${ratio.toFixed(2)}:1`);
      if (ratio < floor) offenders.push(`${mode} :: ${rule.selector} 用 ${fg} 画在 ${bgLabel}(${bg}) 上，只有 ${ratio.toFixed(2)}:1（要求 ≥${floor}）`);
    }
  }
}

assert.ok(checks >= 20, `只检查到 ${checks} 组颜色，规则选择器可能变了（空断言风险）`);
assert.deepEqual(offenders, [], `对比度不合格：\n  ${offenders.join('\n  ')}`);

/* ------------------------------------------------------------------ *
 * 5. 反向断言：当年那个坏回退值必须确实是「不合格」的
 *    这一条证明本测试有分辨力，而不是恰好都通过。
 * ------------------------------------------------------------------ */

const lightBg = deref(themes.light, '--dsw-alias-bg-layer-2');
const legacyRatio = contrast('#e6e6e6', lightBg);
assert.ok(legacyRatio < 2,
  `回归基准失效：坏回退值 #e6e6e6 在浅色底 ${lightBg} 上应远低于 AA，实测 ${legacyRatio.toFixed(2)}:1`);

// 顺带把「同一段 CSS 若换回 --dsh-text」的假设也证伪一次
assert.equal(resolveCssColor(themes.light, 'var(--dsh-text,#e6e6e6)'), '#e6e6e6',
  '解析器应当把不存在的 --dsh-text 落到回退值 #e6e6e6 —— 这正是事故成因');

console.log(rows.join('\n'));
console.log(`\n共 ${checks} 组颜色声明；旧代码的坏回退值 #e6e6e6 在浅色底 ${lightBg} 上只有 ${legacyRatio.toFixed(2)}:1 —— 这就是「灰成一片」。`);
console.log(`THEME CONTRAST CHECKS PASSED（AA=${AA}:1，提示级 ≥${HINT_FLOOR}:1）`);
