/**
 * 主程序初始化相关工具函数
 * 包含纯函数，无副作用
 */

import { extractRSIPeriods } from '../utils/helpers/signalConfigParser.js';
import { validateEmaPeriod } from '../utils/helpers/indicatorHelpers.js';
import {
  positionObjectPool,
  kdjObjectPool,
  macdObjectPool,
} from '../utils/objectPool/index.js';
import type {
  Position,
  VerificationConfig,
  SignalConfigSet,
  MonitorState,
  MonitorConfig,
  IndicatorSnapshot,
  PositionCache,
} from '../types/index.js';

/**
 * 从验证配置中提取 EMA 周期
 * @param verificationConfig 验证配置
 * @returns EMA 周期数组（至少包含默认值 7）
 */
export function extractEmaPeriods(verificationConfig: VerificationConfig | null | undefined): number[] {
  const emaPeriods: number[] = [];

  if (verificationConfig) {
    // 从买入和卖出配置中提取 EMA 周期
    const allIndicators = [
      ...(verificationConfig.buy.indicators || []),
      ...(verificationConfig.sell.indicators || []),
    ];

    for (const indicator of allIndicators) {
      if (indicator.startsWith('EMA:')) {
        const periodStr = indicator.substring(4);
        const period = Number.parseInt(periodStr, 10);

        if (validateEmaPeriod(period) && !emaPeriods.includes(period)) {
          emaPeriods.push(period);
        }
      }
    }
  }

  // 如果没有配置任何 EMA 周期，使用默认值 7
  if (emaPeriods.length === 0) {
    emaPeriods.push(7);
  }

  return emaPeriods;
}

/**
 * 从信号配置中提取 RSI 周期
 * @param signalConfig 信号配置
 * @returns RSI 周期数组（至少包含默认值 6）
 */
export function extractRsiPeriodsWithDefault(signalConfig: SignalConfigSet | null): number[] {
  const rsiPeriods = extractRSIPeriods(signalConfig);

  // 如果没有配置任何 RSI 周期，使用默认值 6
  if (rsiPeriods.length === 0) {
    rsiPeriods.push(6);
  }

  return rsiPeriods;
}

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

/**
 * 释放所有监控标的的最后一个快照对象
 * @param monitorStates 监控状态Map
 */
export function releaseAllMonitorSnapshots(monitorStates: Map<string, MonitorState>): void {
  for (const monitorState of monitorStates.values()) {
    releaseSnapshotObjects(monitorState.lastMonitorSnapshot, monitorState.monitorValues);
    monitorState.lastMonitorSnapshot = null;
  }
}

/**
 * 从持仓缓存中获取指定标的的持仓
 * 使用 PositionCache 提供 O(1) 查找性能
 *
 * @param positionCache 持仓缓存
 * @param longSymbol 做多标的代码（已规范化）
 * @param shortSymbol 做空标的代码（已规范化）
 */
export function getPositions(
  positionCache: PositionCache,
  longSymbol: string,
  shortSymbol: string,
): { longPosition: Position | null; shortPosition: Position | null } {
  // O(1) 查找
  const longPos = positionCache.get(longSymbol);
  const shortPos = positionCache.get(shortSymbol);

  let longPosition: Position | null = null;
  let shortPosition: Position | null = null;

  // 创建持仓对象（复用对象池）
  if (longPos) {
    longPosition = positionObjectPool.acquire() as Position;
    longPosition.symbol = longSymbol;
    longPosition.costPrice = Number(longPos.costPrice) || 0;
    longPosition.quantity = Number(longPos.quantity) || 0;
    longPosition.availableQuantity = Number(longPos.availableQuantity) || 0;
    longPosition.accountChannel = longPos.accountChannel;
    longPosition.symbolName = longPos.symbolName;
    longPosition.currency = longPos.currency;
    longPosition.market = longPos.market;
  }

  if (shortPos) {
    shortPosition = positionObjectPool.acquire() as Position;
    shortPosition.symbol = shortSymbol;
    shortPosition.costPrice = Number(shortPos.costPrice) || 0;
    shortPosition.quantity = Number(shortPos.quantity) || 0;
    shortPosition.availableQuantity = Number(shortPos.availableQuantity) || 0;
    shortPosition.accountChannel = shortPos.accountChannel;
    shortPosition.symbolName = shortPos.symbolName;
    shortPosition.currency = shortPos.currency;
    shortPosition.market = shortPos.market;
  }

  return { longPosition, shortPosition };
}
