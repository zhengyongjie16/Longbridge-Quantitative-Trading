/**
 * 自动寻标任务处理器
 *
 * 核心职责：
 * - 处理 AUTO_SYMBOL_TICK 寻标 tick 任务
 * - 处理 AUTO_SYMBOL_SWITCH_DISTANCE 距回收价触发的换标检查任务
 * - 执行前校验席位快照，防止旧任务在换标后被错误执行
 */
import { logger } from '../../../../utils/logger/index.js';
import type { PostTradeConsistencyFreshnessPort } from '../../../../types/services.js';
import type { LastState } from '../../../../types/state.js';
import type { MonitorTask } from '../../monitorTaskQueue/types.js';
import type {
  AutoSymbolSwitchDistanceTaskData,
  AutoSymbolTickTaskData,
  MonitorTaskContext,
  MonitorTaskDataMap,
  MonitorTaskStatus,
} from '../types.js';
import {
  isSeatSnapshotValid,
  resolveSeatSnapshotReadiness,
  validateSeatSnapshotsAfterRefresh,
} from '../helpers/seatSnapshot.js';
import { hasSeatSymbol } from '../../../../utils/seat/guards.js';

/**
 * 创建自动寻标任务处理器（AUTO_SYMBOL_TICK、AUTO_SYMBOL_SWITCH_DISTANCE）。
 * 执行前校验席位快照，防止换标后执行旧任务；tick 触发寻标，距离检查触发换标决策。
 *
 * @param deps 依赖注入，包含 getContextOrSkip、postTradeConsistencyRuntime、lastState、getCanProcessTask
 * @returns handleAutoSymbolTick 与 handleAutoSymbolSwitchDistance 两个处理函数
 */
export function createAutoSymbolHandlers({
  getContextOrSkip,
  postTradeConsistencyRuntime,
  lastState,
  getCanProcessTask,
}: {
  readonly getContextOrSkip: (monitorSymbol: string) => MonitorTaskContext | null;
  readonly postTradeConsistencyRuntime: PostTradeConsistencyFreshnessPort;
  readonly lastState: LastState;
  readonly getCanProcessTask?: () => boolean;
}): Readonly<{
  handleAutoSymbolTick: (
    task: MonitorTask<MonitorTaskDataMap, 'AUTO_SYMBOL_TICK'>,
  ) => Promise<MonitorTaskStatus>;
  handleAutoSymbolSwitchDistance: (
    task: MonitorTask<MonitorTaskDataMap, 'AUTO_SYMBOL_SWITCH_DISTANCE'>,
  ) => Promise<MonitorTaskStatus>;
}> {
  async function handleAutoSymbolTick(
    task: MonitorTask<MonitorTaskDataMap, 'AUTO_SYMBOL_TICK'>,
  ): Promise<MonitorTaskStatus> {
    const data: AutoSymbolTickTaskData = task.data;
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
      logger.debug(
        `[MonitorTaskProcessor] AUTO_SYMBOL_TICK 快照失效，跳过 type=${task.type} monitor=${task.monitorSymbol} direction=${data.direction} dedupe=${task.dedupeKey}`,
      );
      return 'skipped';
    }

    if (getCanProcessTask && !getCanProcessTask()) {
      logger.debug(
        `[MonitorTaskProcessor] AUTO_SYMBOL_TICK 门禁关闭，跳过 type=${task.type} monitor=${task.monitorSymbol} direction=${data.direction} dedupe=${task.dedupeKey}`,
      );
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
    task: MonitorTask<MonitorTaskDataMap, 'AUTO_SYMBOL_SWITCH_DISTANCE'>,
  ): Promise<MonitorTaskStatus> {
    const data: AutoSymbolSwitchDistanceTaskData = task.data;
    const context = getContextOrSkip(data.monitorSymbol);
    if (!context) {
      return 'skipped';
    }

    const snapshotValidity = await validateSeatSnapshotsAfterRefresh({
      monitorSymbol: data.monitorSymbol,
      context,
      longSnapshot: data.seatSnapshots.long,
      shortSnapshot: data.seatSnapshots.short,
      postTradeConsistencyRuntime,
    });
    if (!snapshotValidity) {
      logger.debug(
        `[MonitorTaskProcessor] AUTO_SYMBOL_SWITCH_DISTANCE 快照失效，跳过 type=${task.type} monitor=${task.monitorSymbol} dedupe=${task.dedupeKey}`,
      );
      return 'skipped';
    }

    if (getCanProcessTask && !getCanProcessTask()) {
      logger.debug(
        `[MonitorTaskProcessor] AUTO_SYMBOL_SWITCH_DISTANCE 门禁关闭，跳过 type=${task.type} monitor=${task.monitorSymbol} dedupe=${task.dedupeKey}`,
      );
      return 'skipped';
    }

    const seatReadiness = resolveSeatSnapshotReadiness({
      monitorSymbol: data.monitorSymbol,
      context,
      snapshotValidity,
      isSeatUsable: hasSeatSymbol,
    });

    if (seatReadiness.isLongReady) {
      if (getCanProcessTask && !getCanProcessTask()) {
        logger.debug(
          `[MonitorTaskProcessor] AUTO_SYMBOL_SWITCH_DISTANCE LONG 门禁关闭，跳过 type=${task.type} monitor=${task.monitorSymbol} dedupe=${task.dedupeKey}`,
        );
        return 'skipped';
      }

      await context.autoSymbolManager.maybeSwitchOnDistance({
        direction: 'LONG',
        monitorPrice: data.monitorPrice,
        positions: lastState.cachedPositions,
      });
    }

    if (seatReadiness.isShortReady) {
      if (getCanProcessTask && !getCanProcessTask()) {
        logger.debug(
          `[MonitorTaskProcessor] AUTO_SYMBOL_SWITCH_DISTANCE SHORT 门禁关闭，跳过 type=${task.type} monitor=${task.monitorSymbol} dedupe=${task.dedupeKey}`,
        );
        return 'skipped';
      }

      await context.autoSymbolManager.maybeSwitchOnDistance({
        direction: 'SHORT',
        monitorPrice: data.monitorPrice,
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
