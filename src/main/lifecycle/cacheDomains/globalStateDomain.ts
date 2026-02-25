/**
 * 全局状态缓存域（CacheDomain: globalState）
 *
 * 午夜清理：
 * - 禁止交易（canTrade = false）
 * - 重置半日标记、开盘保护、交易日信息缓存
 * - 清空交易标的集合（allTradingSymbols 的权威清理位置）
 * - 重置各监控标的的运行状态（行情、信号、指标快照等）
 * - 释放对象池中的快照对象，防止内存泄漏
 *
 * 开盘重建：
 * - 调用 runOpenRebuild 执行完整的开盘重建流水线
 *   （加载运行时快照 → 重建交易日状态）
 */
import { logger } from '../../../utils/logger/index.js';
import { releaseSnapshotObjects } from '../../../utils/helpers/index.js';
import type { LastState, MonitorState } from '../../../types/state.js';
import type { CacheDomain } from '../types.js';
import type { GlobalStateDomainDeps } from './types.js';

/**
 * 重置单个监控标的的运行状态，释放快照对象回对象池，防止跨日数据污染。
 *
 * @param monitorState 单个监控标的的运行时状态（lastMonitorSnapshot、monitorPrice 等）
 */
function resetMonitorStateForNewDay(monitorState: MonitorState): void {
  releaseSnapshotObjects(monitorState.lastMonitorSnapshot, monitorState.monitorValues);
  monitorState.monitorPrice = null;
  monitorState.longPrice = null;
  monitorState.shortPrice = null;
  monitorState.signal = null;
  monitorState.pendingDelayedSignals = [];
  monitorState.monitorValues = null;
  monitorState.lastMonitorSnapshot = null;
  monitorState.lastCandleFingerprint = null;
}

/**
 * 全局域午夜清理。
 * 清理 allTradingSymbols（权威位置）、交易日与门禁相关状态，并重置各监控标的运行状态。
 * currentDayKey 仅由 dayLifecycleManager 在全部 clear 成功后提交，此处不写入。
 *
 * @param lastState 主程序持有的全局可变状态
 */
function runGlobalMidnightClear(lastState: LastState): void {
  lastState.canTrade = false;
  lastState.isHalfDay = null;
  lastState.openProtectionActive = null;
  lastState.cachedTradingDayInfo = null;
  lastState.tradingCalendarSnapshot = new Map();
  lastState.allTradingSymbols = new Set<string>();

  for (const monitorState of lastState.monitorStates.values()) {
    resetMonitorStateForNewDay(monitorState);
  }
}

/**
 * 创建全局状态缓存域。
 * 午夜清理时重置交易门禁、交易日信息、allTradingSymbols 及各监控标的状态；开盘重建时调用 runOpenRebuild 执行完整流水线。
 *
 * @param deps 依赖注入，包含 lastState、runOpenRebuild
 * @returns 实现 CacheDomain 的全局状态域实例
 */
export function createGlobalStateDomain(deps: GlobalStateDomainDeps): CacheDomain {
  const { lastState, runOpenRebuild } = deps;
  return {
    midnightClear(): void {
      runGlobalMidnightClear(lastState);
      logger.info('[Lifecycle][globalState] 午夜状态清理完成');
    },
    async openRebuild(ctx): Promise<void> {
      await runOpenRebuild(ctx.now);
      logger.info('[Lifecycle][globalState] 开盘重建流程执行完成');
    },
  };
}
