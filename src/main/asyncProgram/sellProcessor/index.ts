/**
 * 卖出处理器模块
 *
 * 功能：
 * - 消费 SellTaskQueue 中的卖出任务
 * - 使用 setImmediate 异步执行，不阻塞事件调度
 * - 卖出信号不经过风险检查，直接计算卖出数量并执行
 *
 * 设计原因：
 * - 卖出操作的优先级高于买入，应优先允许执行
 * - 卖出信号不需要 API 调用的风险检查，执行路径更短
 * - 独立队列避免被买入任务阻塞
 *
 * 安全与门禁协作：
 * - 在处理任意卖出任务前，先通过 postTradeConsistencyRuntime.waitForFresh() 等待最近一次成交后的账户/持仓/浮亏刷新完成
 * - 卖出执行与卖出数量计算均使用执行时从 marketDataClient 读取的 realtime quote
 * - 仍会检查席位 ACTIVE 状态、席位版本与标的一致性，任何不满足条件的信号都会被安全跳过并记录原因
 * - 真实卖出数量由 signalProcessor.processSellSignals 按智能平仓策略计算，若被转为 HOLD 则不提交订单
 *
 * 执行顺序：
 * 1. 从队列获取任务
 * 2. 获取监控上下文（行情、持仓数据）
 * 3. 调用 signalProcessor.processSellSignals() 计算卖出数量
 * 4. 如果信号未被转为 HOLD，执行 trader.executeSignals()
 */
import { ORDER_QUOTE_RETRY } from '../../../constants/index.js';
import {
  createBaseProcessor,
  executeSignalsWithLifecycleGate,
  logProcessorTaskFailure,
} from '../utils.js';
import {
  resolveNextQuoteRetry,
  resolveQuoteReadinessForRequirement,
} from '../../../utils/quoteRetry/index.js';
import { isExternalApiRequestError } from '../../../utils/apiFailure/index.js';
import { isRefreshGateAbortError } from '../../../utils/refreshGate/index.js';
import { logger } from '../../../utils/logger/index.js';
import { isSeatActive } from '../../../utils/seat/guards.js';
import {
  describeSignalSeatValidationFailure,
  validateSignalSeat,
} from '../../../services/autoSymbolManager/utils.js';
import type { Processor } from '../types.js';
import type { SellProcessorDeps, SellRetryState } from './types.js';
import type { Task, SellTaskType } from '../tradeTaskQueue/types.js';
import { formatSymbolDisplay } from '../../../utils/display/index.js';
import type { SellSignal, Signal } from '../../../types/signal.js';

/**
 * 复制卖出信号，用于 quote retry 的 delayed re-enqueue。
 *
 * @param signal 原始卖出信号
 * @returns 可重新入队的卖出信号副本
 */
function cloneSellSignal(signal: SellSignal): SellSignal {
  return {
    ...signal,
    triggerTime: signal.triggerTime ? new Date(signal.triggerTime) : null,
    indicators1: signal.indicators1 ? { ...signal.indicators1 } : null,
    relatedBuyOrderIds: signal.relatedBuyOrderIds ? [...signal.relatedBuyOrderIds] : null,
  };
}

function toExecutableSellSignal(signal: Signal): SellSignal | null {
  if (signal.action !== 'SELLCALL' && signal.action !== 'SELLPUT') {
    return null;
  }

  const seatVersion = signal.seatVersion;
  if (typeof seatVersion !== 'number' || !Number.isFinite(seatVersion)) {
    return null;
  }

  return {
    ...signal,
    action: signal.action,
    seatVersion,
  };
}

/**
 * 构建卖出 quote retry 键。
 *
 * 同一标的同方向的不同业务动作（原因、数量、订单类型等）必须独立重试，
 * 避免被错误合并导致语义丢失。
 */
function buildSellRetryKey(params: {
  readonly monitorSymbol: string;
  readonly signal: SellSignal;
}): string {
  const { monitorSymbol, signal } = params;
  const relatedOrderIds = signal.relatedBuyOrderIds?.join(',') ?? '';
  const triggerTimeMs = signal.triggerTime instanceof Date ? signal.triggerTime.getTime() : -1;
  return [
    monitorSymbol,
    signal.action,
    signal.symbol,
    String(signal.seatVersion),
    String(signal.quantity ?? ''),
    signal.orderTypeOverride ?? '',
    String(signal.isProtectiveLiquidation ?? ''),
    signal.reason ?? '',
    relatedOrderIds,
    String(triggerTimeMs),
  ].join('|');
}

/**
 * 创建卖出处理器。
 * 消费 SellTaskQueue 中的卖出任务，经成交后一致性 freshness 等待后计算卖出数量并执行；独立于买入处理器，保证卖出优先、不被风险检查阻塞。
 *
 * @param deps 依赖注入（任务队列、getMonitorContext、signalProcessor、trader、getLastState、postTradeConsistencyRuntime、可选 getCanProcessTask）
 * @returns 实现 Processor 接口的卖出处理器实例（start/stop/stopAndDrain/restart）
 */
export function createSellProcessor(deps: SellProcessorDeps): Processor {
  const {
    taskQueue,
    getMonitorContext,
    signalProcessor,
    trader,
    marketDataClient,
    getLastState,
    postTradeConsistencyRuntime,
    scheduleRetry,
    clearRetry,
    getCanProcessTask,
    onFatalError,
  } = deps;
  const retryStates = new Map<string, SellRetryState>();
  let lifecycleActive = true;
  const schedule =
    scheduleRetry ??
    ((callback: () => void, delayMs: number) => {
      return setTimeout(callback, delayMs);
    });
  const clear =
    clearRetry ??
    ((handle: ReturnType<typeof setTimeout>) => {
      clearTimeout(handle);
    });

  function clearRetryState(retryKey: string): void {
    const retryState = retryStates.get(retryKey);
    if (!retryState) {
      return;
    }

    if (retryState.handle) {
      clear(retryState.handle);
    }

    retryStates.delete(retryKey);
  }

  function clearAllRetryStates(): void {
    for (const retryKey of retryStates.keys()) {
      clearRetryState(retryKey);
    }
  }

  /**
   * 处理单个卖出任务
   */
  async function processTask(task: Task<SellTaskType>): Promise<void> {
    const { data: signal, monitorSymbol } = task;
    const symbolDisplay = formatSymbolDisplay(signal.symbol, signal.symbolName ?? null);
    try {
      try {
        await postTradeConsistencyRuntime.waitForFresh();
      } catch (err) {
        if (isRefreshGateAbortError(err, 'STOP_AND_DRAIN')) {
          return;
        }

        throw err;
      }

      // 获取监控上下文
      const ctx = getMonitorContext(monitorSymbol);
      if (!ctx) {
        logger.warn(
          `[SellProcessor] 无法获取监控上下文: ${formatSymbolDisplay(monitorSymbol, null)}`,
        );
        return;
      }

      const { config, orderRecorder, symbolRegistry } = ctx;
      const lastState = getLastState();
      const seatValidation = validateSignalSeat({
        monitorSymbol,
        signal,
        symbolRegistry,
      });
      if (!seatValidation.valid) {
        logger.debug(
          `[SellProcessor] ${describeSignalSeatValidationFailure(seatValidation)}，跳过信号: ${symbolDisplay} ${signal.action}`,
        );
        return;
      }

      // 获取持仓数据（从 positionCache 获取）
      const longSeatState = symbolRegistry.getSeatState(monitorSymbol, 'LONG');
      const shortSeatState = symbolRegistry.getSeatState(monitorSymbol, 'SHORT');
      const longPosition = isSeatActive(longSeatState)
        ? lastState.positionCache.get(longSeatState.symbol)
        : null;
      const shortPosition = isSeatActive(shortSeatState)
        ? lastState.positionCache.get(shortSeatState.symbol)
        : null;
      const quoteSymbols: string[] = [];
      if (isSeatActive(longSeatState)) {
        quoteSymbols.push(longSeatState.symbol);
      }

      if (isSeatActive(shortSeatState)) {
        quoteSymbols.push(shortSeatState.symbol);
      }

      const executionQuotes = await marketDataClient.getQuotes(quoteSymbols);
      const longQuote = isSeatActive(longSeatState)
        ? (executionQuotes.get(longSeatState.symbol) ?? null)
        : null;
      const shortQuote = isSeatActive(shortSeatState)
        ? (executionQuotes.get(shortSeatState.symbol) ?? null)
        : null;
      const retryKey = buildSellRetryKey({ monitorSymbol, signal });
      const retryState = retryStates.get(retryKey);
      const targetQuote = signal.action === 'SELLCALL' ? longQuote : shortQuote;
      const quoteReadiness = resolveQuoteReadinessForRequirement({
        quote: targetQuote,
        requirement: 'PRICE',
      });
      if (quoteReadiness !== 'READY') {
        if (!lifecycleActive) {
          return;
        }

        if (quoteReadiness !== 'MISSING') {
          clearRetryState(retryKey);
          logger.warn(
            `[SellProcessor] 卖出行情无效，放弃当前执行: ${symbolDisplay} ${signal.action} readiness=${quoteReadiness}`,
          );
          return;
        }

        if (retryState?.retrySignal === null || !retryState) {
          const nextRetry = resolveNextQuoteRetry({
            attempts: retryState?.attempts ?? 0,
            nowMs: Date.now(),
            intervalMs: ORDER_QUOTE_RETRY.INTERVAL_MS,
            maxAttempts: ORDER_QUOTE_RETRY.MAX_ATTEMPTS,
          });
          if (nextRetry.exhausted) {
            clearRetryState(retryKey);
            logger.warn(
              `[SellProcessor] 卖出行情重试耗尽，放弃执行: ${symbolDisplay} ${signal.action}`,
            );
          } else {
            const retrySignal = cloneSellSignal(signal);
            const nextRetryState: SellRetryState = {
              handle: null,
              retrySignal,
              attempts: nextRetry.nextAttempts,
            };
            const retryHandle = schedule(() => {
              const pendingRetryState = retryStates.get(retryKey);
              if (!pendingRetryState?.retrySignal || !lifecycleActive) {
                return;
              }

              const queuedRetrySignal = pendingRetryState.retrySignal;
              pendingRetryState.retrySignal = null;
              taskQueue.push({
                type: task.type,
                monitorSymbol,
                data: queuedRetrySignal,
              });
            }, ORDER_QUOTE_RETRY.INTERVAL_MS);
            nextRetryState.handle = retryHandle;
            retryStates.set(retryKey, nextRetryState);
          }
        }

        return;
      }

      clearRetryState(retryKey);

      // 卖出信号处理：计算卖出数量（不经过风险检查）
      // 原因：
      // 1. 卖出操作的优先级高于买入，应优先允许执行
      // 2. checkBeforeOrder 对卖出信号基本是直接放行（只有持仓市值限制检查，但对卖出无意义）
      // 3. applyRiskChecks 的冷却期检查会阻止 10 秒内的重复卖出，不适用于卖出场景
      const processedSignals = signalProcessor.processSellSignals({
        signals: [signal],
        longPosition,
        shortPosition,
        longQuote,
        shortQuote,
        orderRecorder,
        smartCloseEnabled: config.smartCloseEnabled,
        smartCloseTimeoutMinutes: config.smartCloseTimeoutMinutes,
        nowMs: Date.now(),
        isHalfDay: lastState.isHalfDay ?? false,
        tradingCalendarSnapshot: lastState.tradingCalendarSnapshot ?? new Map(),
      });

      // 如果信号被转为 HOLD，跳过执行
      const firstSignal = processedSignals[0];
      if (!firstSignal || firstSignal.action === 'HOLD') {
        logger.debug(`[SellProcessor] 卖出信号被跳过: ${symbolDisplay} ${signal.action}`);
        return; // 处理成功（虽然跳过了）
      }

      const executionSignal = toExecutableSellSignal(firstSignal);
      if (executionSignal === null) {
        logger.debug(
          `[SellProcessor] 卖出信号缺少可执行动作或席位版本，跳过信号: ${symbolDisplay} ${firstSignal.action}`,
        );
        return;
      }

      const executionSeatValidation = validateSignalSeat({
        monitorSymbol,
        signal: executionSignal,
        symbolRegistry,
      });
      if (!executionSeatValidation.valid) {
        logger.debug(
          `[SellProcessor] ${describeSignalSeatValidationFailure(executionSeatValidation)}，执行前复核失败，跳过信号: ${symbolDisplay} ${signal.action}`,
        );
        return;
      }

      await executeSignalsWithLifecycleGate({
        getCanProcessTask,
        trader,
        signal: executionSignal,
        symbolDisplay,
        loggerPrefix: 'SellProcessor',
        successMessage: '卖出订单执行完成',
      });
      return;
    } catch (err) {
      if (!isExternalApiRequestError(err)) {
        throw err;
      }

      if (err.operation === 'TradeContext.submitOrder') {
        throw err;
      }

      logProcessorTaskFailure('SellProcessor', symbolDisplay, signal.action, err);
      return;
    }
  }
  const baseProcessor = createBaseProcessor({
    loggerPrefix: 'SellProcessor',
    taskQueue,
    processTask,
    ...(getCanProcessTask ? { getCanProcessTask } : {}),
    ...(onFatalError ? { onFatalError } : {}),
  });

  return {
    start: () => {
      lifecycleActive = true;
      baseProcessor.start();
    },
    stop: () => {
      lifecycleActive = false;
      clearAllRetryStates();
      baseProcessor.stop();
    },
    stopAndDrain: async () => {
      lifecycleActive = false;
      clearAllRetryStates();
      await baseProcessor.stopAndDrain();
    },
    restart: () => {
      lifecycleActive = false;
      clearAllRetryStates();
      baseProcessor.restart();
      lifecycleActive = true;
    },
  };
}
