#!/usr/bin/env node
/**
 * Git clean filter for .env.local
 * 在 Git 提交时自动将敏感属性的值替换为占位符（键名本身）
 */

// 需要替换的敏感属性
const SENSITIVE_KEYS = new Set([
  'LONGPORT_APP_KEY',
  'LONGPORT_APP_SECRET',
  'LONGPORT_ACCESS_TOKEN',
]);

// 标的相关属性的匹配模式（匹配所有带数字后缀的）
const SYMBOL_KEY_PATTERNS = [
  /^MONITOR_SYMBOL_\d+$/,  // MONITOR_SYMBOL_1, MONITOR_SYMBOL_2, ...
  /^LONG_SYMBOL_\d+$/,      // LONG_SYMBOL_1, LONG_SYMBOL_2, ...
  /^SHORT_SYMBOL_\d+$/,     // SHORT_SYMBOL_1, SHORT_SYMBOL_2, ...
];

/**
 * 检查是否为敏感属性
 */
function isSensitiveKey(key) {
  // 检查固定敏感键
  if (SENSITIVE_KEYS.has(key)) {
    return true;
  }
  
  // 检查标的相关属性
  return SYMBOL_KEY_PATTERNS.some(pattern => pattern.test(key));
}

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
      if (isSensitiveKey(key)) {
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
