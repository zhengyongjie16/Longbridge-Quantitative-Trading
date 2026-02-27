import type { MonitorState } from '../../types/state.js';
import type { MonitorConfig } from '../../types/config.js';
import type { IndicatorSnapshot } from '../../types/quote.js';
import type { SignalType } from '../../types/signal.js';
import { inspect } from 'node:util';
import { TIME } from '../../constants/index.js';
import type { DecimalLike, TimeFormatOptions } from './types.js';
import { logger } from '../logger/index.js';
import { kdjObjectPool, macdObjectPool, periodRecordPool } from '../objectPool/index.js';

/**
 * 类型保护：判断 unknown 是否为可索引对象。默认行为：null 与非对象返回 false。
 *
 * @param value 待判断值
 * @returns true 表示可按键读取字段，否则返回 false
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 类型保护：判断 unknown 是否为数值周期字典（Record<number, number>）。
 *
 * @param value 待判断值
 * @returns true 表示可作为 periodRecordPool 的对象
 */
function isPeriodRecord(value: unknown): value is Record<number, number> {
  if (!isRecord(value)) {
    return false;
  }
  for (const propertyValue of Object.values(value)) {
    if (typeof propertyValue !== 'number') {
      return false;
    }
  }
  return true;
}

/**
 * 类型保护：检查是否为 Error 实例（内部使用）
 * @param value 待检查的值
 * @returns 如果是 Error 实例返回 true，同时收窄类型为 Error
 */
function isError(value: unknown): value is Error {
  return value instanceof Error;
}

/**
 * 类型保护：检查是否为类似错误的对象（内部使用）
 * @param value 待检查的值
 * @returns 如果对象包含常见错误属性（message/error/msg）返回 true，同时收窄类型为 Record<string, unknown>
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
 * 将 Decimal 类型转换为数字。默认行为：null/undefined 返回 NaN，便于调用方用 Number.isFinite() 判断。
 *
 * @param decimalLike Decimal 对象、数字、字符串或 null/undefined
 * @returns 转换后的数字，null/undefined 时返回 NaN
 */
export function decimalToNumber(
  decimalLike: DecimalLike | number | string | null | undefined,
): number {
  // 如果输入为 null 或 undefined，返回 NaN 而非 0
  // 这样 Number.isFinite() 检查会返回 false，避免错误地使用 0 作为有效值
  if (decimalLike === null || decimalLike === undefined) {
    return Number.NaN;
  }
  if (typeof decimalLike === 'object' && 'toNumber' in decimalLike) {
    return decimalLike.toNumber();
  }
  return Number(decimalLike);
}

/**
 * 检查值是否为有效的正数（有限且大于 0）。默认行为：非 number 或非正数返回 false。
 *
 * @param value 待检查的值
 * @returns 为有限正数时返回 true，否则返回 false
 */
export function isValidPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * 格式化标的显示为「中文名称(代码)」。默认行为：symbol 为空返回空串；symbolName 为空时仅返回代码。
 *
 * @param symbol 标的代码
 * @param symbolName 标的中文名称，默认 null
 * @returns 格式化后的显示字符串
 */
export function formatSymbolDisplay(
  symbol: string | null | undefined,
  symbolName: string | null = null,
): string {
  if (!symbol) {
    return '';
  }
  if (symbolName) {
    return `${symbolName}(${symbol})`;
  }
  return symbol;
}

/**
 * 将时间转换为香港时区（UTC+8）字符串，支持 iso / log 两种格式（内部使用）。
 * @param date - 时间对象，默认当前时间
 * @param options - 格式选项，format 为 'log' 时含毫秒
 * @returns 香港时间字符串
 */
function toHongKongTime(date: Date | null = null, options: TimeFormatOptions = {}): string {
  const { format = 'iso' } = options;
  const targetDate = date ?? new Date();
  // 转换为香港时间（UTC+8）
  const hkOffset = TIME.HONG_KONG_TIMEZONE_OFFSET_MS;
  const hkTime = new Date(targetDate.getTime() + hkOffset);

  // 使用UTC方法获取年月日时分秒，这样得到的就是香港时间
  const year = hkTime.getUTCFullYear();
  const month = String(hkTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(hkTime.getUTCDate()).padStart(2, '0');
  const hours = String(hkTime.getUTCHours()).padStart(2, '0');
  const minutes = String(hkTime.getUTCMinutes()).padStart(2, '0');
  const seconds = String(hkTime.getUTCSeconds()).padStart(2, '0');

  if (format === 'log') {
    // 日志格式：YYYY-MM-DD HH:mm:ss.sss（包含毫秒）
    const milliseconds = String(hkTime.getUTCMilliseconds()).padStart(3, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
  }

  // ISO 格式：YYYY/MM/DD/HH:mm:ss（不包含毫秒）
  return `${year}/${month}/${day}/${hours}:${minutes}:${seconds}`;
}

/**
 * 将时间转换为香港时间（UTC+8）的 ISO 格式字符串。默认行为：date 为 null 时使用当前时间；格式 YYYY/MM/DD/HH:mm:ss。
 *
 * @param date 时间对象，默认 null（当前时间）
 * @returns 香港时间字符串 YYYY/MM/DD/HH:mm:ss
 */
export function toHongKongTimeIso(date: Date | null = null): string {
  return toHongKongTime(date, { format: 'iso' });
}

/**
 * 将时间转换为香港时间（UTC+8）的日志格式字符串。默认行为：date 为 null 时使用当前时间；格式含毫秒 YYYY-MM-DD HH:mm:ss.sss。
 *
 * @param date 时间对象，默认 null（当前时间）
 * @returns 香港时间字符串 YYYY-MM-DD HH:mm:ss.sss
 */
export function toHongKongTimeLog(date: Date | null = null): string {
  return toHongKongTime(date, { format: 'log' });
}

/**
 * 判断是否为买入操作。默认行为：无。
 *
 * @param action 信号类型
 * @returns 为 BUYCALL 或 BUYPUT 时返回 true
 */
export function isBuyAction(action: SignalType): boolean {
  return action === 'BUYCALL' || action === 'BUYPUT';
}

/**
 * 判断是否为卖出操作。默认行为：无。
 *
 * @param action 信号类型
 * @returns 为 SELLCALL 或 SELLPUT 时返回 true
 */
export function isSellAction(action: SignalType): boolean {
  return action === 'SELLCALL' || action === 'SELLPUT';
}

/**
 * 将错误对象格式化为可读字符串。默认行为：null/undefined 返回「未知错误」；Error 取 message；类错误对象取 message/error/msg/code；否则 JSON 或 inspect。
 *
 * @param err 任意错误或未知值
 * @returns 可读错误消息字符串
 */
export function formatError(err: unknown): string {
  // null/undefined
  if (err === null || err === undefined) {
    return '未知错误';
  }
  // 字符串直接返回
  if (typeof err === 'string') {
    return err;
  }
  // Error 实例优先提取 message（使用类型保护）
  if (isError(err)) {
    return err.message || err.name || 'Error';
  }
  // 基本类型直接转换
  if (typeof err !== 'object') {
    return inspect(err, { depth: 5, maxArrayLength: 100 });
  }
  // 处理类似错误的对象（使用类型保护）
  if (isErrorLike(err)) {
    const errorKeys = ['message', 'error', 'msg', 'code'] as const;
    for (const key of errorKeys) {
      const value = err[key];
      if (typeof value === 'string' && value) {
        return value;
      }
    }
  }
  // 尝试 JSON 序列化
  try {
    const jsonStr = JSON.stringify(err);
    return jsonStr;
  } catch {
    // 如果 JSON 序列化失败，使用 inspect 来显示对象内容
    // 限制深度和数组长度，避免输出过长
    return inspect(err, { depth: 5, maxArrayLength: 100 });
  }
}

/**
 * 异步延迟指定毫秒数，无效值时使用 1000ms
 * @param ms 延迟毫秒数
 * @returns Promise，延迟结束后 resolve
 */
export async function sleep(ms: number): Promise<void> {
  const delay = ms;
  if (!Number.isFinite(delay) || delay < 0) {
    logger.warn(`[sleep] 无效的延迟时间 ${ms}，使用默认值 ${TIME.MILLISECONDS_PER_SECOND}ms`);
    return new Promise<void>((resolve) => {
      setTimeout(resolve, TIME.MILLISECONDS_PER_SECOND);
    });
  }
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delay);
  });
}

/**
 * 根据监控配置初始化单标的监控状态。默认行为：无；所有可更新字段初始为 null 或空。
 *
 * @param config 监控配置（monitorSymbol 等）
 * @returns 初始化的 MonitorState
 */
export function initMonitorState(config: MonitorConfig): MonitorState {
  return {
    monitorSymbol: config.monitorSymbol,
    monitorPrice: null,
    longPrice: null,
    shortPrice: null,
    signal: null,
    pendingDelayedSignals: [],
    monitorValues: null,
    lastMonitorSnapshot: null,
    lastCandleFingerprint: null,
  };
}

/**
 * 释放快照中的池化对象（如果它们没有被 monitorValues 引用），避免重复归还同一引用导致池状态异常。
 * @param snapshot 要释放的快照
 * @param monitorValues 监控值对象，用于检查引用
 * @returns 无返回值
 */
export function releaseSnapshotObjects(
  snapshot: IndicatorSnapshot | null,
  monitorValues: MonitorState['monitorValues'],
): void {
  if (!snapshot) {
    return;
  }

  const releasePeriodRecord = (
    snapshotRecord: Readonly<Record<number, number>> | null,
    monitorRecord: Readonly<Record<number, number>> | null | undefined,
  ): void => {
    if (!snapshotRecord || monitorRecord === snapshotRecord) {
      return;
    }
    if (isPeriodRecord(snapshotRecord)) {
      // snapshot 中的周期记录来自 periodRecordPool，可安全回收到池中复用
      periodRecordPool.release(snapshotRecord);
    }
  };

  // 释放周期指标对象（如果它们没有被 monitorValues 引用）
  releasePeriodRecord(snapshot.ema, monitorValues?.ema);
  releasePeriodRecord(snapshot.rsi, monitorValues?.rsi);
  releasePeriodRecord(snapshot.psy, monitorValues?.psy);

  // 释放 KDJ 对象（如果它没有被 monitorValues 引用）
  if (snapshot.kdj && monitorValues?.kdj !== snapshot.kdj) {
    kdjObjectPool.release(snapshot.kdj);
  }

  // 释放 MACD 对象（如果它没有被 monitorValues 引用）
  if (snapshot.macd && monitorValues?.macd !== snapshot.macd) {
    macdObjectPool.release(snapshot.macd);
  }
}
