/**
 * 主程序通用工具函数
 */

import {
  kdjObjectPool,
  macdObjectPool,
} from '../objectPool/index.js';
import type {
  IndicatorSnapshot,
  MonitorConfig,
  MonitorState,
} from '../../types/index.js';

/**
 * 初始化监控标的状态
 * @param config 监控配置
 * @returns 初始化的监控状态
 */
export function initMonitorState(config: MonitorConfig): MonitorState {
  return {
    monitorSymbol: config.monitorSymbol,
    longSymbol: config.longSymbol,
    shortSymbol: config.shortSymbol,
    longPrice: null,
    shortPrice: null,
    signal: null,
    pendingDelayedSignals: [],
    monitorValues: null,
    lastMonitorSnapshot: null,
  };
}

/**
 * 释放快照中的 KDJ 和 MACD 对象（如果它们没有被 monitorValues 引用）
 * @param snapshot 要释放的快照
 * @param monitorValues 监控值对象，用于检查引用
 */
export function releaseSnapshotObjects(
  snapshot: IndicatorSnapshot | null,
  monitorValues: MonitorState['monitorValues'],
): void {
  if (!snapshot) {
    return;
  }

  // 释放 KDJ 对象（如果它没有被 monitorValues 引用）
  if (snapshot.kdj && monitorValues?.kdj !== snapshot.kdj) {
    kdjObjectPool.release(snapshot.kdj);
  }

  // 释放 MACD 对象（如果它没有被 monitorValues 引用）
  if (snapshot.macd && monitorValues?.macd !== snapshot.macd) {
    macdObjectPool.release(snapshot.macd);
  }
}
