/**
 * PATH 环境变量安全校验模块
 *
 * 用于在通过 execSync 执行外部命令（如 docker-compose）前，确保当前进程的 PATH
 * 中只包含“固定、只读”的目录，避免通过 PATH 注入恶意可执行文件或写入敏感目录。
 *
 * 规则概要：
 * - PATH 中每项必须是绝对路径
 * - 不得包含 . / .. 等路径片段
 * - 不得包含环境变量展开字符（如 % $ ~）
 * - 每项必须指向已存在的目录，且该目录不可写（只读）
 *
 * 使用：在 run-sonar.js 等脚本中，执行 docker-compose 前调用 assertSafePathEnv(process.env.PATH)
 */
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

/** 用于检测 PATH 中是否含环境变量展开符（Windows %VAR%、Unix $VAR、~） */
const envVarPattern = /[%$~]/;

/**
 * 路径中是否包含 . 或 .. 片段（不允许，避免绕过校验）
 * @param {string} dirPath
 * @returns {boolean}
 */
function hasDotSegment(dirPath) {
  const segments = dirPath.split(/[/\\]+/);
  return segments.some((segment) => segment === '.' || segment === '..');
}

/**
 * 是否为“固定”路径：非空、无环境变量字符、绝对路径、无 . / ..
 * @param {string} dirPath
 * @returns {boolean}
 */
function isFixedPath(dirPath) {
  if (!dirPath || dirPath.trim().length === 0) {
    return false;
  }
  if (envVarPattern.test(dirPath)) {
    return false;
  }
  if (!path.isAbsolute(dirPath)) {
    return false;
  }
  if (hasDotSegment(dirPath)) {
    return false;
  }
  return true;
}

/**
 * 默认实现：判断路径是否为目录（通过 statSync）
 * @param {string} dirPath
 * @returns {boolean}
 */
function defaultIsDir(dirPath) {
  const stats = statSync(dirPath);
  return stats.isDirectory();
}

/**
 * 默认实现：判断目录是否可写（通过 accessSync W_OK）
 * @param {string} dirPath
 * @returns {boolean}
 */
function defaultIsWritable(dirPath) {
  try {
    accessSync(dirPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 校验 PATH 环境变量安全：每项必须为固定、已存在、且不可写的目录。
 * 若任一项不满足则抛错，用于在 exec 前防止 PATH 注入。
 *
 * @param {string} pathValue - 通常为 process.env.PATH
 * @param {object} [options]
 * @param {(p: string) => boolean} [options.isDir] - 判断是否为目录，默认 statSync + isDirectory
 * @param {(p: string) => boolean} [options.isWritable] - 判断是否可写，默认 accessSync W_OK
 * @throws {Error} PATH 为空、含非固定路径、含非目录、或含可写目录时抛出
 */
export function assertSafePathEnv(pathValue, options = {}) {
  const { isDir = defaultIsDir, isWritable = defaultIsWritable } = options;
  if (!pathValue || pathValue.trim().length === 0) {
    throw new Error('PATH 为空或未设置');
  }

  const entries = pathValue.split(path.delimiter);

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!isFixedPath(trimmed)) {
      throw new Error(`PATH 含非固定目录: ${entry}`);
    }

    let isDirectory = false;
    try {
      isDirectory = isDir(trimmed);
    } catch {
      throw new Error(`PATH 含不存在目录: ${entry}`);
    }

    if (!isDirectory) {
      throw new Error(`PATH 含非目录项: ${entry}`);
    }

    let writable = false;
    try {
      writable = isWritable(trimmed);
    } catch {
      writable = false;
    }

    if (writable) {
      throw new Error(`PATH 含可写目录: ${entry}`);
    }
  }
}
