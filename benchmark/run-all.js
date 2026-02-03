/**
 * 综合性能测试运行器
 * 运行所有测试并收集结果
 */

import { spawn } from 'child_process';
import { join } from 'path';
import { writeFileSync } from 'fs';

const benchmarkDir = import.meta.dirname;

const tests = [
  '01-startup.js',
  '02-basic-compute.js',
  '03-file-io.js',
  '04-json.js',
  '05-indicators.js',
  '06-async.js',
  '07-memory.js'
];

async function runTest(runtime, testFile) {
  return new Promise((resolve, reject) => {
    const testPath = join(benchmarkDir, testFile);
    const proc = spawn(runtime, [testPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, code });
    });

    proc.on('error', reject);
  });
}

async function main() {
  const runtime = process.argv[2] || 'node';
  console.log(`\n运行时: ${runtime}`);
  console.log('='.repeat(60));

  for (const test of tests) {
    console.log(`\n运行测试: ${test}`);
    console.log('-'.repeat(40));

    try {
      const result = await runTest(runtime, test);
      console.log(result.stdout);
      if (result.stderr) {
        console.error('错误:', result.stderr);
      }
    } catch (err) {
      console.error(`测试失败: ${err.message}`);
    }
  }
}

main().catch(console.error);
