/**
 * 测试3: 文件 I/O 性能测试
 */
import { getRuntime, getVersion, measureAsync, printResult, printHeader, formatBytes } from './utils.js';
import { writeFileSync, readFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';

const testDir = join(import.meta.dirname, 'temp');
if (!existsSync(testDir)) {
  mkdirSync(testDir, { recursive: true });
}

printHeader(`文件 I/O 性能测试 - ${getRuntime()} ${getVersion()}`);

const results = [];

// 生成测试数据
const smallData = 'Hello World!\n'.repeat(1000);  // ~13KB
const mediumData = 'A'.repeat(1024 * 1024);       // 1MB
const largeData = 'B'.repeat(10 * 1024 * 1024);   // 10MB

console.log(`\n测试数据大小:`);
console.log(`  小文件: ${formatBytes(smallData.length)}`);
console.log(`  中文件: ${formatBytes(mediumData.length)}`);
console.log(`  大文件: ${formatBytes(largeData.length)}`);

// 测试1: 同步写入小文件
const smallFile = join(testDir, 'small.txt');
results.push(await measureAsync('同步写入小文件 (13KB) x100', async () => {
  for (let i = 0; i < 100; i++) {
    writeFileSync(smallFile, smallData);
  }
}, 3));

// 测试2: 同步读取小文件
results.push(await measureAsync('同步读取小文件 (13KB) x100', async () => {
  for (let i = 0; i < 100; i++) {
    readFileSync(smallFile, 'utf-8');
  }
}, 3));

// 测试3: 异步写入中文件
const mediumFile = join(testDir, 'medium.txt');
results.push(await measureAsync('异步写入中文件 (1MB) x10', async () => {
  for (let i = 0; i < 10; i++) {
    await writeFile(mediumFile, mediumData);
  }
}, 3));

// 测试4: 异步读取中文件
results.push(await measureAsync('异步读取中文件 (1MB) x10', async () => {
  for (let i = 0; i < 10; i++) {
    await readFile(mediumFile, 'utf-8');
  }
}, 3));

// 测试5: 异步写入大文件
const largeFile = join(testDir, 'large.txt');
results.push(await measureAsync('异步写入大文件 (10MB) x3', async () => {
  for (let i = 0; i < 3; i++) {
    await writeFile(largeFile, largeData);
  }
}, 3));

// 测试6: 异步读取大文件
results.push(await measureAsync('异步读取大文件 (10MB) x3', async () => {
  for (let i = 0; i < 3; i++) {
    await readFile(largeFile, 'utf-8');
  }
}, 3));

// 清理
try {
  unlinkSync(smallFile);
  unlinkSync(mediumFile);
  unlinkSync(largeFile);
} catch {}

// 打印结果
console.log('\n测试结果:');
results.forEach(printResult);

console.log('\n--- JSON结果 ---');
console.log(JSON.stringify({
  runtime: getRuntime(),
  version: getVersion(),
  results: results.map(r => ({ name: r.name, avg: r.avg }))
}, null, 2));
