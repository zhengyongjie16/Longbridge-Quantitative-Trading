import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

const envVarPattern = /[%$~]/;

function hasDotSegment(dirPath) {
  const segments = dirPath.split(/[/\\]+/);
  return segments.some(segment => segment === '.' || segment === '..');
}

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

function defaultIsDir(dirPath) {
  const stats = statSync(dirPath);
  return stats.isDirectory();
}

function defaultIsWritable(dirPath) {
  try {
    accessSync(dirPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function assertSafePathEnv(pathValue, options = {}) {
  const { isDir = defaultIsDir, isWritable = defaultIsWritable } = options;
  if (!pathValue || pathValue.trim().length === 0) {
    throw new Error('PATH 为空或未设置');
  }

  const entries = pathValue.split(path.delimiter);
  if (entries.length === 0) {
    throw new Error('PATH 为空或未设置');
  }

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
