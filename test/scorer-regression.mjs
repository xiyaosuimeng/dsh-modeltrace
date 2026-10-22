/**
 * 用 ModelTrace 自带的参考回答（data/*_reference.jsonl）回归测试移植后的 JS 评分器。
 *
 * 模拟真实流程：对每个模型取样 3 份来自**不同 environment** 的回答，合成一次
 * analyzeGlobalOutputs 调用，检查第一候选是否等于该模型的标签。
 * 若移植正确，整体准确率应接近指纹库 calibration 里声明的 cv_accuracy。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeGlobalOutputs } from '../lib/scorer.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const bank = JSON.parse(readFileSync(join(HERE, '..', 'assets', 'unified_bank.json'), 'utf8'));
const ids = new Set(bank.models.map((m) => m.id));

function load(path) {
  const rows = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    const row = JSON.parse(line);
    if (row.strict_valid !== true || typeof row.text !== 'string' || row.text.length === 0) continue;
    if (!ids.has(row.model_id)) continue;
    rows.push(row);
  }
  return rows;
}

const rows = load(join(HERE, 'fixtures', 'reference-sample.jsonl'));

/** 按 model_id 分组，每个环境取一条，凑出 n 份。 */
function sample(modelId, n) {
  const byEnv = new Map();
  for (const row of rows) {
    if (row.model_id !== modelId) continue;
    if (!byEnv.has(row.condition_id)) byEnv.set(row.condition_id, row);
  }
  return [...byEnv.values()].slice(0, n);
}

let total = 0;
let correct = 0;
let familyCorrect = 0;
const failures = [];

for (const model of bank.models) {
  for (const n of [1, 2, 3]) {
    const picked = sample(model.id, n);
    if (picked.length < n) continue;
    const outputs = picked.map((row) => ({ text: row.text, expected_count: row.requested_count }));
    let analysis;
    try {
      analysis = analyzeGlobalOutputs(outputs, bank);
    }
    catch (error) {
      failures.push(`${model.id} n=${n} THROW ${error.message}`);
      total += 1;
      continue;
    }
    total += 1;
    if (analysis.prediction === model.id) correct += 1;
    else failures.push(`${model.id} n=${n} -> ${analysis.prediction} (${(analysis.probability * 100).toFixed(1)}%)`);
    if (analysis.family_prediction === model.family) familyCorrect += 1;
  }
}

console.log(`样本组数 total=${total}`);
console.log(`具体模型准确率 ${correct}/${total} = ${(correct / total * 100).toFixed(1)}%`);
console.log(`家族准确率     ${familyCorrect}/${total} = ${(familyCorrect / total * 100).toFixed(1)}%`);
console.log(`指纹库声明 cv_accuracy：1 轮 ${(bank.calibration['1'].cv_accuracy * 100).toFixed(1)}% / 2 轮 ${(bank.calibration['2'].cv_accuracy * 100).toFixed(1)}% / 3 轮 ${(bank.calibration['3'].cv_accuracy * 100).toFixed(1)}%`);
if (failures.length > 0) {
  console.log(`\n未命中 ${failures.length} 组：`);
  for (const line of failures.slice(0, 25)) console.log('  ' + line);
}

// 抽取一组展示完整返回结构，确认字段齐备。
const demo = analyzeGlobalOutputs(
  sample('claude-opus-4-6', 3).map((row) => ({ text: row.text, expected_count: row.requested_count })),
  bank,
);
console.log('\n演示（claude-opus-4-6, 3 轮）:');
console.log(JSON.stringify({
  prediction: demo.prediction,
  prediction_name: demo.prediction_name,
  probability: demo.probability,
  family_prediction: demo.family_prediction,
  family_probability: demo.family_probability,
  calibration: demo.calibration,
  method: demo.method,
  top3: demo.results.slice(0, 3).map((r) => `${r.model}:${(r.probability * 100).toFixed(1)}%`),
}, null, 1));
