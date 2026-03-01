/**
 * 距回收价清仓任务处理
 *
 * 功能：
 * - 检查牛熊证距回收价清仓条件
 * - 执行清仓信号与风险数据刷新
 * - 保持对象池释放与异常处理顺序
 */
import { logger } from '../../../../utils/logger/index.js';
import { positionObjectPool, signalObjectPool } from '../../../../utils/objectPool/index.js';
import { isSeatReady } from '../../../../services/autoSymbolManager/utils.js';
import { WARRANT_LIQUIDATION_ORDER_TYPE } from '../../../../constants/index.js';
import { getPositions } from '../../../processMonitor/utils.js';
import type { LastState } from '../../../../types/state.js';
import type { Position } from '../../../../types/account.js';
import type { Quote } from '../../../../types/quote.js';
import type { Signal } from '../../../../types/signal.js';
import type { Trader } from '../../../../types/services.js';
import type { RefreshGate } from '../../../../utils/types.js';
import type { MonitorTask } from '../../monitorTaskQueue/types.js';
import type {
  LiquidationDistanceCheckTaskData,
  MonitorTaskContext,
  MonitorTaskData,
  MonitorTaskStatus,
  MonitorTaskType,
} from '../types.js';
import { formatError } from '../../../../utils/error/index.js';
import {
  resolveSeatSnapshotReadiness,
  validateSeatSnapshotsAfterRefresh,
} from '../helpers/seatSnapshot.js';

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
}): (task: MonitorTask<MonitorTaskType, MonitorTaskData>) => Promise<MonitorTaskStatus> {
  return async function handleLiquidationDistanceCheck(
    task: MonitorTask<MonitorTaskType, MonitorTaskData>,
  ): Promise<MonitorTaskStatus> {
    // handler 由 LIQUIDATION_DISTANCE_CHECK 类型分派，data 语义上必为 LiquidationDistanceCheckTaskData
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
      const liquidationTasks: {
        signal: Signal;
        isLongSymbol: boolean;
        quote: Quote | null;
      }[] = [];

      /**
       * 在席位版本、持仓与行情均有效时构造保护性清仓信号，否则返回 null。
       * 先做前置校验可避免将无效任务推入后续执行链路，降低误清仓风险。
       *
       * @param symbol 交易标的代码
       * @param symbolName 标的名称，可为空
       * @param isLongSymbol 是否为做多方向标的
       * @param position 当前持仓快照
       * @param quote 当前行情快照
       * @param seatVersion 席位版本号，用于并发一致性校验
       * @returns 成功时返回清仓信号与数量，否则返回 null
       */
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

        // 对象池返回 PoolableSignal，这里通过字段赋值构造出完整的 Signal 对象
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
          data.long.symbolName,
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
          data.short.symbolName,
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
        if (getCanProcessTask && !getCanProcessTask()) {
          for (const taskItem of liquidationTasks) {
            signalObjectPool.release(taskItem.signal);
          }
          return 'skipped';
        }
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
