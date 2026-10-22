/**
 * dsh-modeltrace v4 source-kind 回归（0.1.1）。
 *
 * 背景：0.1.0 在 gate.js / verify.js / command.js 三处用 v3 已退役的写法
 *   source: { kind: 'plugin', plugin: '<name>' }
 * 构造注入消息。DSH 的原生 v4 写入路径（releasedV4SessionFormatCodec.encodeEvent
 * → assertV4RowAdmission → source()）拒绝 kind === 'plugin'，抛
 *   SessionFormatError: format v4 message requires a producer-owned source kind
 * 导致 agent/pre-step 注入的裁决消息无法落盘，整个会话被污染。
 *
 * 本测试钉死两件事：
 *   1. 静态：lib/ 里不得再出现 kind 恰为 'plugin' 的 source 字面量；
 *   2. 动态（可解析到 DSH 校验器时）：确认 DSH 当前确实拒收退役写法、放行
 *      'plugin:<name>'，避免上游契约变化后我们又"静默"踩坑。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', 'lib');

const checks = [];
const check = (label, pass) => checks.push([label, pass]);

// —— 1. 静态扫描：source 字面量里不得出现退役 kind ——
const KIND_LITERAL = /source:\s*\{[^}]*?kind:\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/gs;
const scanned = [];
const offenders = [];
for (const file of readdirSync(LIB).filter((name) => name.endsWith('.js'))) {
  const text = readFileSync(join(LIB, file), 'utf8');
  for (const match of text.matchAll(KIND_LITERAL)) {
    const kind = match[1] ?? match[2] ?? match[3];
    // 模板串 `plugin:${PLUGIN}` 在 match[3] 里带 ${}：动态拼接，静态不可判定，但仍记录。
    scanned.push(`${file}: ${kind}${kind.includes('${') ? '（模板串，动态拼接）' : ''}`);
    if (kind === 'plugin') offenders.push(`${file}: kind: '${kind}'`);
  }
}

console.log('=== 静态扫描 lib/ 的 source.kind 字面量 ===');
for (const row of scanned) console.log(`  ${row}`);
check('lib/ 里至少扫到一处 source.kind 字面量（扫描器没失效）', scanned.length > 0);
check('不存在 kind 恰为 "plugin" 的 source（v4 会拒收）', offenders.length === 0);
if (offenders.length > 0) for (const row of offenders) console.log(`  ✗ 退役写法：${row}`);

// —— 2. 动态：对照 DSH 的 v4 校验器 ——
const inserted = (kind) => ({
  type: 'agent/inbox/spliced',
  seq: 1,
  time: 0,
  data: {
    target: 'next-step',
    start: 0,
    inserted: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'verdict' }], source: kind }],
  },
});

let validator;
try {
  validator = await import('@deepseek-ai/dsh-session-format-v3-to-v4');
}
catch {
  console.log('\n（跳过动态校验：本机解析不到 @deepseek-ai/dsh-session-format-v3-to-v4）');
}

if (validator !== undefined) {
  const { assertV4RowAdmission } = validator;
  const rejects = (kind) => {
    try { assertV4RowAdmission(inserted(kind)); return false; }
    catch (error) { return error?.name === 'SessionFormatError' && /producer-owned source kind/.test(error.message); }
  };
  const accepts = (kind) => {
    try { assertV4RowAdmission(inserted(kind)); return true; }
    catch { return false; }
  };
  console.log('\n=== DSH v4 校验器对照 ===');
  console.log(`  {kind:'plugin',plugin:'dsh-modeltrace'} 被拒: ${rejects({ kind: 'plugin', plugin: 'dsh-modeltrace' })}`);
  console.log(`  {kind:'plugin:dsh-modeltrace'}          放行: ${accepts({ kind: 'plugin:dsh-modeltrace' })}`);
  check('DSH 拒收退役写法 {kind:"plugin",plugin:...}', rejects({ kind: 'plugin', plugin: 'dsh-modeltrace' }));
  check('DSH 放行 producer-owned 写法 {kind:"plugin:dsh-modeltrace"}', accepts({ kind: 'plugin:dsh-modeltrace' }));
  // 插件当前真正写的这个 kind 必须能过校验器。
  check('插件实际写入的 kind 通过 DSH v4 准入', accepts({ kind: 'plugin:dsh-modeltrace' }));
}

console.log('\n=== 断言 ===');
let ok = true;
for (const [label, pass] of checks) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) ok = false;
}
console.log(ok ? '\nsource-kind 回归全部通过。' : '\nsource-kind 回归存在失败。');
process.exit(ok ? 0 : 1);
