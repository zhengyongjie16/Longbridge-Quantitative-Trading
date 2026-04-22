import { getIndicatorValue, parseIndicatorPeriod } from '../../../utils/indicatorHelpers/index.js';
import type { IndicatorSnapshot } from '../../../types/quote.js';
import type { VerificationIndicator } from '../../../types/indicatorProfile.js';
import type {
  IndicatorCacheEntry,
  VerificationSamplePoint,
  VerificationSampleValues,
  _SampleQueue,
} from './types.js';

/**
 * 创建时间窗口样本队列。
 *
 * @returns 初始化后的空样本队列
 */
export function createSampleQueue(): _SampleQueue {
  return {
    entries: [],
  };
}

/**
 * 向时间窗口样本队列追加数据，并裁剪保留窗口外的旧样本。
 *
 * @param queue 目标样本队列
 * @param entry 待写入的缓存条目
 * @param retentionWindowMs 样本保留时间窗口（毫秒）
 * @returns 无返回值
 */
export function pushToQueue(
  queue: _SampleQueue,
  entry: IndicatorCacheEntry,
  retentionWindowMs: number,
): void {
  queue.entries.push(entry);

  const minTimestamp = entry.timestamp - retentionWindowMs;
  let firstRetainedIndex = 0;

  for (const [index, currentEntry] of queue.entries.entries()) {
    if (currentEntry.timestamp >= minTimestamp) {
      firstRetainedIndex = index;
      break;
    }

    firstRetainedIndex = index + 1;
  }

  if (firstRetainedIndex > 0) {
    queue.entries.splice(0, firstRetainedIndex);
  }
}

/**
 * 在时间窗口样本队列中查找最接近目标时间的条目。
 *
 * @param queue 目标样本队列
 * @param targetTime 目标时间戳（毫秒）
 * @returns 最接近目标时间的条目，无可用样本时返回 null
 */
export function findClosestEntry(
  queue: _SampleQueue,
  targetTime: number,
): IndicatorCacheEntry | null {
  const firstEntry = queue.entries[0];
  if (firstEntry === undefined) {
    return null;
  }

  let closestEntry: IndicatorCacheEntry = firstEntry;
  let minDiff = Math.abs(closestEntry.timestamp - targetTime);

  for (const [index, entry] of queue.entries.entries()) {
    if (index === 0) {
      continue;
    }

    const diff = Math.abs(entry.timestamp - targetTime);

    if (diff < minDiff || (diff === minDiff && entry.timestamp > closestEntry.timestamp)) {
      minDiff = diff;
      closestEntry = entry;
    }
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
