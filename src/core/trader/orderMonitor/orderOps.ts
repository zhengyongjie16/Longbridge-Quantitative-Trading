/**
 * orderMonitor 订单操作模块
 *
 * 职责：
 * - 管理 trackOrder 运行态写入
 * - 封装撤单与运行态清理
 * - 封装改单与委托价更新
 */
import { logger } from '../../../utils/logger/index.js';
import { isValidPositiveNumber } from '../../../utils/helpers/index.js';
import { formatError } from '../../../utils/error/index.js';
import { toDecimal } from '../utils.js';
import { OrderSide } from 'longport';
import type { OrderOps, OrderOpsDeps } from './types.js';
import type { TrackOrderParams, TrackedOrder } from '../types.js';
import { normalizePriceText, resolveInitialTrackedStatus } from './utils.js';

/**
 * 创建订单操作处理器。
 *
 * @param deps 订单操作依赖
 * @returns 订单操作接口
 */
export function createOrderOps(deps: OrderOpsDeps): OrderOps {
  const { runtime, ctxPromise, rateLimiter, cacheManager, orderRecorder, orderHoldRegistry } = deps;

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
      orderType,
      submittedPrice: price,
      submittedQuantity: quantity,
      executedQuantity: 0,
      status: resolveInitialTrackedStatus(initialStatus),
      submittedAt,
      lastPriceUpdateAt: now,
      convertedToMarket: false,
    };
    runtime.trackedOrders.set(orderId, order);
    logger.info(
      `[订单监控] 开始追踪订单 ${orderId}，` +
        `标的=${symbol}，方向=${side === OrderSide.Buy ? '买入' : '卖出'}，` +
        `${isLongSymbol ? '做多' : '做空'}标的`,
    );
  }

  /**
   * 撤销订单并执行运行态清理。
   *
   * @param orderId 订单 ID
   * @returns 撤单结果
   */
  async function cancelOrderWithRuntimeCleanup(orderId: string) {
    const ctx = await ctxPromise;
    try {
      await rateLimiter.throttle();
      await ctx.cancelOrder(orderId);
      const trackedOrder = runtime.trackedOrders.get(orderId);
      let cancelledRelatedBuyOrderIds: ReadonlyArray<string> | null = null;
      cacheManager.clearCache();
      runtime.trackedOrders.delete(orderId);
      orderHoldRegistry.markOrderClosed(orderId);
      if (trackedOrder?.side === OrderSide.Sell) {
        const cancelledSell = orderRecorder.markSellCancelled(orderId);
        cancelledRelatedBuyOrderIds = cancelledSell?.relatedBuyOrderIds ?? null;
      }
      logger.info(`[订单撤销成功] 订单ID=${orderId}`);
      return {
        cancelled: true,
        cancelledRelatedBuyOrderIds,
      };
    } catch (err) {
      logger.error(`[订单撤销失败] 订单ID=${orderId}`, formatError(err));
      return {
        cancelled: false,
        cancelledRelatedBuyOrderIds: null,
      };
    }
  }

  /**
   * 撤销订单。
   *
   * @param orderId 订单 ID
   * @returns true 表示撤单成功
   */
  async function cancelOrder(orderId: string): Promise<boolean> {
    const cancelResult = await cancelOrderWithRuntimeCleanup(orderId);
    return cancelResult.cancelled;
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
      trackedOrder.lastPriceUpdateAt = Date.now();
      logger.info(`[订单修改成功] 订单ID=${orderId} 新价格=${normalizedNewPriceText}`);
    } catch (err) {
      const errorMessage = formatError(err);
      logger.error(
        `[订单修改失败] 订单ID=${orderId} 新价格=${normalizedNewPriceText}`,
        errorMessage,
      );
      throw new Error(`订单修改失败: ${errorMessage}`, { cause: err });
    }
  }

  return {
    trackOrder,
    cancelOrderWithRuntimeCleanup,
    cancelOrder,
    replaceOrderPrice,
  };
}
