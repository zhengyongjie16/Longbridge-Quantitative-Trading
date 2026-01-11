#!/usr/bin/env node
/**
 * Git clean filter for .env.sonar
 * 在 Git 提交时自动将 SONAR_TOKEN 和 SONAR_SCANNER_PATH 的值替换为占位符（键名本身）
 */

const SENSITIVE_KEYS = new Set(['SONAR_TOKEN', 'SONAR_SCANNER_PATH']);

try {
  let content = '';
  
  // 从 stdin 读取内容
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  content = Buffer.concat(chunks).toString('utf-8');
  
  // 处理每一行
  const lines = content.split('\n');
  const processedLines = lines.map(line => {
    const trimmed = line.trim();
    
    // 空行或注释行直接保留
    if (!trimmed || trimmed.startsWith('#')) {
      return line;
    }
    
    // 检查是否是敏感属性
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      if (SENSITIVE_KEYS.has(key)) {
        // 保留键名，将值替换为键名作为占位符
        return `${key}=${key}`;
      }
    }
    
    // 其他行保持不变
    return line;
  });
  
  // 输出处理后的内容
  process.stdout.write(processedLines.join('\n'));
} catch (error) {
  // 如果出错，输出原始内容
  process.stderr.write(`Error in clean filter: ${error.message}\n`);
  process.exit(1);
}
