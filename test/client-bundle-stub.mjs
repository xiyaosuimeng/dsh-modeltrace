/**
 * Stub test for the hand-written browser half `lib/client.js`.
 *
 * There is no browser and no React here: this test
 *   1. installs a fake `window.__ModuleLoader__` that captures the registration,
 *   2. runs the captured factory with a fake `require` (only `react` is allowed),
 *   3. drives the exported cordis plugin through a fake client ctx
 *      (`ctx.inject` / `ctx.settingsScope.bind` / `ctx.slots.inject` / `ctx.slots.register`),
 *   4. renders the registered card component with a hand-rolled element expander
 *      so the produced element tree can be asserted without React.
 *
 * Run: node test/client-bundle-stub.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, '..', 'lib', 'client.js');

const log = [];
function step(name, detail) {
    log.push(`  ok  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

/* ------------------------------------------------------------------ *
 * 1. Minimal React stub + element expander
 * ------------------------------------------------------------------ */

function flatten(children) {
    const out = [];
    for (const child of children) {
        if (Array.isArray(child)) out.push(...flatten(child));
        else if (child === null || child === undefined || child === false || child === true) continue;
        else out.push(child);
    }
    return out;
}

const ReactStub = {
    createElement(type, props, ...children) {
        return { __el: true, type, props: props === null || props === undefined ? {} : props, children: flatten(children) };
    },
    useState(initial) {
        return [typeof initial === 'function' ? initial() : initial, () => {}];
    },
    useEffect(fn) {
        const cleanup = fn();
        if (typeof cleanup === 'function') ReactStub.__cleanups.push(cleanup);
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
        return getSnapshot();
    },
    __cleanups: [],
    __listeners: []
};

/** Renders the element tree for real: function components are invoked, host nodes are kept. */
function expand(node) {
    if (node === null || node === undefined || node === false || node === true) return null;
    if (typeof node === 'string' || typeof node === 'number') return { text: String(node) };
    if (Array.isArray(node)) return { children: node.map(expand).filter(Boolean) };
    if (!node.__el) return null;
    if (typeof node.type === 'function') {
        const props = { ...node.props };
        if (node.children.length === 1) props.children = node.children[0];
        else if (node.children.length > 1) props.children = node.children;
        return expand(node.type(props));
    }
    return { host: node.type, props: node.props, children: node.children.map(expand).filter(Boolean) };
}

function walk(tree, visit) {
    if (tree === null) return;
    visit(tree);
    if (tree.children) for (const child of tree.children) walk(child, visit);
}

function collectText(tree) {
    const parts = [];
    walk(tree, (node) => {
        if (node.text !== undefined) parts.push(node.text);
    });
    return parts.join('');
}

function findAll(tree, predicate) {
    const out = [];
    walk(tree, (node) => {
        if (predicate(node)) out.push(node);
    });
    return out;
}

/* ------------------------------------------------------------------ *
 * 2. Fake module loader + factory materialisation
 * ------------------------------------------------------------------ */

const required = [];
globalThis.window = globalThis;
let registration = null;
globalThis.__ModuleLoader__ = {
    load(reg) {
        if (registration !== null) throw new Error('duplicate load() call');
        registration = reg;
    },
    require() {
        throw new Error('unexpected __ModuleLoader__.require');
    }
};

await import(BUNDLE);

assert.ok(registration !== null, 'bundle must call window.__ModuleLoader__.load()');
assert.equal(registration.id, 'dsh-modeltrace', 'registration id');
assert.equal(typeof registration.factory, 'function', 'factory must be a function');
step('module loader registration', `id=${registration.id}`);

const exportsObject = registration.factory((spec) => {
    required.push(spec);
    if (spec === 'react') return ReactStub;
    throw new Error(`client-modules: require("${spec}") missed the module table`);
});

assert.equal(typeof exportsObject, 'object', 'factory must return module.exports');
assert.equal(typeof exportsObject.apply, 'function', 'exports.apply must be a function');
assert.equal(exportsObject.name, 'dsh-modeltrace', 'exports.name');
assert.ok(Array.isArray(exportsObject.inject), 'exports.inject must be an array');
step('factory materialisation', `exports={name, inject:[${exportsObject.inject.join(',')}], apply}`);

assert.deepEqual(required, ['react'], 'the bundle may only require platform seed words (react)');
assert.deepEqual(exportsObject.inject, [], 'plugin-level inject must stay empty so the shell entry always activates');
step('require surface', `required=[${required.join(', ')}]; plugin inject=[]`);

/* ------------------------------------------------------------------ *
 * 3. Fake client ctx: ctx.inject / settingsScope / slots
 * ------------------------------------------------------------------ */

const snapshot = {
    status: 'ready',
    value: { enabled: true, enforce: 'block', rounds: 4, countMin: 218, countMax: 400, silentWhenUnknown: true, cacheMinutes: 0, injectOnMatch: true },
    base: { enabled: true, enforce: 'block', rounds: 3, countMin: 218, countMax: 400, silentWhenUnknown: true, cacheMinutes: 0, injectOnMatch: true },
    user: { rounds: 4 },
    revision: 7,
    writable: true,
    mode: 'host'
};

const calls = { set: [], unset: [], subscribe: 0, bind: [], served: [], register: [], inspect: [], slotInject: [] };

const scopeController = {
    getSnapshot() {
        return snapshot;
    },
    subscribe(listener) {
        calls.subscribe += 1;
        assert.equal(typeof listener, 'function', 'subscribe(listener)');
        ReactStub.__listeners.push(listener);
        return () => {};
    },
    set(field, value) {
        calls.set.push([field, value]);
        return Promise.resolve();
    },
    unset(field) {
        calls.unset.push([field]);
        return Promise.resolve();
    },
    dispose() {}
};

function makeCtxSlot() {
    const slots = {
        inject(key, callback) {
            calls.slotInject.push(key);
            const disposed = callback();
            return typeof disposed === 'function' ? disposed : () => {};
        },
        register(meta, component) {
            calls.register.push({ meta, component });
            return () => {};
        }
    };
    return slots;
}

const depsSeen = [];
const configFormsService = {
    get(namespace) {
        calls.bind.push({ namespace });
        return scopeController;
    },
    whileServed(namespaces, register) {
        calls.served.push([...namespaces]);
        return register(new Set(namespaces));
    }
};

const rootCtx = {
    inject(deps, callback) {
        depsSeen.push(deps);
        const child = {
            slots: makeCtxSlot(),
            configForms: configFormsService,
            effect: (fn) => fn()
        };
        const disposed = callback(child);
        return typeof disposed === 'function' ? disposed : () => {};
    },
    slots: makeCtxSlot(),
    configForms: configFormsService
};

exportsObject.apply(rootCtx);

assert.equal(calls.inspect.length, 0, 'no undeclared service inspection');
assert.equal(depsSeen.length, 1, 'apply must take its dependencies with one nested ctx.inject');
assert.deepEqual(depsSeen[0], ['slots', 'configForms'], 'nested inject deps');
assert.deepEqual(calls.bind, [{ namespace: 'modeltrace' }], 'configForms.get(namespace)');
assert.deepEqual(calls.served, [['modeltrace']], 'card only registers while the namespace is served');
assert.deepEqual(calls.slotInject, ['plugins.item', 'settings.plugins.tab', 'conversation.session.header.utilities'], 'official slot injection keys');
assert.equal(calls.register.length, 3, 'two settings entries and one session window');
assert.deepEqual(calls.register[2].meta.inject('session-123'), { sessionId: 'session-123', scope: scopeController });
step('registration wiring', `inject(${JSON.stringify(depsSeen[0])}) → get(${JSON.stringify(calls.bind[0])}) → slots.inject(${calls.slotInject[0]})`);

const registrationMeta = calls.register[0].meta;
assert.equal(registrationMeta.name, 'plugins.item', 'slot name');
assert.equal(registrationMeta.key, undefined, 'slot registration carries no legacy key');
assert.equal(registrationMeta.id, 'modeltrace', 'card id');
assert.equal(typeof registrationMeta.order, 'number', 'card order must be a number');
assert.equal(registrationMeta.label, 'ModelTrace', 'card label');
assert.equal(typeof calls.register[0].component, 'function', 'registered component must be a function');
step('card metadata', JSON.stringify(registrationMeta));

/* ------------------------------------------------------------------ *
 * 4. Render the card in both views
 * ------------------------------------------------------------------ */

const EXPECTED_LABELS = exportsObject.FIELDS.map(field => field.label);

const CardEntry = calls.register[0].component;

// 4a. page view (full form)
const pageTree = expand(CardEntry({ view: 'page' }));
const labelNodes = findAll(pageTree, (node) => node.props && node.props.className === 'mt-label');
assert.equal(labelNodes.length, 14, 'page view must render 14 field rows');
labelNodes.forEach((node, index) => {
    const text = collectText(node);
    assert.ok(text.startsWith(EXPECTED_LABELS[index]), `field #${index} label (got ${JSON.stringify(text)})`);
    assert.equal(text.includes('已自定义'), index === 2, `only the overridden field #2 carries the badge`);
});
step('page view renders 14 fields', EXPECTED_LABELS.join(' / '));

const pageText = collectText(pageTree);
for (const token of ['ModelTrace 模型指纹校验', 'modeltrace', 'block', '218', '400', '已自定义']) {
    assert.ok(pageText.includes(token), `page view must mention ${token}`);
}
assert.ok(pageText.includes('重置为默认'), 'page view must render per-field reset buttons');

const buttons = findAll(pageTree, (node) => node.host === 'button' && node.props.className === 'mt-btn');
assert.equal(buttons.length, 15, '14 per-field reset buttons + 1 reset-all');
const checkboxes = findAll(pageTree, (node) => node.host === 'input' && node.props.type === 'checkbox');
assert.equal(checkboxes.length, 4, 'boolean fields: enabled / floatingWindow / injectVerdict / injectOnMatch');
const numbers = findAll(pageTree, (node) => node.host === 'input' && node.props.type === 'number');
assert.equal(numbers.length, 8, 'number fields: rounds / countMin / countMax / minMatchConfidence / detailBelowConfidence / intervalMessages / intervalSeconds / timeoutMs');
assert.equal(numbers[0].props.value, '4', 'rounds shows the user-layer override (4)');
assert.equal(numbers[1].props.value, '218', 'countMin shows the assembled default');
assert.deepEqual(
    numbers.map((node) => ([node.props.min, node.props.max])),
    [[1, 5], [218, 400], [218, 400], [0, 1], [0, 1], [0, undefined], [0, undefined], [1000, 1800000]],
    'numeric bounds mirror SettingsSchema'
);
const selects = findAll(pageTree, (node) => node.host === 'select');
assert.equal(selects.length, 2, 'enforce and verificationMode enums');
assert.equal(findAll(selects[0], (node) => node.host === 'option').length, 3, 'block/warn/off');
assert.ok(pageText.includes('X1 / X2 都填时 X1 优先'));
assert.ok(pageText.includes('主会话不等待探针'));
assert.ok(!exportsObject.FIELDS.some(field => ['cacheMinutes', 'silentWhenUnknown'].includes(field.key)));
step('controls rendered' , '4 checkboxes, 8 number inputs, 2 selects, 15 buttons');

// 布局回归：宽控件（数字/下拉）必须另起一行。早先它们和标签挤在同一 flex 行，
// 手机窄屏下标签被压成竖排（「指纹/不一/致时/的动/作」），控件也被挤扁。
const rows = findAll(pageTree, (node) => node.props && node.props.className === 'mt-row');
assert.equal(rows.length, 14, 'one .mt-row per field');
const WIDE_FIELDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const INLINE_FIELDS = [0, 11, 12, 13];
rows.forEach((row, index) => {
    const top = findAll(row, (node) => node.props && node.props.className === 'mt-row-top');
    assert.equal(top.length, 1, `field #${index} has exactly one head row`);
    const wide = findAll(row, (node) => node.props && node.props.className === 'mt-ctl-wide');
    if (INLINE_FIELDS.includes(index)) {
        assert.equal(wide.length, 0, `boolean field #${index} keeps its control in the head row`);
        assert.equal(findAll(top[0], (n) => n.host === 'input' && n.props.type === 'checkbox').length, 1,
            `boolean field #${index} renders its checkbox inline`);
    }
    else {
        assert.equal(wide.length, 1, `wide field #${index} puts its control on its own line`);
        assert.equal(findAll(top[0], (n) => n.host === 'input' || n.host === 'select').length, 0,
            `wide field #${index} must not squeeze its control into the head row`);
    }
});
assert.deepEqual(WIDE_FIELDS.concat(INLINE_FIELDS).sort((a, b) => a - b), Array.from({length: 14}, (_, i) => i), 'field index map is complete');
step('field layout', '4 boolean rows inline, ' + WIDE_FIELDS.length + ' wide rows on their own line');

assert.equal(calls.subscribe, 1, 'the card subscribes to the scope once per render pass');
for (const listener of ReactStub.__listeners) listener();
assert.ok(ReactStub.__listeners.length > 0, 'subscription listener must be callable on a scope change');
step('scope subscription', `${calls.subscribe} subscribe(listener) call, listener re-reads getSnapshot()`);

// 4b. write path: scope.set(field, value)
checkboxes[0].props.onChange({ target: { checked: false } });
assert.deepEqual(calls.set, [['enabled', false]], 'checkbox commit goes through scope.set');
selects[0].props.onChange({ target: { value: 'warn' } });
assert.deepEqual(calls.set, [['enabled', false], ['enforce', 'warn']], 'enum commit goes through scope.set');
step('write path', `scope.set called with ${JSON.stringify(calls.set)}`);

// 4c. reset path: scope.unset(field) — only enabled for user-layer overrides
assert.equal(buttons[2].props.disabled, false, 'rounds is overridden → its reset button is enabled');
assert.equal(buttons[0].props.disabled, true, 'enabled is not overridden → its reset button is disabled');
buttons[2].props.onClick();
assert.deepEqual(calls.unset, [['rounds']], 'reset goes through scope.unset');
step('reset path', `scope.unset called with ${JSON.stringify(calls.unset)}`);

// 4d. summary view (Plugins page)
const summaryTree = expand(CardEntry({ view: 'summary' }));
const summaryText = collectText(summaryTree);
for (const token of ['ModelTrace 模型指纹校验', '已启用', 'block', '218–400', '1 项已自定义']) {
    assert.ok(summaryText.includes(token), `summary view must mention ${token}`);
}
assert.equal(findAll(summaryTree, (node) => node.props && node.props.className === 'mt-label').length, 0, 'summary view renders no field rows');
assert.equal(findAll(summaryTree, (node) => node.host === 'input').length, 0, 'summary view renders no inputs');
step('summary view', summaryText.replace(/\s+/g, ' ').slice(0, 120));

// 4e. no `view` at all (the current shell passes ownerProps = {}) → full form
const noViewTree = expand(CardEntry({}));
assert.equal(findAll(noViewTree, (node) => node.props && node.props.className === 'mt-label').length, 14, 'absent view still renders the full form');
step('ownerProps = {} fallback', 'full form rendered');

// 4f. unavailable status must not crash
const savedStatus = snapshot.status;
snapshot.status = 'loading';
const loadingTree = expand(CardEntry({ view: 'page' }));
assert.ok(collectText(loadingTree).includes('正在读取宿主设置'), 'loading status is rendered');
snapshot.status = savedStatus;
step('status handling', 'loading / ready / unavailable branches');

/* ------------------------------------------------------------------ *
 * 5. package.json contract
 * ------------------------------------------------------------------ */

const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
assert.equal(pkg.exports['./client'].default, './lib/client.js', 'exports["./client"].default');
assert.equal(pkg.exports['./client'].types, './lib/client.d.ts', 'exports["./client"].types');
assert.equal(pkg.exports['./package.json'], './package.json', 'exports["./package.json"] is required by the host no-internals resolution fallback');
assert.equal(pkg.dsh.client.platform, 'web', 'dsh.client.platform');
assert.ok(Array.isArray(pkg.dsh.client.inject), 'dsh.client.inject must be an array');
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml', 'dsh.bundle.patch must be untouched');
step('package.json', `exports["./client"] → ${pkg.exports['./client'].default}; dsh.client=${JSON.stringify(pkg.dsh.client)}`);

console.log(log.join('\n'));
console.log('\nALL STUB ASSERTIONS PASSED');
