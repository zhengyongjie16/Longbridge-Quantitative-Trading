/**
 * 测试2: 基础计算性能测试
 * 包含循环、数学运算、递归等
 */
import { getRuntime, getVersion, measure, printResult, printHeader } from './utils.js';

printHeader(`基础计算性能测试 - ${getRuntime()} ${getVersion()}`);

const results = [];

// 测试1: 简单循环
results.push(measure('简单循环 (1亿次)', () => {
  let sum = 0;
  for (let i = 0; i < 100_000_000; i++) {
    sum += i;
  }
  return sum;
}, 5));

// 测试2: 数组操作
results.push(measure('数组 map/filter/reduce (100万元素)', () => {
  const arr = Array.from({ length: 1_000_000 }, (_, i) => i);
  return arr
    .map(x => x * 2)
    .filter(x => x % 3 === 0)
    .reduce((a, b) => a + b, 0);
}, 5));

// 测试3: 对象创建与访问
results.push(measure('对象创建与访问 (100万次)', () => {
  const objects = [];
  for (let i = 0; i < 1_000_000; i++) {
    objects.push({ id: i, value: i * 2, name: `item_${i}` });
  }
  let sum = 0;
  for (const obj of objects) {
    sum += obj.value;
  }
  return sum;
}, 5));

// 测试4: 递归计算 (斐波那契)
function fib(n) {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}

results.push(measure('递归斐波那契 (n=35)', () => {
  return fib(35);
}, 3));

// 测试5: 数学运算
results.push(measure('数学运算 (1000万次)', () => {
  let result = 0;
  for (let i = 1; i <= 10_000_000; i++) {
    result += Math.sqrt(i) * Math.sin(i) + Math.cos(i) * Math.log(i + 1);
  }
  return result;
}, 5));

// 打印结果
console.log('\n测试结果:');
results.forEach(printResult);

// 输出JSON格式便于后续分析
console.log('\n--- JSON结果 ---');
console.log(JSON.stringify({
  runtime: getRuntime(),
  version: getVersion(),
  results: results.map(r => ({ name: r.name, avg: r.avg }))
}, null, 2));
