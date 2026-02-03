/**
 * 测试8: 使用项目实际依赖的 technicalindicators 库测试
 */

import { getRuntime, getVersion, measure, printResult, printHeader } from './utils.js';

// 动态导入 technicalindicators
let RSI, MACD, EMA;
try {
  const ti = await import('technicalindicators');
  RSI = ti.RSI;
  MACD = ti.MACD;
  EMA = ti.EMA;
} catch (e) {
  console.log('无法导入 technicalindicators，请先运行 npm install');
  process.exit(1);
}

printHeader(`technicalindicators 库性能测试 - ${getRuntime()} ${getVersion()}`);

const results = [];

// 生成测试数据
function generateCloses(count) {
  const closes = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    price += (Math.random() - 0.5) * 2;
    closes.push(Math.max(1, price));
  }
  return closes;
}

const closes500 = generateCloses(500);
const closes2000 = generateCloses(2000);
const closes5000 = generateCloses(5000);

console.log('\n使用 technicalindicators 库计算');

// RSI 测试
results.push(measure('RSI (500条) x1000', () => {
  for (let i = 0; i < 1000; i++) {
    RSI.calculate({ values: closes500, period: 14 });
  }
}, 5));

results.push(measure('RSI (2000条) x500', () => {
  for (let i = 0; i < 500; i++) {
    RSI.calculate({ values: closes2000, period: 14 });
  }
}, 5));

// MACD 测试
results.push(measure('MACD (500条) x1000', () => {
  for (let i = 0; i < 1000; i++) {
    MACD.calculate({
      values: closes500,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false
    });
  }
}, 5));

results.push(measure('MACD (2000条) x500', () => {
  for (let i = 0; i < 500; i++) {
    MACD.calculate({
      values: closes2000,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false
    });
  }
}, 5));

// EMA 测试
results.push(measure('EMA (5000条) x1000', () => {
  for (let i = 0; i < 1000; i++) {
    EMA.calculate({ values: closes5000, period: 20 });
  }
}, 5));

// 打印结果
console.log('\n测试结果:');
results.forEach(printResult);

console.log('\n--- JSON结果 ---');
console.log(JSON.stringify({
  runtime: getRuntime(),
  version: getVersion(),
  results: results.map(r => ({ name: r.name, avg: r.avg }))
}, null, 2));
