import { getIndicatorValue, parseIndicatorPeriod } from '../../../utils/indicatorHelpers/index.js';
import type { IndicatorSnapshot } from '../../../types/quote.js';
import type { VerificationIndicator } from '../../../types/indicatorProfile.js';
import type {
  IndicatorCacheEntry,
  VerificationSamplePoint,
  VerificationSampleValues,
  _RingBuffer,
} from './types.js';

/**
 * 创建环形缓冲区
 * @param capacity 缓冲区容量（最大条目数）
 * @returns 初始化后的空环形缓冲区
 */
export function createRingBuffer(capacity: number): _RingBuffer {
  return {
    entries: Array.from<IndicatorCacheEntry | null>({ length: capacity }).fill(null),
    head: 0,
    size: 0,
    capacity,
  };
}

/**
 * 向环形缓冲区推送数据
 *
 * 在 head 位置写入新条目，然后移动 head 指针。
 * 若缓冲区已满，会覆盖最旧的数据。
 *
 * @param buffer 目标环形缓冲区
 * @param entry 待写入的缓存条目
 * @returns 无返回值
 */
export function pushToBuffer(buffer: _RingBuffer, entry: IndicatorCacheEntry): void {
  buffer.entries[buffer.head] = entry;
  buffer.head = (buffer.head + 1) % buffer.capacity;
  if (buffer.size < buffer.capacity) {
    buffer.size++;
  }
}

/**
 * 在环形缓冲区中查找容忍度内最接近目标时间的条目
 *
 * 直接遍历缓冲区避免先物化完整数组，减少临时分配。
 *
 * @param buffer 目标环形缓冲区
 * @param targetTime 目标时间戳（毫秒）
 * @param toleranceMs 允许的最大时间偏差（毫秒）
 * @returns 容忍度内最接近目标时间的条目，无匹配时返回 null
 */
export function findClosestEntry(
  buffer: _RingBuffer,
  targetTime: number,
  toleranceMs: number,
): IndicatorCacheEntry | null {
  if (buffer.size === 0) {
    return null;
  }

  let closestEntry: IndicatorCacheEntry | null = null;
  let minDiff = Infinity;

  const updateClosestEntry = (entry: IndicatorCacheEntry | null | undefined): void => {
    if (entry === null || entry === undefined) {
      return;
    }

    const diff = Math.abs(entry.timestamp - targetTime);
    if (diff <= toleranceMs && diff < minDiff) {
      minDiff = diff;
      closestEntry = entry;
    }
  };

  if (buffer.size < buffer.capacity) {
    for (let index = 0; index < buffer.size; index += 1) {
      updateClosestEntry(buffer.entries[index]);
    }

    return closestEntry;
  }

  for (let index = buffer.head; index < buffer.capacity; index += 1) {
    updateClosestEntry(buffer.entries[index]);
  }

  for (let index = 0; index < buffer.head; index += 1) {
    updateClosestEntry(buffer.entries[index]);
  }

  return closestEntry;
}

/**
 * 把完整指标快照投影为延迟验证最小样本。
 *
 * @param snapshot 最新指标快照
 * @param verificationIndicators 当前 monitor 需要保留的延迟验证指标集合
 * @returns 仅包含延迟验证所需指标的三态样本值映射
 */
export function projectVerificationSampleValues(
  snapshot: IndicatorSnapshot,
  verificationIndicators: ReadonlyArray<VerificationIndicator>,
): VerificationSampleValues {
  const values: Partial<Record<VerificationIndicator, VerificationSamplePoint>> = {};

  for (const indicator of verificationIndicators) {
    const value = getIndicatorValue(snapshot, indicator);
    if (value !== null) {
      values[indicator] = {
        kind: 'value',
        value,
      };
      continue;
    }

    values[indicator] = isIndicatorPresentInSnapshot(snapshot, indicator)
      ? { kind: 'invalid' }
      : { kind: 'missing' };
  }

  return values;
}

/**
 * 判断快照是否包含指定验证指标字段。
 *
 * @param snapshot 指标快照
 * @param indicator 指标名称
 * @returns 指标字段存在返回 true，否则返回 false
 */
function isIndicatorPresentInSnapshot(
  snapshot: IndicatorSnapshot,
  indicator: VerificationIndicator,
): boolean {
  if (indicator === 'ADX') {
    return snapshot.adx !== null;
  }

  if (indicator === 'K' || indicator === 'D' || indicator === 'J') {
    return snapshot.kdj !== null;
  }

  if (indicator === 'MACD' || indicator === 'DIF' || indicator === 'DEA') {
    return snapshot.macd !== null;
  }

  if (indicator.startsWith('EMA:')) {
    const period = parseIndicatorPeriod({ indicatorName: indicator, prefix: 'EMA:' });
    return period !== null && snapshot.ema?.[period] !== undefined;
  }

  const period = parseIndicatorPeriod({ indicatorName: indicator, prefix: 'PSY:' });
  return period !== null && snapshot.psy?.[period] !== undefined;
}
