/** Real React/browser regression on the existing GUI origin, with an isolated fixture.
 * No replacement server is started. PLAYWRIGHT_MODULE, ESBUILD_MODULE and
 * REACT_MODULE_ROOT can point at an installed test toolchain. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/root/.dsh/node_modules/playwright');
const { buildSync } = require(process.env.ESBUILD_MODULE || '/root/dsha-workspace/.f22-infra/node_modules/esbuild');
const reactRoot = process.env.REACT_MODULE_ROOT || '/tmp/codex-react/node_modules';
const here = dirname(fileURLToPath(import.meta.url));
const output = process.env.UI_EVIDENCE_DIR || '/tmp/dsh-modeltrace-ui-evidence';
mkdirSync(output, { recursive: true });
const runtime = buildSync({ stdin: { contents: `import React from ${JSON.stringify(reactRoot + '/react/index.js')}; import {createRoot} from ${JSON.stringify(reactRoot + '/react-dom/client.js')}; window.React=React;window.createRoot=createRoot;`, resolveDir: here }, bundle: true, write: false, platform: 'browser', define: { 'process.env.NODE_ENV': '"development"' } }).outputFiles[0].text;
const bundle = readFileSync(resolve(here, '../lib/client.js'), 'utf8');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/root/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const consoleErrors = [], pageErrors = [], failedRequests = [], checks = [], requests = [];
page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', err => pageErrors.push(err.message));
page.on('requestfailed', req => failedRequests.push({ url: req.url(), error: req.failure()?.errorText }));
let result = { status: 'idle', runId: null };
let pendingA = null;
let holdA = false;
let httpStatus = 200;
await page.route('**/__modeltrace_ui_test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>ModelTrace isolated UI regression</title></head><body><div id="root"></div></body></html>' }));
await page.route('**/api/modeltrace?**', async route => {
  const sessionId = new URL(route.request().url()).searchParams.get('sessionId');
  requests.push(sessionId);
  if (holdA && sessionId === 'session-A') { pendingA = route; return; }
  await route.fulfill({ status: httpStatus, contentType: 'application/json', body: JSON.stringify(result) });
});
async function check(name, fn) { await fn(); checks.push({ name, pass: true }); }
try {
  await page.goto('http://127.0.0.1:3080/__modeltrace_ui_test');
  await page.addScriptTag({ content: runtime });
  await page.addScriptTag({ content: 'window.__ModuleLoader__={load(spec){window.client=spec.factory(()=>window.React)}};' });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const listeners = new Set();
    window.writes = [];
    window.snapshot = { status: 'ready', writable: true, value: { ...client.DEFAULTS }, base: { ...client.DEFAULTS }, user: {}, revision: 1 };
    window.scope = { getSnapshot: () => snapshot, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
      set: async (key, value) => { writes.push([key, value]); snapshot = { ...snapshot, value: { ...snapshot.value, [key]: value }, user: { ...snapshot.user, [key]: value } }; listeners.forEach(fn => fn()); },
      unset: async key => { const user = { ...snapshot.user }; delete user[key]; snapshot = { ...snapshot, user, value: { ...snapshot.value, [key]: client.DEFAULTS[key] } }; listeners.forEach(fn => fn()); }
    };
    window.root = createRoot(document.getElementById('root'));
    window.mount = (sessionId, card = true) => root.render(React.createElement(React.Fragment, null,
      card ? React.createElement(client.ModelTraceCard, { scope }) : null,
      React.createElement(client.ModelTraceWindow, { scope, sessionId })));
    mount('session-A');
  });
  await check('14 settings; removed cache/unknown; accessible controls', async () => {
    await page.waitForSelector('.mt-row');
    assert.equal(await page.locator('.mt-row').count(), 14);
    assert.equal(await page.getByLabel('裁决复用时长（分钟）').count(), 0);
    assert.equal(await page.getByLabel('库外模型直接不运行').count(), 0);
    assert.equal(await page.getByLabel('校验方式').inputValue(), 'probe');
    assert.equal(await page.getByLabel('单次校验超时（毫秒）').inputValue(), '300000');
  });
  await check('X1 preserves zero, clears to empty, normalizes integer; X2 preserves fractional seconds', async () => {
    const x1 = page.getByLabel('X1 · 用户消息间隔');
    await x1.fill('0'); await x1.press('Tab');
    assert.equal(await page.evaluate(() => writes.at(-1)[1]), '0');
    await x1.fill(''); await x1.press('Tab');
    assert.deepEqual(await page.evaluate(() => writes.at(-1)), ['intervalMessages', '']);
    await x1.fill('2.8'); await x1.press('Enter');
    assert.equal(await page.evaluate(() => writes.at(-1)[1]), '3');
    const x2 = page.getByLabel('X2 · 时间间隔（秒）');
    await x2.fill('1.25'); await x2.press('Tab');
    assert.deepEqual(await page.evaluate(() => writes.at(-1)), ['intervalSeconds', '1.25']);
    await x2.fill(''); await x2.press('Tab');
    assert.deepEqual(await page.evaluate(() => writes.at(-1)), ['intervalSeconds', '']);
  });
  await check('numeric bounds, thresholds, reset and independent controls', async () => {
    const confidence = page.getByLabel('判定通过的最低置信度（0-1）');
    await confidence.fill('0.85'); await confidence.press('Enter');
    assert.deepEqual(await page.evaluate(() => writes.at(-1)), ['minMatchConfidence', .85]);
    await page.getByLabel('单次校验超时（毫秒）').fill('1900000');
    await page.getByLabel('单次校验超时（毫秒）').press('Tab');
    assert.deepEqual(await page.evaluate(() => writes.at(-1)), ['timeoutMs', 1800000]);
    await page.getByLabel('校验方式').selectOption('session');
    assert.deepEqual(await page.evaluate(() => writes.at(-1)), ['verificationMode', 'session']);
    await page.getByLabel('保留上下文裁决注入').uncheck();
    assert.equal(await page.getByLabel('显示结果悬浮窗').isChecked(), true);
    await page.locator('.mt-row').filter({ has: confidence }).getByRole('button').click();
    assert.equal(await confidence.inputValue(), '0.8');
  });
  await page.screenshot({ path: output + '/settings-mobile.png', fullPage: true });
  await check('idle hidden, scoped API uses correct session', async () => {
    assert.equal(await page.locator('.mt-float').count(), 0);
    assert.ok(requests.includes('session-A'));
  });
  result = { status: 'running', running: true, runId: 'run-1', selection: { model: 'claimed-alpha' } };
  await page.evaluate(() => mount('session-A', false));
  await check('running window appears with claimed selection', async () => {
    await page.waitForSelector('.mt-float', { timeout: 7000 });
    assert.ok((await page.locator('.mt-float').innerText()).includes('claimed-alpha'));
  });
  await page.getByRole('button', { name: '关闭本次校验结果' }).click();
  result = { ...result, status: 'complete', running: false, verdict: { claimedModel: 'claimed-alpha', status: 'mismatch', candidates: [1,2,3,4].map(n => ({ model: 'candidate-' + n, probability: 1/n })), roundTop: [{ round: 1, model: 'candidate-1', probability: .93 }, { round: 2, model: 'candidate-2', probability: .82 }], error: 'probe error example' }, locked: true, action: 'block' };
  await check('close persists for same run completion', async () => {
    await page.waitForTimeout(2200);
    assert.equal(await page.locator('.mt-float').count(), 0);
  });
  result = { ...result, runId: 'run-2' };
  await check('new run reappears; top 3, each round, status and errors', async () => {
    await page.waitForSelector('.mt-float', { timeout: 6500 });
    const text = await page.locator('.mt-float').innerText();
    for (const value of ['candidate-1','candidate-2','candidate-3','93.0%','82.0%','probe error example','任务已锁定']) assert.ok(text.includes(value), value);
    assert.ok(!text.includes('candidate-4'));
    const box = await page.locator('.mt-float').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390);
  });
  await page.screenshot({ path: output + '/result-mobile.png' });
  await check('floatingWindow configuration hides window and stops polling', async () => {
    await page.evaluate(() => scope.set('floatingWindow', false));
    await page.waitForFunction(() => !document.querySelector('.mt-float'));
    const count = requests.length;
    await page.waitForTimeout(2200);
    assert.equal(requests.length, count);
    await page.evaluate(() => scope.set('floatingWindow', true));
    await page.waitForSelector('.mt-float');
  });
  await check('master enabled stops polling independently of injection', async () => {
    await page.evaluate(() => scope.set('enabled', false));
    await page.waitForFunction(() => !document.querySelector('.mt-float'));
    const count = requests.length;
    await page.waitForTimeout(2200);
    assert.equal(requests.length, count);
    await page.evaluate(() => scope.set('enabled', true));
    await page.waitForSelector('.mt-float');
  });
  await check('session switch never exposes previous session; late response ignored', async () => {
    holdA = true;
    await page.evaluate(() => scope.set('floatingWindow', false));
    await page.waitForFunction(() => !document.querySelector('.mt-float'));
    await page.evaluate(() => scope.set('floatingWindow', true));
    await page.waitForFunction(() => !document.querySelector('.mt-float'));
    for (let i = 0; i < 20 && !pendingA; i++) await page.waitForTimeout(20);
    assert.ok(pendingA);
    result = { status: 'running', runId: 'run-B', selection: { model: 'claimed-B' } };
    await page.evaluate(() => mount('session-B', false));
    await page.waitForSelector('.mt-float');
    await pendingA.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'complete', runId: 'late-A', verdict: { claimedModel: 'WRONG-LATE-A' } }) }).catch(() => {});
    assert.ok((await page.locator('.mt-float').innerText()).includes('claimed-B'));
    assert.ok(!(await page.locator('.mt-float').innerText()).includes('WRONG-LATE-A'));
    holdA = false;
  });
  await check('poll failure is visible, then recovers', async () => {
    httpStatus = 503;
    await page.waitForSelector('.mt-float .mt-err', { timeout: 3000 });
    assert.ok((await page.locator('.mt-err').innerText()).includes('HTTP 503'));
    httpStatus = 200;
    await page.evaluate(() => scope.set('floatingWindow', false));
    await page.evaluate(() => scope.set('floatingWindow', true));
    await page.waitForFunction(() => document.querySelector('.mt-float') && !document.querySelector('.mt-float .mt-err'));
  });
  await page.evaluate(() => root.unmount());
  assert.equal(pageErrors.length, 0, 'pageerrors');
  // Chromium logs one expected HTTP 503; aborted session-A request is expected.
  assert.equal(consoleErrors.filter(s => !s.includes('503')).length, 0, 'unexpected console errors');
  assert.equal(failedRequests.filter(r => !r.error.includes('ERR_ABORTED')).length, 0, 'unexpected failed requests');
} finally {
  writeFileSync(output + '/results.json', JSON.stringify({ checks, consoleErrors, pageErrors, failedRequests, requests }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ passed: checks.length, evidence: output, consoleErrors, pageErrors, failedRequests }, null, 2));
