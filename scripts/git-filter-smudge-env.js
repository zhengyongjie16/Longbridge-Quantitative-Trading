#!/usr/bin/env node
/**
 * Git smudge filter for .env.sonar
 * 在 Git checkout 时恢复内容（实际不需要做任何处理，因为值在本地文件中）
 */

try {
  // 从 stdin 读取内容
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const content = Buffer.concat(chunks).toString('utf-8');
  
  // 直接输出（不做任何处理）
  process.stdout.write(content);
} catch (error) {
  process.stderr.write(`Error in smudge filter: ${error.message}\n`);
  process.exit(1);
}
