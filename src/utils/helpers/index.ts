import type { MonitorState } from '../../types/state.js';
import type { MonitorConfig } from '../../types/config.js';
import type { IndicatorSnapshot } from '../../types/quote.js';
import type { SignalType } from '../../types/signal.js';
import type { DecimalLike } from './types.js';
import { isRecord } from '../primitives/index.js';
import { kdjObjectPool, macdObjectPool, periodRecordPool } from '../objectPool/index.js';

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
 * 判断是否为买入操作。默认行为：无。
 *
 * @param action 信号类型
 * @returns 为 BUYCALL 或 BUYPUT 时返回 true
 */
export function isBuyAction(action: SignalType): boolean {
  return action === 'BUYCALL' || action === 'BUYPUT';
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
 * 默认行为：snapshot 为 null 直接返回；否则仅释放未被 monitorValues 引用的池化对象，已引用的不释放。
 *
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
