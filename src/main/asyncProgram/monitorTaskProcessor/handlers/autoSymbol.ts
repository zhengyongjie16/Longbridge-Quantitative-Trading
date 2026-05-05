/**
 * 自动寻标任务处理器
 *
 * 核心职责：
 * - 处理 AUTO_SYMBOL_TICK 周期换标 tick 任务
 * - 执行前校验席位快照，防止旧任务在换标后被错误执行
 */
import { logger } from '../../../../utils/logger/index.js';
import type {
  AdvancePendingSwitchResult,
  StartSwitchOnDistanceResult,
  SwitchDriveResult,
} from '../../../../types/monitorContextPorts.js';
import type {
  PeriodicSwitchRouteBaseline,
  PeriodicSwitchWakeupRuntime,
} from '../../../periodicSwitchWakeupRuntime/types.js';
import type { SwitchWakeupRuntime } from '../../../monitorQuoteEventRuntime/types.js';
import type { MonitorTask } from '../../monitorTaskQueue/types.js';
import type {
  AutoSymbolTickTaskData,
  MonitorTaskContext,
  MonitorTaskDataMap,
  MonitorTaskStatus,
} from '../types.js';
import { isSeatSnapshotValid } from '../helpers/seatSnapshot.js';

function buildPeriodicBaseline(data: AutoSymbolTickTaskData): PeriodicSwitchRouteBaseline {
  return {
    monitorSymbol: data.monitorSymbol,
    direction: data.direction,
    symbol: data.symbol,
    seatVersion: data.seatVersion,
    lastSeatActivatedAt: data.lastSeatActivatedAt,
  };
}

function handoffPeriodicWakeup(params: {
  readonly context: MonitorTaskContext;
  readonly data: AutoSymbolTickTaskData;
  readonly periodicSwitchWakeupRuntime: Pick<
    PeriodicSwitchWakeupRuntime,
    'markWaitingEmpty' | 'clearWaitingEmpty' | 'replanRouteAfterTask'
  >;
}): void {
  const baseline = buildPeriodicBaseline(params.data);
  const pendingState = params.context.autoSymbolManager.getPeriodicSwitchPendingState(
    params.data.direction,
  );
  if (pendingState.pending) {
    params.periodicSwitchWakeupRuntime.markWaitingEmpty(baseline);
    return;
  }

  params.periodicSwitchWakeupRuntime.clearWaitingEmpty(baseline);
  params.periodicSwitchWakeupRuntime.replanRouteAfterTask({
    ...baseline,
    taskTimeMs: params.data.currentTimeMs,
    status: 'processed',
  });
}

/**
 * 创建周期换标任务处理器（AUTO_SYMBOL_TICK）。
 * 执行前校验席位快照，防止换标后执行旧任务；tick 仅触发周期换标检查。
 *
 * @param deps 依赖注入，包含 getContextOrSkip、switchWakeupRuntime、getCanTradeNow
 * @returns AUTO_SYMBOL_TICK 处理函数
 */
export function createAutoSymbolHandlers({
  getContextOrSkip,
  switchWakeupRuntime,
  periodicSwitchWakeupRuntime,
  getCanTradeNow,
}: {
  readonly getContextOrSkip: (monitorSymbol: string) => MonitorTaskContext | null;
  readonly switchWakeupRuntime: Pick<SwitchWakeupRuntime, 'handoffPendingSwitch'>;
  readonly periodicSwitchWakeupRuntime: Pick<
    PeriodicSwitchWakeupRuntime,
    'markWaitingEmpty' | 'clearWaitingEmpty' | 'replanRouteAfterTask'
  >;
  readonly getCanTradeNow: () => boolean;
}): Readonly<{
  handleAutoSymbolTick: (
    task: MonitorTask<MonitorTaskDataMap, 'AUTO_SYMBOL_TICK'>,
  ) => Promise<MonitorTaskStatus>;
}> {
  function handoffPendingWakeup(params: {
    readonly context: MonitorTaskContext;
    readonly monitorSymbol: string;
    readonly direction: 'LONG' | 'SHORT';
    readonly result: SwitchDriveResult | StartSwitchOnDistanceResult | AdvancePendingSwitchResult;
  }): void {
    const { result } = params;

    if ('kind' in result) {
      if (result.kind !== 'WAIT') {
        return;
      }

      switchWakeupRuntime.handoffPendingSwitch({
        monitorSymbol: params.monitorSymbol,
        direction: params.direction,
        monitorContext: params.context,
        driveResult: result,
      });
      return;
    }

    if ('started' in result) {
      if (!result.started || result.driveResult.kind !== 'WAIT') {
        return;
      }

      switchWakeupRuntime.handoffPendingSwitch({
        monitorSymbol: params.monitorSymbol,
        direction: params.direction,
        monitorContext: params.context,
        driveResult: result.driveResult,
      });
      return;
    }

    if (!result.advanced) {
      return;
    }

    if (!result.stillPending || result.driveResult.kind !== 'WAIT') {
      return;
    }

    switchWakeupRuntime.handoffPendingSwitch({
      monitorSymbol: params.monitorSymbol,
      direction: params.direction,
      monitorContext: params.context,
      driveResult: result.driveResult,
    });
  }

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
      {
        seatVersion: data.seatVersion,
        symbol: data.symbol,
        lastSeatActivatedAt: data.lastSeatActivatedAt,
      },
      context,
    );
    if (!isSnapshotValid) {
      logger.debug(
        `[MonitorTaskProcessor] AUTO_SYMBOL_TICK 快照失效，跳过 type=${task.type} monitor=${task.monitorSymbol} direction=${data.direction} dedupe=${task.dedupeKey}`,
      );
      return 'skipped';
    }

    const canTradeNow = getCanTradeNow();
    if (!canTradeNow) {
      return 'blocked';
    }

    const intervalResult = await context.autoSymbolManager.maybeSwitchOnInterval({
      direction: data.direction,
      currentTime: new Date(data.currentTimeMs),
      canTradeNow,
    });
    handoffPendingWakeup({
      context,
      monitorSymbol: data.monitorSymbol,
      direction: data.direction,
      result: intervalResult,
    });

    handoffPeriodicWakeup({
      context,
      data,
      periodicSwitchWakeupRuntime,
    });

    return 'processed';
  }

  return {
    handleAutoSymbolTick,
  };
}
