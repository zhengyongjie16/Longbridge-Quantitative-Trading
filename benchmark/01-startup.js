/**
 * 测试1: 启动时间测试
 * 测量运行时的冷启动时间
 */

const startTime = performance.now();

// 模拟基本的模块加载
import { createReadStream } from 'fs';
import { join } from 'path';
import { EventEmitter } from 'events';

const endTime = performance.now();

const runtime = typeof Bun !== 'undefined' ? 'Bun' : 'Node.js';
const version = typeof Bun !== 'undefined' ? Bun.version : process.version;

console.log(`运行时: ${runtime} ${version}`);
console.log(`启动时间: ${(endTime - startTime).toFixed(2)} ms`);
