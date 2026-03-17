/**
 * 距回收价清仓任务处理
 *
 * 功能：
 * - 检查牛熊证距回收价清仓条件
 * - 执行清仓信号与风险数据刷新
 * - 保持对象池释放与异常处理顺序
 */
import { WARRANT_LIQUIDATION_ORDER_TYPE } from '../../../../constants/index.js';
import type { LastState } from '../../../../types/state.js';
import type { Trader } from '../../../../types/services.js';
import { formatError } from '../../../../utils/error/index.js';
import { logger } from '../../../../utils/logger/index.js';
import { acquireSignal, positionObjectPool, signalObjectPool } from '../../../../utils/objectPool/index.js';
import type { RefreshGate } from '../../../../utils/types.js';
import { getPositions } from '../../../processMonitor/utils.js';
import type { MonitorTask } from '../../monitorTaskQueue/types.js';
import { evaluateMonitorContextAndSeatReadiness } from '../utils.js';
import type {
  CreateLiquidationTaskParams,
  LiquidationDistanceCheckTaskData,
  LiquidationTask,
  MonitorTaskContext,
  MonitorTaskDataMap,
  MonitorTaskStatus,
} from '../types.js';

/**
 * 在席位版本、持仓与行情均有效时构造保护性清仓信号，否则返回 null。
 * 先做前置校验可避免将无效任务推入后续执行链路，降低误清仓风险。
 *
 * @param params 清仓信号构造参数
 * @returns 成功时返回清仓执行项，否则返回 null
 */
function createLiquidationTask(params: CreateLiquidationTaskParams): LiquidationTask | null {
  const {
    symbol,
    symbolName,
    isLongSymbol,
    position,
    quote,
    seatVersion,
    monitorPrice,
    riskChecker,
  } = params;

  if (!symbol) {
    return null;
  }

  const availableQuantity = position?.availableQuantity ?? 0;
  if (!Number.isFinite(availableQuantity) || availableQuantity <= 0) {
    return null;
  }

  const liquidationResult = riskChecker.checkWarrantDistanceLiquidation(
    symbol,
    isLongSymbol,
    monitorPrice,
  );
  if (!liquidationResult.shouldLiquidate) {
    return null;
  }

  const signal = acquireSignal();
  signal.symbol = symbol;
  signal.symbolName = symbolName;
  signal.action = isLongSymbol ? 'SELLCALL' : 'SELLPUT';
  signal.reason = liquidationResult.reason ?? '牛熊证距回收价触发清仓';
  signal.price = quote?.price ?? null;
  signal.lotSize = quote?.lotSize ?? null;
  signal.quantity = availableQuantity;
  signal.triggerTime = new Date();
  signal.orderTypeOverride = WARRANT_LIQUIDATION_ORDER_TYPE;
  signal.isProtectiveLiquidation = false;
  signal.seatVersion = seatVersion;

  return { signal, isLongSymbol, quote };
}

/**
 * 释放清仓任务中占用的信号对象。
 *
 * @param liquidationTasks 待释放的清仓执行项列表
 * @returns 无返回值
 */
function releaseLiquidationTasks(liquidationTasks: ReadonlyArray<LiquidationTask>): void {
  for (const taskItem of liquidationTasks) {
    signalObjectPool.release(taskItem.signal);
  }
}

/**
 * 创建距回收价清仓任务处理器。
 * 校验席位快照后检查牛熊证距回收价，满足条件则生成清仓信号并执行，刷新订单记录与浮亏数据；保证风控检查在席位与行情就绪后执行。
 *
 * @param deps 依赖注入，包含 getContextOrSkip、refreshGate、lastState、trader、getCanProcessTask
 * @returns 处理 LIQUIDATION_DISTANCE_CHECK 任务的异步函数
 */
export function createLiquidationDistanceHandler({
  getContextOrSkip,
  refreshGate,
  lastState,
  trader,
  getCanProcessTask,
}: {
  readonly getContextOrSkip: (monitorSymbol: string) => MonitorTaskContext | null;
  readonly refreshGate: RefreshGate;
  readonly lastState: LastState;
  readonly trader: Trader;
  readonly getCanProcessTask?: () => boolean;
}): (
  task: MonitorTask<MonitorTaskDataMap, 'LIQUIDATION_DISTANCE_CHECK'>,
) => Promise<MonitorTaskStatus> {
  return async function handleLiquidationDistanceCheck(
    task: MonitorTask<MonitorTaskDataMap, 'LIQUIDATION_DISTANCE_CHECK'>,
  ): Promise<MonitorTaskStatus> {
    const data: LiquidationDistanceCheckTaskData = task.data;
    const evaluated = await evaluateMonitorContextAndSeatReadiness({
      getContextOrSkip,
      refreshGate,
      monitorSymbol: data.monitorSymbol,
      longSnapshot: { seatVersion: data.long.seatVersion, symbol: data.long.symbol },
      shortSnapshot: { seatVersion: data.short.seatVersion, symbol: data.short.symbol },
    });
    if (!evaluated) {
      return 'skipped';
    }

    const { context, seatReadiness } = evaluated;
    const { isLongReady, isShortReady, longSymbol, shortSymbol } = seatReadiness;
    const { longPosition, shortPosition } = getPositions(
      lastState.positionCache,
      longSymbol,
      shortSymbol,
    );

    try {
      const liquidationTasks: LiquidationTask[] = [];

      if (isLongReady) {
        const longTask = createLiquidationTask({
          symbol: longSymbol,
          symbolName: data.long.symbolName,
          isLongSymbol: true,
          position: longPosition,
          quote: data.long.quote,
          seatVersion: data.long.seatVersion,
          monitorPrice: data.monitorPrice,
          riskChecker: context.riskChecker,
        });
        if (longTask) {
          liquidationTasks.push(longTask);
        }
      }

      if (isShortReady) {
        const shortTask = createLiquidationTask({
          symbol: shortSymbol,
          symbolName: data.short.symbolName,
          isLongSymbol: false,
          position: shortPosition,
          quote: data.short.quote,
          seatVersion: data.short.seatVersion,
          monitorPrice: data.monitorPrice,
          riskChecker: context.riskChecker,
        });
        if (shortTask) {
          liquidationTasks.push(shortTask);
        }
      }

      if (liquidationTasks.length === 0) {
        return 'processed';
      }

      if (getCanProcessTask && !getCanProcessTask()) {
        releaseLiquidationTasks(liquidationTasks);
        return 'skipped';
      }

      try {
        const signalsToExecute = liquidationTasks.map((taskItem) => taskItem.signal);

        const executionResult = await trader.executeSignals(signalsToExecute);
        if (executionResult.submittedCount !== liquidationTasks.length) {
          logger.warn(
            `[牛熊证距回收价清仓] 信号仅提交 ${executionResult.submittedCount}/${liquidationTasks.length}，保留缓存与订单记录等待后续刷新`,
          );
          return 'processed';
        }

        for (const taskItem of liquidationTasks) {
          context.orderRecorder.clearBuyOrders(
            taskItem.signal.symbol,
            taskItem.isLongSymbol,
            taskItem.quote,
          );
          const dailyLossOffset = context.dailyLossTracker.getLossOffset(
            data.monitorSymbol,
            taskItem.isLongSymbol,
          );
          await context.riskChecker.refreshUnrealizedLossData(
            context.orderRecorder,
            taskItem.signal.symbol,
            taskItem.isLongSymbol,
            taskItem.quote,
            dailyLossOffset,
          );
        }
      } catch (err) {
        logger.error(`[牛熊证距回收价清仓失败] ${formatError(err)}`);
      } finally {
        releaseLiquidationTasks(liquidationTasks);
      }
    } finally {
      if (longPosition) {
        positionObjectPool.release(longPosition);
      }

      if (shortPosition) {
        positionObjectPool.release(shortPosition);
      }
    }

    return 'processed';
  };
}
