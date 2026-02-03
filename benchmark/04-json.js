/**
 * 测试4: JSON 解析性能测试
 */

import { getRuntime, getVersion, measure, printResult, printHeader } from './utils.js';

printHeader(`JSON 解析性能测试 - ${getRuntime()} ${getVersion()}`);

const results = [];

// 生成测试数据 - 模拟K线数据
function generateCandleData(count) {
  const candles = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const change = (Math.random() - 0.5) * 2;
    price += change;
    candles.push({
      timestamp: Date.now() + i * 60000,
      open: price,
      high: price + Math.random(),
      low: price - Math.random(),
      close: price + (Math.random() - 0.5),
      volume: Math.floor(Math.random() * 1000000),
      turnover: Math.floor(Math.random() * 10000000)
    });
  }
  return candles;
}

// 小型JSON (100条K线)
const smallData = generateCandleData(100);
const smallJson = JSON.stringify(smallData);
console.log(`\n小型JSON大小: ${(smallJson.length / 1024).toFixed(2)} KB`);

// 中型JSON (10000条K线)
const mediumData = generateCandleData(10000);
const mediumJson = JSON.stringify(mediumData);
console.log(`中型JSON大小: ${(mediumJson.length / 1024).toFixed(2)} KB`);

// 大型JSON (100000条K线)
const largeData = generateCandleData(100000);
const largeJson = JSON.stringify(largeData);
console.log(`大型JSON大小: ${(largeJson.length / 1024 / 1024).toFixed(2)} MB`);

// 测试1: 小型JSON序列化
results.push(measure('小型JSON序列化 (100条) x1000', () => {
  for (let i = 0; i < 1000; i++) {
    JSON.stringify(smallData);
  }
}, 5));

// 测试2: 小型JSON解析
results.push(measure('小型JSON解析 (100条) x1000', () => {
  for (let i = 0; i < 1000; i++) {
    JSON.parse(smallJson);
  }
}, 5));

// 测试3: 中型JSON序列化
results.push(measure('中型JSON序列化 (10000条) x100', () => {
  for (let i = 0; i < 100; i++) {
    JSON.stringify(mediumData);
  }
}, 5));

// 测试4: 中型JSON解析
results.push(measure('中型JSON解析 (10000条) x100', () => {
  for (let i = 0; i < 100; i++) {
    JSON.parse(mediumJson);
  }
}, 5));

// 测试5: 大型JSON序列化
results.push(measure('大型JSON序列化 (100000条) x10', () => {
  for (let i = 0; i < 10; i++) {
    JSON.stringify(largeData);
  }
}, 3));

// 测试6: 大型JSON解析
results.push(measure('大型JSON解析 (100000条) x10', () => {
  for (let i = 0; i < 10; i++) {
    JSON.parse(largeJson);
  }
}, 3));

// 打印结果
console.log('\n测试结果:');
results.forEach(printResult);

console.log('\n--- JSON结果 ---');
console.log(JSON.stringify({
  runtime: getRuntime(),
  version: getVersion(),
  results: results.map(r => ({ name: r.name, avg: r.avg }))
}, null, 2));
