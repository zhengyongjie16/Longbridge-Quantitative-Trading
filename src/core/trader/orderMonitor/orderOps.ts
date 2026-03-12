/**
 * orderMonitor 订单操作模块
 *
 * 职责：
 * - 管理 trackOrder 运行态写入与单订单查询缓存
 * - 封装撤单/改单 API 结果的统一语义
 * - 维护改单阻塞恢复与运行态重置
 */
import { OrderSide } from 'longbridge';
import { logger } from '../../../utils/logger/index.js';
import { isValidPositiveNumber } from '../../../utils/helpers/index.js';
import type { CancelOrderOutcome, OrderStateCheckResult } from '../../../types/trader.js';
import {
  ORDER_MONITOR_REPLACE_TEMP_BLOCK_BACKOFF_MS,
  ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS,
} from '../../../constants/index.js';
import { toDecimal } from '../utils.js';
import type { TrackOrderParams } from '../types.js';
import type {
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
  OrderOps,
  OrderOpsDeps,
  ReplaceOrderOutcome,
  TerminalStateSnapshot,
} from './types.js';
import {
  extractErrorCode,
  extractErrorMessage,
  isOrderClosedBusinessError,
  isReplaceTempBlockedError,
  isReplaceUnsupportedByTypeError,
  isRetryableCancelError,
  isWaitWsOnlyReplaceMode,
  normalizePriceText,
  resolveInitialTrackedStatus,
} from './utils.js';

/**
 * 读取并消费单订单权威终态缓存。
 * 该缓存只允许被消费一次，避免同一终态被重复结算。
 */
export function consumeQueriedTerminalState(
  runtime: OrderMonitorRuntimeStore,
  orderId: string,
): TerminalStateSnapshot | null {
  const state = runtime.queriedTerminalStateByOrderId.get(orderId) ?? null;
  if (state !== null) {
    runtime.queriedTerminalStateByOrderId.delete(orderId);
  }

  return state;
}

/**
 * 读取并消费最新改单结果缓存。
 * 调用方消费后即删除，保证 outcome 语义是“增量事件”而非“持久状态”。
 */
export function consumeLatestReplaceOutcome(
  runtime: OrderMonitorRuntimeStore,
  orderId: string,
): ReplaceOrderOutcome | null {
  const outcome = runtime.latestReplaceOutcomeByOrderId.get(orderId) ?? null;
  if (outcome !== null) {
    runtime.latestReplaceOutcomeByOrderId.delete(orderId);
  }

  return outcome;
}

/**
 * 清理改单相关运行态缓存。
 * 用于终态结算、WS 推进或恢复重置后的状态收敛。
 */
export function resetOrderReplaceRuntimeState(
  runtime: OrderMonitorRuntimeStore,
  orderId: string,
): void {
  runtime.latestReplaceOutcomeByOrderId.delete(orderId);
  runtime.queriedTerminalStateByOrderId.delete(orderId);
}

/** 将改单状态恢复到可继续尝试的初始值。 */
function resetTrackedOrderReplaceState(trackedOrder: OrderMonitorTrackedOrder): void {
  trackedOrder.replaceCapability = 'SUPPORTED';
  trackedOrder.replaceBlockedUntilAt = null;
  trackedOrder.replaceTempBlockedCount = 0;
  trackedOrder.replaceResumeMode = 'TIME_BACKOFF';
  trackedOrder.stateCheckBlockedUntilAt = null;
  trackedOrder.nextStateCheckAt = null;
  trackedOrder.stateCheckRetryCount = 0;
}

/**
 * 当 WS 显示订单状态已推进时，解除 TEMP_BLOCKED_BY_STATUS 的改单阻塞。
 */
export function resumeOrderReplaceFromWsProgress(
  runtime: OrderMonitorRuntimeStore,
  orderId: string,
  trackedOrder: OrderMonitorTrackedOrder,
): void {
  if (trackedOrder.replaceCapability !== 'TEMP_BLOCKED_BY_STATUS') {
    return;
  }

  resetTrackedOrderReplaceState(trackedOrder);
  resetOrderReplaceRuntimeState(runtime, orderId);
}

/** 将单订单权威状态查询结果映射为统一撤单 outcome。 */
function mapStateCheckResultToCancelOutcome(
  runtime: OrderMonitorRuntimeStore,
  orderId: string,
  queryResult: OrderStateCheckResult,
): CancelOrderOutcome {
  if (queryResult.kind === 'TERMINAL') {
    runtime.queriedTerminalStateByOrderId.set(orderId, queryResult);
    return {
      kind: 'ALREADY_CLOSED',
      closedReason: queryResult.closedReason,
      source: 'API_ERROR',
      relatedBuyOrderIds: null,
    };
  }

  if (queryResult.kind === 'OPEN') {
    return {
      kind: 'UNKNOWN_FAILURE',
      errorCode: null,
      message: `order still open after business failure: status=${queryResult.status}`,
    };
  }

  return {
    kind: 'UNKNOWN_FAILURE',
    errorCode: queryResult.errorCode,
    message: queryResult.message,
  };
}

/** 写入改单结果事件缓存，供 quoteFlow 在同轮循环中消费。 */
function setReplaceOutcome(
  runtime: OrderMonitorRuntimeStore,
  orderId: string,
  outcome: ReplaceOrderOutcome,
): void {
  runtime.latestReplaceOutcomeByOrderId.set(orderId, outcome);
}

/** 清理单个订单的改单阻塞与查询缓存，进入“可重试”稳态。 */
function clearReplaceState(
  runtime: OrderMonitorRuntimeStore,
  orderId: string,
  trackedOrder: OrderMonitorTrackedOrder,
): void {
  resetTrackedOrderReplaceState(trackedOrder);
  runtime.latestReplaceOutcomeByOrderId.delete(orderId);
  runtime.queriedTerminalStateByOrderId.delete(orderId);
}

/**
 * 创建订单操作处理器。
 *
 * @param deps 订单操作依赖
 * @returns 订单操作接口
 */
export function createOrderOps(deps: OrderOpsDeps): OrderOps {
  const { runtime, ctxPromise, rateLimiter, cacheManager, orderHoldRegistry, orderStatusQuery } =
    deps;

  /**
   * 开始追踪订单（订单提交后调用）。
   *
   * @param params 追踪参数
   * @returns 无返回值
   */
  function trackOrder(params: TrackOrderParams): void {
    const {
      orderId,
      symbol,
      side,
      price,
      quantity,
      submittedAtMs,
      initialStatus,
      isLongSymbol,
      monitorSymbol,
      isProtectiveLiquidation,
      orderType,
      liquidationTriggerLimit,
      liquidationCooldownConfig,
    } = params;
    resetOrderReplaceRuntimeState(runtime, orderId);
    const now = Date.now();
    const submittedAt =
      typeof submittedAtMs === 'number' && isValidPositiveNumber(submittedAtMs)
        ? submittedAtMs
        : now;
    orderHoldRegistry.trackOrder(orderId, symbol);
    const order: OrderMonitorTrackedOrder = {
      orderId,
      symbol,
      side,
      isLongSymbol,
      monitorSymbol,
      isProtectiveLiquidation,
      liquidationTriggerLimit: liquidationTriggerLimit ?? 1,
      liquidationCooldownConfig: liquidationCooldownConfig ?? null,
      orderType,
      submittedPrice: price,
      submittedQuantity: quantity,
      executedQuantity: 0,
      executedPrice: null,
      lastExecutedTimeMs: null,
      status: resolveInitialTrackedStatus(initialStatus),
      submittedAt,
      lastPriceUpdateAt: now,
      convertedToMarket: false,
      nextCancelAttemptAt: now,
      cancelRetryCount: 0,
      replaceCapability: 'SUPPORTED',
      replaceBlockedUntilAt: null,
      nextStateCheckAt: null,
      stateCheckRetryCount: 0,
      stateCheckBlockedUntilAt: null,
      replaceTempBlockedCount: 0,
      replaceResumeMode: 'TIME_BACKOFF',
      timeoutMarketConversionPending: false,
      timeoutMarketConversionTerminalState: null,
    };
    runtime.trackedOrders.set(orderId, order);
    runtime.trackedOrderLifecycles.set(orderId, 'OPEN');
    logger.debug(
      `[订单监控] 开始追踪订单 ${orderId}，` +
        `标的=${symbol}，方向=${side === OrderSide.Buy ? '买入' : '卖出'}，` +
        `${isLongSymbol ? '做多' : '做空'}标的`,
    );
  }

  /**
   * 撤销订单并返回 outcome。
   *
   * @param orderId 订单 ID
   * @returns 语义化撤单结果
   */
  async function cancelOrder(orderId: string): Promise<CancelOrderOutcome> {
    try {
      await rateLimiter.throttle();
      const ctx = await ctxPromise;
      await ctx.cancelOrder(orderId);
      cacheManager.clearCache();
      logger.debug(`[订单撤销成功] 订单ID=${orderId}，等待 WS 终态确认`);
      return {
        kind: 'CANCEL_CONFIRMED',
        closedReason: 'CANCELED',
        source: 'API',
        relatedBuyOrderIds: null,
      };
    } catch (error) {
      const errorCode = extractErrorCode(error);
      const message = extractErrorMessage(error);
      if (isRetryableCancelError(error)) {
        return {
          kind: 'RETRYABLE_FAILURE',
          errorCode,
          message,
        };
      }

      if (!isOrderClosedBusinessError(error)) {
        return {
          kind: 'UNKNOWN_FAILURE',
          errorCode,
          message,
        };
      }

      const queryResult = await orderStatusQuery.checkOrderState(orderId);
      return mapStateCheckResultToCancelOutcome(runtime, orderId, queryResult);
    }
  }

  /**
   * 处理 602013（订单状态暂不允许改单）：
   * 前四次指数退避，第五次开始改为 WAIT_WS_ONLY，仅依赖 WS 状态推进解锁。
   */
  async function handleReplaceTempBlockedByStatus(
    orderId: string,
    trackedOrder: OrderMonitorTrackedOrder,
    now: number,
  ): Promise<void> {
    const retryCount = trackedOrder.replaceTempBlockedCount + 1;
    trackedOrder.replaceTempBlockedCount = retryCount;

    if (retryCount <= ORDER_MONITOR_REPLACE_TEMP_BLOCK_BACKOFF_MS.length) {
      const backoffMs = ORDER_MONITOR_REPLACE_TEMP_BLOCK_BACKOFF_MS[retryCount - 1] ?? 8000;
      trackedOrder.replaceCapability = 'TEMP_BLOCKED_BY_STATUS';
      trackedOrder.replaceBlockedUntilAt = now + backoffMs;
      trackedOrder.replaceResumeMode = 'TIME_BACKOFF';
      setReplaceOutcome(runtime, orderId, {
        kind: 'TEMP_BLOCKED',
        retryCount,
        nextRetryAtMs: trackedOrder.replaceBlockedUntilAt,
        resumeMode: 'TIME_BACKOFF',
      });

      logger.warn(
        `[订单修改] 订单 ${orderId} 状态暂不允许改单（602013），第 ${retryCount} 次退避 ${Math.floor(backoffMs / 1000)} 秒`,
      );
      return;
    }

    const queryResult = await orderStatusQuery.checkOrderState(orderId);
    if (queryResult.kind === 'TERMINAL') {
      runtime.queriedTerminalStateByOrderId.set(orderId, queryResult);
      clearReplaceState(runtime, orderId, trackedOrder);
      setReplaceOutcome(runtime, orderId, {
        kind: 'TERMINAL_CONFIRMED',
        terminalState: queryResult,
      });
      logger.warn(`[订单修改] 订单 ${orderId} 连续 602013 后确认已终态，停止改单`);
      return;
    }

    trackedOrder.replaceCapability = 'TEMP_BLOCKED_BY_STATUS';
    trackedOrder.replaceBlockedUntilAt = ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS;
    trackedOrder.replaceResumeMode = 'WAIT_WS_ONLY';
    setReplaceOutcome(runtime, orderId, {
      kind: 'WAIT_WS_ONLY',
      reason: queryResult.kind === 'OPEN' ? 'OPEN' : 'QUERY_FAILED',
    });

    logger.warn(
      `[订单修改] 订单 ${orderId} 连续 602013 第 5 次后仍未确认终态，切换 WAIT_WS_ONLY 等待 WS`,
    );
  }

  /**
   * 修改订单委托价格。
   *
   * @param orderId 订单 ID
   * @param newPrice 新价格
   * @param quantity 可选新数量（默认剩余数量）
   * @returns 无返回值
   */
  async function replaceOrderPrice(
    orderId: string,
    newPrice: number,
    quantity: number | null = null,
  ): Promise<void> {
    const trackedOrder = runtime.trackedOrders.get(orderId);
    if (!trackedOrder) {
      setReplaceOutcome(runtime, orderId, {
        kind: 'SKIPPED',
        reason: 'ORDER_NOT_TRACKED',
      });
      logger.warn(`[订单修改] 订单 ${orderId} 未在追踪列表中`);
      return;
    }

    const now = Date.now();
    if (trackedOrder.replaceCapability === 'UNSUPPORTED_BY_TYPE') {
      setReplaceOutcome(runtime, orderId, {
        kind: 'SKIPPED',
        reason: 'UNSUPPORTED_BY_TYPE',
      });
      logger.debug(`[订单修改] 订单 ${orderId} 已标记为类型不支持改单，跳过`);
      return;
    }

    if (isWaitWsOnlyReplaceMode(trackedOrder)) {
      setReplaceOutcome(runtime, orderId, {
        kind: 'SKIPPED',
        reason: 'WAIT_WS_ONLY',
      });
      return;
    }

    if (
      trackedOrder.replaceCapability === 'TEMP_BLOCKED_BY_STATUS' &&
      trackedOrder.replaceBlockedUntilAt !== null &&
      trackedOrder.replaceBlockedUntilAt > now
    ) {
      setReplaceOutcome(runtime, orderId, {
        kind: 'SKIPPED',
        reason: 'BACKOFF_IN_PROGRESS',
      });
      return;
    }

    const remainingQty = trackedOrder.submittedQuantity - trackedOrder.executedQuantity;
    const targetQuantity = quantity ?? remainingQty;
    if (!Number.isFinite(targetQuantity) || targetQuantity <= 0) {
      setReplaceOutcome(runtime, orderId, {
        kind: 'SKIPPED',
        reason: 'INVALID_REMAINING_QUANTITY',
      });
      logger.warn(`[订单修改] 订单 ${orderId} 剩余数量无效: ${targetQuantity}`);
      return;
    }

    const normalizedNewPriceText = normalizePriceText(newPrice);
    const normalizedNewPriceDecimal = toDecimal(normalizedNewPriceText);
    const normalizedNewPriceNumber = Number(normalizedNewPriceText);
    const replacePayload = {
      orderId,
      price: normalizedNewPriceDecimal,
      quantity: toDecimal(targetQuantity),
    };

    try {
      await rateLimiter.throttle();
      const ctx = await ctxPromise;
      await ctx.replaceOrder(replacePayload);
      cacheManager.clearCache();
      trackedOrder.submittedPrice = normalizedNewPriceNumber;
      trackedOrder.submittedQuantity = trackedOrder.executedQuantity + targetQuantity;
      trackedOrder.lastPriceUpdateAt = now;
      clearReplaceState(runtime, orderId, trackedOrder);
      setReplaceOutcome(runtime, orderId, {
        kind: 'REPLACED',
      });
      logger.debug(`[订单修改成功] 订单ID=${orderId} 新价格=${normalizedNewPriceText}`);
    } catch (error) {
      trackedOrder.lastPriceUpdateAt = now;
      const errorCode = extractErrorCode(error);
      const message = extractErrorMessage(error);

      if (isReplaceUnsupportedByTypeError(error)) {
        trackedOrder.replaceCapability = 'UNSUPPORTED_BY_TYPE';
        trackedOrder.replaceBlockedUntilAt = null;
        trackedOrder.replaceResumeMode = 'TIME_BACKOFF';
        trackedOrder.replaceTempBlockedCount = 0;
        setReplaceOutcome(runtime, orderId, {
          kind: 'SKIPPED',
          reason: 'UNSUPPORTED_BY_TYPE',
        });
        logger.warn(`[订单修改] 订单 ${orderId} 类型不支持改单（602012），后续永久禁改`);
        return;
      }

      if (isReplaceTempBlockedError(error)) {
        await handleReplaceTempBlockedByStatus(orderId, trackedOrder, now);
        return;
      }

      if (isRetryableCancelError(error)) {
        setReplaceOutcome(runtime, orderId, {
          kind: 'FAILED',
          reason: 'RETRYABLE',
          errorCode,
          message,
        });

        logger.warn(
          `[订单修改失败] 订单ID=${orderId} 新价格=${normalizedNewPriceText}: ${message}`,
        );
        return;
      }

      if (isOrderClosedBusinessError(error)) {
        const queryResult = await orderStatusQuery.checkOrderState(orderId);
        if (queryResult.kind === 'TERMINAL') {
          runtime.queriedTerminalStateByOrderId.set(orderId, queryResult);
          clearReplaceState(runtime, orderId, trackedOrder);
          setReplaceOutcome(runtime, orderId, {
            kind: 'TERMINAL_CONFIRMED',
            terminalState: queryResult,
          });
          logger.warn(`[订单修改] 订单 ${orderId} 业务失败后确认已终态，停止改单流程`);
          return;
        }

        if (queryResult.kind === 'OPEN') {
          setReplaceOutcome(runtime, orderId, {
            kind: 'FAILED',
            reason: 'QUERY_OPEN',
            errorCode,
            message: `order still open: status=${queryResult.status}`,
          });
          return;
        }

        setReplaceOutcome(runtime, orderId, {
          kind: 'FAILED',
          reason: 'QUERY_FAILED',
          errorCode: queryResult.errorCode,
          message: queryResult.message,
        });
        return;
      }

      setReplaceOutcome(runtime, orderId, {
        kind: 'FAILED',
        reason: 'UNKNOWN',
        errorCode,
        message,
      });
      logger.error(`[订单修改失败] 订单ID=${orderId} 新价格=${normalizedNewPriceText}: ${message}`);
    }
  }

  return {
    trackOrder,
    cancelOrder,
    replaceOrderPrice,
  };
}
