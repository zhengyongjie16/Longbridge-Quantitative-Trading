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
 * - allTradingSymbols 清理的权威位置（与 marketDataDomain 去重）。
 * - currentDayKey 仅由 dayLifecycleManager 在全部 clear 成功后提交，此处不写入。
 */
function runGlobalMidnightClear(lastState: LastState): void {
  lastState.canTrade = false;
  lastState.isHalfDay = null;
  lastState.openProtectionActive = null;
  lastState.cachedTradingDayInfo = null;
  lastState.allTradingSymbols = new Set<string>();

  for (const monitorState of lastState.monitorStates.values()) {
    resetMonitorStateForNewDay(monitorState);
  }
}

export function createGlobalStateDomain(deps: GlobalStateDomainDeps): CacheDomain {
  const { lastState, runOpenRebuild } = deps;
  return {
    name: 'globalState',
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
