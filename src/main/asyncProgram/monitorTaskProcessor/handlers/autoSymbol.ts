/**
 * 模块名称：自动寻标任务处理
 *
 * 功能：
 * - 处理寻标 tick 任务
 * - 处理距回收价触发的换标检查任务
 *
 * 说明：
 * - 执行前校验席位快照，避免旧任务
 */
import type { LastState } from '../../../../types/state.js';
import type { RefreshGate } from '../../../../utils/refreshGate/types.js';
import type { MonitorTask } from '../../monitorTaskQueue/types.js';
import type {
  AutoSymbolSwitchDistanceTaskData,
  AutoSymbolTickTaskData,
  MonitorTaskContext,
  MonitorTaskData,
  MonitorTaskStatus,
  MonitorTaskType,
} from '../types.js';
import {
  isSeatSnapshotValid,
  isSeatSymbolActive,
  resolveSeatSnapshotReadiness,
  validateSeatSnapshotsAfterRefresh,
} from '../helpers/seatSnapshot.js';

export function createAutoSymbolHandlers({
  getContextOrSkip,
  refreshGate,
  lastState,
  getCanProcessTask,
}: {
  readonly getContextOrSkip: (monitorSymbol: string) => MonitorTaskContext | null;
  readonly refreshGate: RefreshGate;
  readonly lastState: LastState;
  readonly getCanProcessTask?: () => boolean;
}): Readonly<{
  handleAutoSymbolTick: (
    task: MonitorTask<MonitorTaskType, MonitorTaskData>,
  ) => Promise<MonitorTaskStatus>;
  handleAutoSymbolSwitchDistance: (
    task: MonitorTask<MonitorTaskType, MonitorTaskData>,
  ) => Promise<MonitorTaskStatus>;
}> {
  async function handleAutoSymbolTick(
    task: MonitorTask<MonitorTaskType, MonitorTaskData>,
  ): Promise<MonitorTaskStatus> {
    // 由队列按 type 分派，此处断言为 AutoSymbolTickTaskData
    const data = task.data as AutoSymbolTickTaskData;
    const context = getContextOrSkip(data.monitorSymbol);
    if (!context) {
      return 'skipped';
    }

    const isSnapshotValid = isSeatSnapshotValid(
      data.monitorSymbol,
      data.direction,
      { seatVersion: data.seatVersion, symbol: data.symbol },
      context,
    );
    if (!isSnapshotValid) {
      return 'skipped';
    }

    if (getCanProcessTask && !getCanProcessTask()) {
      return 'skipped';
    }

    await context.autoSymbolManager.maybeSearchOnTick({
      direction: data.direction,
      currentTime: new Date(data.currentTimeMs),
      canTradeNow: data.canTradeNow,
    });

    return 'processed';
  }

  async function handleAutoSymbolSwitchDistance(
    task: MonitorTask<MonitorTaskType, MonitorTaskData>,
  ): Promise<MonitorTaskStatus> {
    // 由队列按 type 分派，此处断言为 AutoSymbolSwitchDistanceTaskData
    const data = task.data as AutoSymbolSwitchDistanceTaskData;
    const context = getContextOrSkip(data.monitorSymbol);
    if (!context) {
      return 'skipped';
    }

    const snapshotValidity = await validateSeatSnapshotsAfterRefresh({
      monitorSymbol: data.monitorSymbol,
      context,
      longSnapshot: data.seatSnapshots.long,
      shortSnapshot: data.seatSnapshots.short,
      refreshGate,
    });
    if (!snapshotValidity) {
      return 'skipped';
    }

    if (getCanProcessTask && !getCanProcessTask()) {
      return 'skipped';
    }

    const seatReadiness = resolveSeatSnapshotReadiness({
      monitorSymbol: data.monitorSymbol,
      context,
      snapshotValidity,
      isSeatUsable: isSeatSymbolActive,
    });

    if (seatReadiness.isLongReady) {
      if (getCanProcessTask && !getCanProcessTask()) {
        return 'skipped';
      }
      await context.autoSymbolManager.maybeSwitchOnDistance({
        direction: 'LONG',
        monitorPrice: data.monitorPrice,
        quotesMap: data.quotesMap,
        positions: lastState.cachedPositions,
      });
    }
    if (seatReadiness.isShortReady) {
      if (getCanProcessTask && !getCanProcessTask()) {
        return 'skipped';
      }
      await context.autoSymbolManager.maybeSwitchOnDistance({
        direction: 'SHORT',
        monitorPrice: data.monitorPrice,
        quotesMap: data.quotesMap,
        positions: lastState.cachedPositions,
      });
    }

    return 'processed';
  }

  return {
    handleAutoSymbolTick,
    handleAutoSymbolSwitchDistance,
  };
}
