/**
 * 距回收价清仓任务处理
 *
 * 功能：
 * - 检查牛熊证距回收价清仓条件
 * - 执行清仓信号与风险数据刷新
 * - 保持对象池释放与异常处理顺序
 */
import { ORDER_QUOTE_RETRY, WARRANT_LIQUIDATION_ORDER_TYPE } from '../../../../constants/index.js';
import type { LastState } from '../../../../types/state.js';
import type {
  Trader,
  MarketDataClient,
  PostTradeConsistencyFreshnessPort,
} from '../../../../types/services.js';
import {
  isQuoteReadyForRequirement,
  resolveNextQuoteRetry,
} from '../../../../utils/quoteRetry/index.js';
import { formatError } from '../../../../utils/error/index.js';
import { logger } from '../../../../utils/logger/index.js';
import { validateSignalSeat } from '../../../../services/autoSymbolManager/utils.js';
import {
  acquireSignal,
  positionObjectPool,
  signalObjectPool,
} from '../../../../utils/objectPool/index.js';
import { getPositions } from '../../../processMonitor/utils.js';
import type { MonitorTask } from '../../monitorTaskQueue/types.js';
import { evaluateMonitorContextAndSeatReadiness } from '../utils.js';
import type {
  CreateLiquidationTaskParams,
  LiquidationDistanceCheckTaskData,
  LiquidationTask,
  MonitorTaskContext,
  MonitorTaskDataMap,
  MonitorTaskRetryRequest,
  MonitorTaskStatus,
} from '../types.js';

/**
 * 在席位版本、持仓与行情均有效时构造距回收价清仓信号，否则返回 null。
 * 先做前置校验可避免将无效任务推入后续执行链路，降低误清仓风险。
 *
 * @param params 清仓信号构造参数
 * @returns 成功时返回清仓执行项，否则返回 null
 */
function createLiquidationTask(params: CreateLiquidationTaskParams): LiquidationTask | null {
  const { symbol, symbolName, direction, position, quote, seatVersion, monitorPrice, riskChecker } =
    params;
  const isLongDirection = direction === 'LONG';

  if (!symbol) {
    return null;
  }

  const availableQuantity = position?.availableQuantity ?? 0;
  if (!Number.isFinite(availableQuantity) || availableQuantity <= 0) {
    return null;
  }

  const liquidationResult = riskChecker.checkWarrantDistanceLiquidation(
    symbol,
    isLongDirection,
    monitorPrice,
  );
  if (!liquidationResult.shouldLiquidate) {
    return null;
  }

  const signal = acquireSignal();
  signal.symbol = symbol;
  signal.symbolName = symbolName;
  signal.action = isLongDirection ? 'SELLCALL' : 'SELLPUT';
  signal.reason = liquidationResult.reason ?? '牛熊证距回收价触发清仓';
  signal.price = quote?.price ?? null;
  signal.lotSize = quote?.lotSize ?? null;
  signal.quantity = availableQuantity;
  signal.triggerTime = new Date();
  signal.orderTypeOverride = WARRANT_LIQUIDATION_ORDER_TYPE;
  signal.isProtectiveLiquidation = false;
  signal.seatVersion = seatVersion;

  return {
    signal,
    direction,
    quote,
  };
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
 * 执行已就绪的距回收价清仓任务，并在全部提交成功后刷新订单记录与浮亏缓存。
 *
 * @param params 清仓执行依赖与任务列表
 * @returns 无返回值
 */
async function executeReadyLiquidationTasks(params: {
  readonly liquidationTasks: ReadonlyArray<LiquidationTask>;
  readonly data: LiquidationDistanceCheckTaskData;
  readonly context: MonitorTaskContext;
  readonly trader: Trader;
}): Promise<void> {
  const { liquidationTasks, data, context, trader } = params;
  const executableTasks = liquidationTasks.filter((taskItem) => {
    const seatValidation = validateSignalSeat({
      monitorSymbol: data.monitorSymbol,
      signal: taskItem.signal,
      symbolRegistry: context.symbolRegistry,
    });
    return seatValidation.valid;
  });
  if (executableTasks.length === 0) {
    return;
  }

  const signalsToExecute = executableTasks.map((taskItem) => taskItem.signal);
  const executionResult = await trader.executeSignals(signalsToExecute);
  if (executionResult.submittedCount === executableTasks.length) {
    for (const taskItem of executableTasks) {
      const isLongDirection = taskItem.direction === 'LONG';

      context.orderRecorder.clearBuyOrders(taskItem.signal.symbol, isLongDirection, taskItem.quote);
      const dailyLossOffset = context.dailyLossTracker.getLossOffset(
        data.monitorSymbol,
        isLongDirection,
      );
      await context.riskChecker.refreshUnrealizedLossData(
        context.orderRecorder,
        taskItem.signal.symbol,
        isLongDirection,
        taskItem.quote,
        dailyLossOffset,
      );
    }

    return;
  }

  logger.warn(
    `[牛熊证距回收价清仓] 信号仅提交 ${executionResult.submittedCount}/${executableTasks.length}，保留缓存与订单记录等待后续刷新`,
  );
}

/**
 * 创建距回收价清仓任务处理器。
 * 校验席位快照后检查牛熊证距回收价，满足条件则生成非保护性清仓信号并执行，刷新订单记录与浮亏数据；保证风控检查在席位与行情就绪后执行。
 *
 * @param deps 依赖注入，包含 getContextOrSkip、postTradeConsistencyRuntime、lastState、trader、getCanProcessTask
 * @returns 处理 LIQUIDATION_DISTANCE_CHECK 任务的异步函数
 */
export function createLiquidationDistanceHandler({
  getContextOrSkip,
  postTradeConsistencyRuntime,
  lastState,
  trader,
  marketDataClient,
  getCanProcessTask,
}: {
  readonly getContextOrSkip: (monitorSymbol: string) => MonitorTaskContext | null;
  readonly postTradeConsistencyRuntime: PostTradeConsistencyFreshnessPort;
  readonly lastState: LastState;
  readonly trader: Trader;
  readonly marketDataClient: MarketDataClient;
  readonly getCanProcessTask?: () => boolean;
}): (task: MonitorTask<MonitorTaskDataMap, 'LIQUIDATION_DISTANCE_CHECK'>) => Promise<{
  readonly status: MonitorTaskStatus;
  readonly retryRequest: MonitorTaskRetryRequest<'LIQUIDATION_DISTANCE_CHECK'> | null;
}> {
  return async function handleLiquidationDistanceCheck(
    task: MonitorTask<MonitorTaskDataMap, 'LIQUIDATION_DISTANCE_CHECK'>,
  ): Promise<{
    readonly status: MonitorTaskStatus;
    readonly retryRequest: MonitorTaskRetryRequest<'LIQUIDATION_DISTANCE_CHECK'> | null;
  }> {
    const data: LiquidationDistanceCheckTaskData = task.data;
    const evaluated = await evaluateMonitorContextAndSeatReadiness({
      getContextOrSkip,
      postTradeConsistencyRuntime,
      monitorSymbol: data.monitorSymbol,
      longSnapshot: { seatVersion: data.long.seatVersion, symbol: data.long.symbol },
      shortSnapshot: { seatVersion: data.short.seatVersion, symbol: data.short.symbol },
    });
    if (!evaluated) {
      return { status: 'skipped', retryRequest: null };
    }

    const { context, seatReadiness } = evaluated;
    const { isLongReady, isShortReady, longSymbol, shortSymbol } = seatReadiness;
    const retryKey = `${data.monitorSymbol}:LIQUIDATION_DISTANCE_CHECK`;
    const previousRetryAttempts =
      typeof data.retryAttempts === 'number' && Number.isFinite(data.retryAttempts)
        ? data.retryAttempts
        : 0;
    const { longPosition, shortPosition } = getPositions(
      lastState.positionCache,
      longSymbol,
      shortSymbol,
    );
    const quoteSymbolSet = new Set<string>([data.monitorSymbol]);
    if (isLongReady) {
      quoteSymbolSet.add(longSymbol);
    }

    if (isShortReady) {
      quoteSymbolSet.add(shortSymbol);
    }

    const executionQuotes = await marketDataClient.getQuotes(quoteSymbolSet);
    const monitorExecutionQuote = executionQuotes.get(data.monitorSymbol) ?? null;
    const monitorQuoteReady = isQuoteReadyForRequirement({
      quote: monitorExecutionQuote,
      requirement: 'PRICE',
    });
    const executionMonitorPrice =
      monitorQuoteReady && monitorExecutionQuote !== null ? monitorExecutionQuote.price : null;
    const longExecutionQuote = isLongReady ? (executionQuotes.get(longSymbol) ?? null) : null;
    const shortExecutionQuote = isShortReady ? (executionQuotes.get(shortSymbol) ?? null) : null;
    const longQuoteReady =
      isLongReady &&
      isQuoteReadyForRequirement({ quote: longExecutionQuote, requirement: 'PRICE' });
    const shortQuoteReady =
      isShortReady &&
      isQuoteReadyForRequirement({ quote: shortExecutionQuote, requirement: 'PRICE' });

    try {
      const unresolvedSymbols = new Set<string>();
      if (isLongReady && (!monitorQuoteReady || !longQuoteReady) && longSymbol.length > 0) {
        unresolvedSymbols.add(longSymbol);
      }

      if (isShortReady && (!monitorQuoteReady || !shortQuoteReady) && shortSymbol.length > 0) {
        unresolvedSymbols.add(shortSymbol);
      }

      const liquidationTasks: LiquidationTask[] = [];

      if (isLongReady && longQuoteReady && executionMonitorPrice !== null) {
        const longTask = createLiquidationTask({
          symbol: longSymbol,
          symbolName: data.long.symbolName,
          direction: 'LONG',
          position: longPosition,
          quote: longExecutionQuote,
          seatVersion: data.long.seatVersion,
          monitorPrice: executionMonitorPrice,
          riskChecker: context.riskChecker,
        });
        if (longTask) {
          liquidationTasks.push(longTask);
        }
      }

      if (isShortReady && shortQuoteReady && executionMonitorPrice !== null) {
        const shortTask = createLiquidationTask({
          symbol: shortSymbol,
          symbolName: data.short.symbolName,
          direction: 'SHORT',
          position: shortPosition,
          quote: shortExecutionQuote,
          seatVersion: data.short.seatVersion,
          monitorPrice: executionMonitorPrice,
          riskChecker: context.riskChecker,
        });
        if (shortTask) {
          liquidationTasks.push(shortTask);
        }
      }

      if (liquidationTasks.length > 0) {
        if (getCanProcessTask && !getCanProcessTask()) {
          releaseLiquidationTasks(liquidationTasks);
          return { status: 'skipped', retryRequest: null };
        }

        try {
          await executeReadyLiquidationTasks({
            liquidationTasks,
            data,
            context,
            trader,
          });
        } catch (err) {
          throw new Error(`[牛熊证距回收价清仓失败] ${formatError(err)}`, { cause: err });
        } finally {
          releaseLiquidationTasks(liquidationTasks);
        }
      }

      if (unresolvedSymbols.size > 0) {
        const nextRetry = resolveNextQuoteRetry({
          attempts: previousRetryAttempts,
          nowMs: Date.now(),
          intervalMs: ORDER_QUOTE_RETRY.INTERVAL_MS,
          maxAttempts: ORDER_QUOTE_RETRY.MAX_ATTEMPTS,
        });
        if (nextRetry.exhausted) {
          logger.warn(
            `[MonitorTaskProcessor] LIQUIDATION_DISTANCE_CHECK 行情重试耗尽: ${data.monitorSymbol} symbols=${[...unresolvedSymbols].join(',')}`,
          );
          return { status: 'processed', retryRequest: null };
        }

        return {
          status: 'processed',
          retryRequest: {
            retryKey,
            attempts: nextRetry.nextAttempts,
            requirement: 'PRICE',
            task: {
              type: task.type,
              dedupeKey: task.dedupeKey,
              monitorSymbol: task.monitorSymbol,
              data: {
                ...task.data,
                retryAttempts: nextRetry.nextAttempts,
                monitorPrice: executionMonitorPrice ?? task.data.monitorPrice,
                long: unresolvedSymbols.has(longSymbol)
                  ? { ...task.data.long }
                  : { ...task.data.long, symbol: null, symbolName: null },
                short: unresolvedSymbols.has(shortSymbol)
                  ? { ...task.data.short }
                  : { ...task.data.short, symbol: null, symbolName: null },
              },
            },
          },
        };
      }
    } finally {
      if (longPosition) {
        positionObjectPool.release(longPosition);
      }

      if (shortPosition) {
        positionObjectPool.release(shortPosition);
      }
    }

    return { status: 'processed', retryRequest: null };
  };
}
