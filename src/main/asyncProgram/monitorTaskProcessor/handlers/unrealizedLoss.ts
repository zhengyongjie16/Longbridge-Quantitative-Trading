/**
 * 模块名称：浮亏清仓检查任务处理
 *
 * 功能：
 * - 校验席位快照并触发浮亏监控
 * - 根据监控结果执行保护性清仓
 *
 * 说明：
 * - 无有效席位时跳过处理
 */
import { isSeatReady } from '../../../../services/autoSymbolManager/utils.js';

import type { Trader } from '../../../../types/index.js';
import type { RefreshGate } from '../../../../utils/refreshGate/types.js';
import type { MonitorTask } from '../../monitorTaskQueue/types.js';
import type {
  MonitorTaskContext,
  MonitorTaskData,
  MonitorTaskStatus,
  MonitorTaskType,
  UnrealizedLossCheckTaskData,
} from '../types.js';
import {
  resolveSeatSnapshotReadiness,
  validateSeatSnapshotsAfterRefresh,
} from '../helpers/seatSnapshot.js';

export function createUnrealizedLossHandler({
  getContextOrSkip,
  refreshGate,
  trader,
}: {
  readonly getContextOrSkip: (monitorSymbol: string) => MonitorTaskContext | null;
  readonly refreshGate: RefreshGate;
  readonly trader: Trader;
}): (
  task: MonitorTask<MonitorTaskType, MonitorTaskData>,
) => Promise<MonitorTaskStatus> {
  return async function handleUnrealizedLossCheck(
    task: MonitorTask<MonitorTaskType, MonitorTaskData>,
  ): Promise<MonitorTaskStatus> {
    const data = task.data as UnrealizedLossCheckTaskData;
    const context = getContextOrSkip(data.monitorSymbol);
    if (!context) {
      return 'skipped';
    }

    const snapshotValidity = await validateSeatSnapshotsAfterRefresh({
      monitorSymbol: data.monitorSymbol,
      context,
      longSnapshot: { seatVersion: data.long.seatVersion, symbol: data.long.symbol },
      shortSnapshot: { seatVersion: data.short.seatVersion, symbol: data.short.symbol },
      refreshGate,
    });
    if (!snapshotValidity) {
      return 'skipped';
    }

    const seatReadiness = resolveSeatSnapshotReadiness({
      monitorSymbol: data.monitorSymbol,
      context,
      snapshotValidity,
      isSeatUsable: isSeatReady,
    });

    const { isLongReady, isShortReady, longSymbol, shortSymbol } = seatReadiness;
    const longQuote = isLongReady ? data.long.quote : null;
    const shortQuote = isShortReady ? data.short.quote : null;

    if (!longSymbol && !shortSymbol) {
      return 'skipped';
    }

    await context.unrealizedLossMonitor.monitorUnrealizedLoss({
      longQuote,
      shortQuote,
      longSymbol,
      shortSymbol,
      monitorSymbol: data.monitorSymbol,
      riskChecker: context.riskChecker,
      trader,
      orderRecorder: context.orderRecorder,
      dailyLossTracker: context.dailyLossTracker,
    });

    return 'processed';
  };
}
