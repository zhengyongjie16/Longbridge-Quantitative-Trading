/**
 * IndicatorCache 工具函数
 *
 * 提供环形缓冲区相关操作和快照克隆功能：
 * - createRingBuffer: 创建指定容量的环形缓冲区
 * - pushToBuffer: 向缓冲区推送数据
 * - getBufferEntries: 获取所有有效条目（按时间升序）
 * - getLatestFromBuffer: 获取最新条目
 * - cloneIndicatorSnapshot: 深拷贝指标快照
 */
import type { IndicatorSnapshot } from '../../../types/index.js';
import type { IndicatorCacheEntry, _RingBuffer } from './types.js';

/**
 * 创建环形缓冲区
 * @param capacity 缓冲区容量
 */
export function createRingBuffer(capacity: number): _RingBuffer {
  return {
    entries: new Array<IndicatorCacheEntry | null>(capacity).fill(null),
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
 */
export function pushToBuffer(buffer: _RingBuffer, entry: IndicatorCacheEntry): void {
  buffer.entries[buffer.head] = entry;
  buffer.head = (buffer.head + 1) % buffer.capacity;
  if (buffer.size < buffer.capacity) {
    buffer.size++;
  }
}

/**
 * 获取环形缓冲区中所有有效条目
 *
 * 返回按写入顺序排列的条目数组（即按时间升序）
 */
export function getBufferEntries(buffer: _RingBuffer): IndicatorCacheEntry[] {
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
}

/**
 * 获取环形缓冲区最新条目
 *
 * 返回最后写入的条目（head - 1 位置）
 */
export function getLatestFromBuffer(buffer: _RingBuffer): IndicatorCacheEntry | null {
  if (buffer.size === 0) return null;

  const latestIndex = (buffer.head - 1 + buffer.capacity) % buffer.capacity;
  return buffer.entries[latestIndex] ?? null;
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
