/**
 * 测试6: 并发与异步性能测试
 */

import { getRuntime, getVersion, measureAsync, printResult, printHeader } from './utils.js';

printHeader(`并发与异步性能测试 - ${getRuntime()} ${getVersion()}`);

const results = [];

// 模拟异步操作
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 模拟CPU密集型异步任务
async function cpuTask(iterations) {
  let sum = 0;
  for (let i = 0; i < iterations; i++) {
    sum += Math.sqrt(i) * Math.sin(i);
  }
  return sum;
}

// 测试1: Promise.all 并发
results.push(await measureAsync('Promise.all 并发 (1000个Promise)', async () => {
  const promises = [];
  for (let i = 0; i < 1000; i++) {
    promises.push(Promise.resolve(i * 2));
  }
  await Promise.all(promises);
}, 10));

// 测试2: Promise.all 带计算
results.push(await measureAsync('Promise.all 带计算 (100个任务)', async () => {
  const promises = [];
  for (let i = 0; i < 100; i++) {
    promises.push(cpuTask(10000));
  }
  await Promise.all(promises);
}, 5));

// 测试3: 串行async/await
results.push(await measureAsync('串行async/await (100次)', async () => {
  for (let i = 0; i < 100; i++) {
    await Promise.resolve(i);
  }
}, 10));

// 测试4: Promise链
results.push(await measureAsync('Promise链 (1000层)', async () => {
  let p = Promise.resolve(0);
  for (let i = 0; i < 1000; i++) {
    p = p.then(v => v + 1);
  }
  await p;
}, 10));

// 测试5: 事件循环调度
results.push(await measureAsync('setImmediate/queueMicrotask (10000次)', async () => {
  let count = 0;
  const target = 10000;
  await new Promise(resolve => {
    function tick() {
      count++;
      if (count < target) {
        queueMicrotask(tick);
      } else {
        resolve();
      }
    }
    tick();
  });
}, 5));

// 测试6: 大量并发Promise创建
results.push(await measureAsync('创建10万个Promise', async () => {
  const promises = [];
  for (let i = 0; i < 100000; i++) {
    promises.push(new Promise(resolve => resolve(i)));
  }
  await Promise.all(promises);
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
