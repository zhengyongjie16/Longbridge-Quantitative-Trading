import type { IndicatorSnapshot } from '../../../types/quote.js';
import type { IndicatorCacheEntry, _RingBuffer } from './types.js';

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

  const startIndex = buffer.size < buffer.capacity ? 0 : buffer.head;
  let closestEntry: IndicatorCacheEntry | null = null;
  let minDiff = Infinity;

  for (let i = 0; i < buffer.size; i += 1) {
    const index = (startIndex + i) % buffer.capacity;
    const entry = buffer.entries[index];
    if (entry === null || entry === undefined) {
      continue;
    }

    const diff = Math.abs(entry.timestamp - targetTime);
    if (diff <= toleranceMs && diff < minDiff) {
      minDiff = diff;
      closestEntry = entry;
    }
  }

  return closestEntry;
}

/**
 * 克隆指标快照
 *
 * 创建 IndicatorSnapshot 的深拷贝，确保所有嵌套对象（kdj、macd、rsi、ema、psy）
 * 都是独立的副本，不受外部对象池操作的影响。
 *
 * 此函数用于解决对象生命周期管理问题：
 * - 主循环中的 snapshot 使用对象池管理 kdj/macd
 * - IndicatorCache 需要长期保存数据（至少 15-25 秒）供延迟验证查询
 * - 如果不克隆，主循环释放对象池对象后，IndicatorCache 中的数据会被破坏
 *
 * @param snapshot 原始指标快照
 * @returns 独立的快照副本
 */
export function cloneIndicatorSnapshot(snapshot: IndicatorSnapshot): IndicatorSnapshot {
  const { kdj, macd, rsi, ema, psy } = snapshot;
  // 构建基础快照（不包含可选的 symbol）
  const cloned: IndicatorSnapshot = {
    price: snapshot.price,
    changePercent: snapshot.changePercent,
    mfi: snapshot.mfi,
    kdj: kdj ? { k: kdj.k, d: kdj.d, j: kdj.j } : null,
    macd: macd ? { macd: macd.macd, dif: macd.dif, dea: macd.dea } : null,
    rsi: rsi ? { ...rsi } : null,
    ema: ema ? { ...ema } : null,
    psy: psy ? { ...psy } : null,
  };

  // 仅当 symbol 存在时才添加（满足 exactOptionalPropertyTypes）
  if (snapshot.symbol !== undefined) {
    return { ...cloned, symbol: snapshot.symbol };
  }

  return cloned;
}
