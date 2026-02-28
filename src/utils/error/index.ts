import { inspect } from 'node:util';
import { isRecord } from '../primitives/index.js';

/**
 * 类型保护：检查是否为 Error 实例（内部使用）。
 *
 * @param value 待检查值
 * @returns 如果是 Error 实例返回 true
 */
function isError(value: unknown): value is Error {
  return value instanceof Error;
}

/**
 * 类型保护：检查是否为类似错误的对象（内部使用）。
 *
 * @param value 待检查值
 * @returns 如果对象包含常见错误字段返回 true
 */
function isErrorLike(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value['message'] === 'string' ||
    typeof value['error'] === 'string' ||
    typeof value['msg'] === 'string' ||
    typeof value['code'] === 'string'
  );
}

/**
 * 将错误对象格式化为可读字符串。
 * 默认行为：null/undefined 返回「未知错误」；Error 取 message；类错误对象取 message/error/msg/code；否则 JSON 或 inspect。
 *
 * @param err 任意错误或未知值
 * @returns 可读错误消息字符串
 */
export function formatError(err: unknown): string {
  if (err === null || err === undefined) {
    return '未知错误';
  }
  if (typeof err === 'string') {
    return err;
  }
  if (isError(err)) {
    return err.message || err.name || 'Error';
  }
  if (typeof err !== 'object') {
    return inspect(err, { depth: 5, maxArrayLength: 100 });
  }
  if (isErrorLike(err)) {
    const errorKeys = ['message', 'error', 'msg', 'code'] as const;
    for (const key of errorKeys) {
      const value = err[key];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
  }
  try {
    return JSON.stringify(err);
  } catch {
    return inspect(err, { depth: 5, maxArrayLength: 100 });
  }
}
