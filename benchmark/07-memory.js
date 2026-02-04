/**
 * 测试7: 内存使用与GC性能测试
 */
import { getRuntime, getVersion, measure, printResult, printHeader, formatBytes } from './utils.js';

printHeader(`内存使用与GC性能测试 - ${getRuntime()} ${getVersion()}`);

const results = [];

function getMemory() {
  return process.memoryUsage();
}

function printMemory(label, mem) {
  console.log(`  ${label}:`);
  console.log(`    heapUsed: ${formatBytes(mem.heapUsed)}`);
  console.log(`    heapTotal: ${formatBytes(mem.heapTotal)}`);
  console.log(`    rss: ${formatBytes(mem.rss)}`);
}

// 初始内存
const initialMem = getMemory();
console.log('\n初始内存状态:');
printMemory('初始', initialMem);

// 测试1: 大量小对象创建
results.push(measure('创建100万个小对象', () => {
  const objects = [];
  for (let i = 0; i < 1_000_000; i++) {
    objects.push({ id: i, value: i * 2 });
  }
  return objects.length;
}, 5));

// 测试2: 大量字符串创建
results.push(measure('创建100万个字符串', () => {
  const strings = [];
  for (let i = 0; i < 1_000_000; i++) {
    strings.push(`string_${i}_value`);
  }
  return strings.length;
}, 5));

// 测试3: 数组操作内存
results.push(measure('大数组操作 (1000万元素)', () => {
  const arr = new Array(10_000_000).fill(0).map((_, i) => i);
  const sum = arr.reduce((a, b) => a + b, 0);
  return sum;
}, 3));

// 测试4: 对象池模式 (模拟项目中的对象池)
class ObjectPool {
  constructor(factory, initialSize = 100) {
    this.factory = factory;
    this.pool = [];
    for (let i = 0; i < initialSize; i++) {
      this.pool.push(factory());
    }
  }
  acquire() {
    return this.pool.pop() || this.factory();
  }
  release(obj) {
    this.pool.push(obj);
  }
}

results.push(measure('对象池 acquire/release (100万次)', () => {
  const pool = new ObjectPool(() => ({ x: 0, y: 0, z: 0 }), 1000);
  for (let i = 0; i < 1_000_000; i++) {
    const obj = pool.acquire();
    obj.x = i;
    pool.release(obj);
  }
}, 5));

// 测试5: TypedArray性能
results.push(measure('Float64Array操作 (1000万元素)', () => {
  const arr = new Float64Array(10_000_000);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = Math.sqrt(i);
  }
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
  }
  return sum;
}, 3));

// 测试6: Map vs Object
results.push(measure('Map操作 (100万次插入/查找)', () => {
  const map = new Map();
  for (let i = 0; i < 1_000_000; i++) {
    map.set(`key_${i}`, i);
  }
  let sum = 0;
  for (let i = 0; i < 1_000_000; i++) {
    sum += map.get(`key_${i}`);
  }
  return sum;
}, 3));

// 最终内存
const finalMem = getMemory();
console.log('\n最终内存状态:');
printMemory('最终', finalMem);

console.log('\n内存增长:');
console.log(`  heapUsed: +${formatBytes(finalMem.heapUsed - initialMem.heapUsed)}`);
console.log(`  rss: +${formatBytes(finalMem.rss - initialMem.rss)}`);

// 打印结果
console.log('\n测试结果:');
results.forEach(printResult);

console.log('\n--- JSON结果 ---');
console.log(JSON.stringify({
  runtime: getRuntime(),
  version: getVersion(),
  memory: {
    initial: initialMem,
    final: finalMem
  },
  results: results.map(r => ({ name: r.name, avg: r.avg }))
}, null, 2));
