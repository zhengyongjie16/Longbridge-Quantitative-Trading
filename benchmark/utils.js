/**
 * 性能测试工具函数
 */

export function getRuntime() {
  if (typeof Bun !== 'undefined') {
    return 'bun';
  }
  return 'node';
}

export function getVersion() {
  if (typeof Bun !== 'undefined') {
    return Bun.version;
  }
  return process.version;
}

export function formatNumber(num) {
  return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

export function measure(name, fn, iterations = 1) {
  const times = [];

  // 预热
  for (let i = 0; i < 3; i++) {
    fn();
  }

  // 正式测试
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    const end = performance.now();
    times.push(end - start);
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);

  return { name, avg, min, max, iterations };
}

export async function measureAsync(name, fn, iterations = 1) {
  const times = [];

  // 预热
  for (let i = 0; i < 3; i++) {
    await fn();
  }

  // 正式测试
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    const end = performance.now();
    times.push(end - start);
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);

  return { name, avg, min, max, iterations };
}

export function printResult(result) {
  console.log(`  ${result.name}:`);
  console.log(`    平均: ${formatNumber(result.avg)} ms`);
  console.log(`    最小: ${formatNumber(result.min)} ms`);
  console.log(`    最大: ${formatNumber(result.max)} ms`);
}

export function printHeader(title) {
  console.log('\n' + '='.repeat(60));
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

export function getMemoryUsage() {
  return process.memoryUsage();
}
