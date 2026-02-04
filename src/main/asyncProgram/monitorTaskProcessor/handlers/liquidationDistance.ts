/**
 * 模块名称：距回收价清仓任务处理
 *
 * 功能：
 * - 检查牛熊证距回收价清仓条件
 * - 执行清仓信号与风险数据刷新
 *
 * 说明：
 * - 保持对象池释放与异常处理顺序
 */
import { logger } from '../../../../utils/logger/index.js';
import { formatError } from '../../../../utils/helpers/index.js';
import { positionObjectPool, signalObjectPool } from '../../../../utils/objectPool/index.js';
import { isSeatReady } from '../../../../services/autoSymbolManager/utils.js';
import { WARRANT_LIQUIDATION_ORDER_TYPE } from '../../../../constants/index.js';
import { getPositions } from '../../../processMonitor/utils.js';

import type { LastState, Position, Quote, Signal, Trader } from '../../../../types/index.js';
import type { RefreshGate } from '../../../../utils/refreshGate/types.js';
import type { MonitorTask } from '../../monitorTaskQueue/types.js';
import type {
  LiquidationDistanceCheckTaskData,
  MonitorTaskContext,
  MonitorTaskData,
  MonitorTaskStatus,
  MonitorTaskType,
} from '../types.js';
import {
  resolveSeatSnapshotReadiness,
  validateSeatSnapshotsAfterRefresh,
} from '../helpers/seatSnapshot.js';

export function createLiquidationDistanceHandler({
  getContextOrSkip,
  refreshGate,
  lastState,
  trader,
}: {
  readonly getContextOrSkip: (monitorSymbol: string) => MonitorTaskContext | null;
  readonly refreshGate: RefreshGate;
  readonly lastState: LastState;
  readonly trader: Trader;
}): (
  task: MonitorTask<MonitorTaskType, MonitorTaskData>,
) => Promise<MonitorTaskStatus> {
  return async function handleLiquidationDistanceCheck(
    task: MonitorTask<MonitorTaskType, MonitorTaskData>,
  ): Promise<MonitorTaskStatus> {
    const data = task.data as LiquidationDistanceCheckTaskData;
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
    const { riskChecker } = context;

    const { longPosition, shortPosition } = getPositions(
      lastState.positionCache,
      longSymbol,
      shortSymbol,
    );

    try {
      const liquidationTasks: Array<{
        signal: Signal;
        isLongSymbol: boolean;
        quote: Quote | null;
      }> = [];

      function tryCreateLiquidationSignal(
        symbol: string,
        symbolName: string | null,
        isLongSymbol: boolean,
        position: Position | null,
        quote: Quote | null,
        seatVersion: number,
      ): {
        signal: Signal;
        isLongSymbol: boolean;
        quote: Quote | null;
      } | null {
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
          data.monitorPrice,
        );
        if (!liquidationResult.shouldLiquidate) {
          return null;
        }

        const signal = signalObjectPool.acquire() as Signal;
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

      if (isLongReady) {
        const longTask = tryCreateLiquidationSignal(
          longSymbol,
          data.long.symbolName ?? context.longSymbolName ?? null,
          true,
          longPosition,
          data.long.quote,
          data.long.seatVersion,
        );
        if (longTask) {
          liquidationTasks.push(longTask);
        }
      }

      if (isShortReady) {
        const shortTask = tryCreateLiquidationSignal(
          shortSymbol,
          data.short.symbolName ?? context.shortSymbolName ?? null,
          false,
          shortPosition,
          data.short.quote,
          data.short.seatVersion,
        );
        if (shortTask) {
          liquidationTasks.push(shortTask);
        }
      }

      if (liquidationTasks.length > 0) {
        try {
          await trader.executeSignals(liquidationTasks.map(({ signal }) => signal));
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
          for (const taskItem of liquidationTasks) {
            signalObjectPool.release(taskItem.signal);
          }
        }
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
