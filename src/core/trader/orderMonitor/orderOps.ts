/**
 * orderMonitor 订单操作模块
 *
 * 职责：
 * - 管理 trackOrder 运行态写入
 * - 封装撤单 outcome 语义
 * - 封装改单与委托价更新
 */
import { OrderSide } from 'longport';
import { logger } from '../../../utils/logger/index.js';
import { isValidPositiveNumber } from '../../../utils/helpers/index.js';
import type { CancelOrderOutcome } from '../../../types/trader.js';
import { toDecimal } from '../utils.js';
import type { OrderOps, OrderOpsDeps } from './types.js';
import type { TrackOrderParams, TrackedOrder } from '../types.js';
import {
  extractErrorCode,
  extractErrorMessage,
  isReplaceTempBlockedError,
  isReplaceUnsupportedByTypeError,
  isRetryableCancelError,
  normalizePriceText,
  resolveInitialTrackedStatus,
  resolveOrderClosedReasonFromError,
} from './utils.js';

const REPLACE_TEMP_BLOCK_BACKOFF_MS = 1000;

/**
 * 创建订单操作处理器。
 *
 * @param deps 订单操作依赖
 * @returns 订单操作接口
 */
export function createOrderOps(deps: OrderOpsDeps): OrderOps {
  const {
    runtime,
    ctxPromise,
    rateLimiter,
    cacheManager,
    orderHoldRegistry,
    finalizeOrderClose,
    enqueueCloseSync,
  } = deps;

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
    const now = Date.now();
    const submittedAt =
      typeof submittedAtMs === 'number' && isValidPositiveNumber(submittedAtMs)
        ? submittedAtMs
        : now;
    orderHoldRegistry.trackOrder(orderId, symbol);
    const order: TrackedOrder = {
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
  async function cancelOrderWithOutcome(orderId: string): Promise<CancelOrderOutcome> {
    const ctx = await ctxPromise;
    const trackedOrder = runtime.trackedOrders.get(orderId);
    const requiresFilledSellSync =
      trackedOrder?.side === OrderSide.Sell && trackedOrder.executedQuantity > 0;

    try {
      await rateLimiter.throttle();
      await ctx.cancelOrder(orderId);
      cacheManager.clearCache();
      const closeResult = requiresFilledSellSync
        ? null
        : finalizeOrderClose({
            orderId,
            closedReason: 'CANCELED',
            source: 'API',
            executedPrice: trackedOrder?.executedPrice ?? null,
            executedQuantity: trackedOrder?.executedQuantity ?? null,
            executedTimeMs: trackedOrder?.lastExecutedTimeMs ?? null,
          });
      if (requiresFilledSellSync) {
        enqueueCloseSync(orderId, 'UNKNOWN_FAILURE', 'CANCELED');
      }

      logger.debug(`[订单撤销成功] 订单ID=${orderId}`);
      return {
        kind: 'CANCEL_CONFIRMED',
        closedReason: 'CANCELED',
        source: 'API',
        relatedBuyOrderIds: closeResult?.relatedBuyOrderIds ?? null,
      };
    } catch (error) {
      const closedReason = resolveOrderClosedReasonFromError(error);
      if (closedReason !== null) {
        let relatedBuyOrderIds: ReadonlyArray<string> | null = null;
        if (closedReason === 'CANCELED' || closedReason === 'REJECTED') {
          cacheManager.clearCache();
          if (requiresFilledSellSync) {
            enqueueCloseSync(orderId, 'UNKNOWN_FAILURE', closedReason);
          } else {
            const closeResult = finalizeOrderClose({
              orderId,
              closedReason,
              source: 'API',
              executedPrice: trackedOrder?.executedPrice ?? null,
              executedQuantity: trackedOrder?.executedQuantity ?? null,
              executedTimeMs: trackedOrder?.lastExecutedTimeMs ?? null,
            });
            relatedBuyOrderIds = closeResult.relatedBuyOrderIds;
          }
        } else if (closedReason === 'FILLED') {
          enqueueCloseSync(orderId, 'ALREADY_CLOSED_FILLED', 'FILLED');
        } else {
          enqueueCloseSync(orderId, 'ALREADY_CLOSED_NOT_FOUND', 'NOT_FOUND');
        }

        return {
          kind: 'ALREADY_CLOSED',
          closedReason,
          source: 'API_ERROR',
          relatedBuyOrderIds,
        };
      }

      const errorCode = extractErrorCode(error);
      const message = extractErrorMessage(error);
      if (isRetryableCancelError(error)) {
        return {
          kind: 'RETRYABLE_FAILURE',
          errorCode,
          message,
        };
      }

      enqueueCloseSync(orderId, 'UNKNOWN_FAILURE');
      return {
        kind: 'UNKNOWN_FAILURE',
        errorCode,
        message,
      };
    }
  }

  /**
   * 撤销订单（外部统一入口）。
   *
   * @param orderId 订单 ID
   * @returns 语义化撤单结果
   */
  async function cancelOrder(orderId: string): Promise<CancelOrderOutcome> {
    return cancelOrderWithOutcome(orderId);
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
    const ctx = await ctxPromise;
    const trackedOrder = runtime.trackedOrders.get(orderId);

    if (!trackedOrder) {
      logger.warn(`[订单修改] 订单 ${orderId} 未在追踪列表中`);
      return;
    }

    const now = Date.now();
    if (trackedOrder.replaceCapability === 'UNSUPPORTED_BY_TYPE') {
      logger.debug(`[订单修改] 订单 ${orderId} 已标记为类型不支持改单，跳过`);
      return;
    }

    if (
      trackedOrder.replaceCapability === 'TEMP_BLOCKED_BY_STATUS' &&
      trackedOrder.replaceBlockedUntilAt !== null &&
      trackedOrder.replaceBlockedUntilAt > now
    ) {
      logger.debug(`[订单修改] 订单 ${orderId} 状态临时不允许改单，等待退避结束`);
      return;
    }

    const remainingQty = trackedOrder.submittedQuantity - trackedOrder.executedQuantity;
    const targetQuantity = quantity ?? remainingQty;
    if (!Number.isFinite(targetQuantity) || targetQuantity <= 0) {
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
      await ctx.replaceOrder(replacePayload);
      cacheManager.clearCache();
      trackedOrder.submittedPrice = normalizedNewPriceNumber;
      trackedOrder.submittedQuantity = trackedOrder.executedQuantity + targetQuantity;
      trackedOrder.lastPriceUpdateAt = now;
      trackedOrder.replaceCapability = 'SUPPORTED';
      trackedOrder.replaceBlockedUntilAt = null;
      logger.debug(`[订单修改成功] 订单ID=${orderId} 新价格=${normalizedNewPriceText}`);
    } catch (error) {
      trackedOrder.lastPriceUpdateAt = now;
      const closedReason = resolveOrderClosedReasonFromError(error);
      if (closedReason !== null) {
        if (closedReason === 'FILLED') {
          enqueueCloseSync(orderId, 'ALREADY_CLOSED_FILLED', 'FILLED');
        } else if (closedReason === 'NOT_FOUND') {
          enqueueCloseSync(orderId, 'ALREADY_CLOSED_NOT_FOUND', 'NOT_FOUND');
        } else {
          finalizeOrderClose({
            orderId,
            closedReason,
            source: 'API',
          });
        }

        logger.warn(`[订单修改] 订单 ${orderId} 已关闭，停止改单流程`);
        return;
      }

      if (isReplaceUnsupportedByTypeError(error)) {
        trackedOrder.replaceCapability = 'UNSUPPORTED_BY_TYPE';
        logger.warn(`[订单修改] 订单 ${orderId} 类型不支持改单（602012），后续永久禁改`);
        return;
      }

      if (isReplaceTempBlockedError(error)) {
        trackedOrder.replaceCapability = 'TEMP_BLOCKED_BY_STATUS';
        trackedOrder.replaceBlockedUntilAt = now + REPLACE_TEMP_BLOCK_BACKOFF_MS;
        logger.warn(`[订单修改] 订单 ${orderId} 状态暂不允许改单（602013），进入短时退避`);
        return;
      }

      const message = extractErrorMessage(error);
      logger.error(`[订单修改失败] 订单ID=${orderId} 新价格=${normalizedNewPriceText}: ${message}`);
    }
  }

  return {
    trackOrder,
    cancelOrderWithOutcome,
    cancelOrder,
    replaceOrderPrice,
  };
}
