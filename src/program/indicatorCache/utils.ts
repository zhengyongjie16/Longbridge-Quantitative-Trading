/**
 * IndicatorCache 工具函数
 * 环形缓冲区相关操作和快照克隆
 */

import type { IndicatorSnapshot } from '../../types/index.js';
import type { IndicatorCacheEntry, RingBuffer } from './types.js';

/**
 * 创建环形缓冲区
 */
export const createRingBuffer = (capacity: number): RingBuffer => ({
  entries: new Array<IndicatorCacheEntry | null>(capacity).fill(null),
  head: 0,
  size: 0,
  capacity,
});

/**
 * 向环形缓冲区推送数据
 */
export const pushToBuffer = (buffer: RingBuffer, entry: IndicatorCacheEntry): void => {
  buffer.entries[buffer.head] = entry;
  buffer.head = (buffer.head + 1) % buffer.capacity;
  if (buffer.size < buffer.capacity) {
    buffer.size++;
  }
};

/**
 * 获取环形缓冲区中所有有效条目（按时间升序）
 */
export const getBufferEntries = (buffer: RingBuffer): IndicatorCacheEntry[] => {
  if (buffer.size === 0) return [];

  const result: IndicatorCacheEntry[] = [];
  const startIndex = buffer.size < buffer.capacity ? 0 : buffer.head;

  for (let i = 0; i < buffer.size; i++) {
    const index = (startIndex + i) % buffer.capacity;
    const entry = buffer.entries[index];
    if (entry != null) {
      result.push(entry);
    }
  }

  return result;
};

/**
 * 获取环形缓冲区最新条目
 */
export const getLatestFromBuffer = (buffer: RingBuffer): IndicatorCacheEntry | null => {
  if (buffer.size === 0) return null;

  const latestIndex = (buffer.head - 1 + buffer.capacity) % buffer.capacity;
  return buffer.entries[latestIndex] ?? null;
};

/**
 * 克隆指标快照
 *
 * 创建 IndicatorSnapshot 的深拷贝，确保所有嵌套对象（kdj、macd、rsi、ema）
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
export const cloneIndicatorSnapshot = (snapshot: IndicatorSnapshot): IndicatorSnapshot => {
  // 构建基础快照（不包含可选的 symbol）
  const cloned: IndicatorSnapshot = {
    price: snapshot.price,
    changePercent: snapshot.changePercent,
    mfi: snapshot.mfi,
    // 克隆 kdj 对象（避免对象池释放后数据被破坏）
    kdj: snapshot.kdj
      ? { k: snapshot.kdj.k, d: snapshot.kdj.d, j: snapshot.kdj.j }
      : null,
    // 克隆 macd 对象（避免对象池释放后数据被破坏）
    macd: snapshot.macd
      ? { macd: snapshot.macd.macd, dif: snapshot.macd.dif, dea: snapshot.macd.dea }
      : null,
    // 克隆 rsi 对象（Record<number, number> 也使用对象池）
    rsi: snapshot.rsi ? { ...snapshot.rsi } : null,
    // 克隆 ema 对象（Record<number, number> 也使用对象池）
    ema: snapshot.ema ? { ...snapshot.ema } : null,
  };

  // 仅当 symbol 存在时才添加（满足 exactOptionalPropertyTypes）
  if (snapshot.symbol !== undefined) {
    return { ...cloned, symbol: snapshot.symbol };
  }

  return cloned;
};
