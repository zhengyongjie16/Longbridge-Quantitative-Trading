/**
 * 自动寻标任务处理器
 *
 * 核心职责：
 * - 处理 AUTO_SYMBOL_TICK 寻标 tick 任务
 * - 处理 AUTO_SYMBOL_SWITCH_DISTANCE 距回收价触发的换标检查任务
 * - 执行前校验席位快照，防止旧任务在换标后被错误执行
 */
import type { LastState } from '../../../../types/state.js';
import type { RefreshGate } from '../../../../utils/types.js';
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

/**
 * 创建自动寻标任务处理器（AUTO_SYMBOL_TICK、AUTO_SYMBOL_SWITCH_DISTANCE）。
 * 执行前校验席位快照，防止换标后执行旧任务；tick 触发寻标，距离检查触发换标决策。
 *
 * @param deps 依赖注入，包含 getContextOrSkip、refreshGate、lastState、getCanProcessTask
 * @returns handleAutoSymbolTick 与 handleAutoSymbolSwitchDistance 两个处理函数
 */
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
    await context.autoSymbolManager.maybeSwitchOnInterval({
      direction: data.direction,
      currentTime: new Date(data.currentTimeMs),
      canTradeNow: data.canTradeNow,
      openProtectionActive: data.openProtectionActive,
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
