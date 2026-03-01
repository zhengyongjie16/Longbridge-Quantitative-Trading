/**
 * orderMonitor 行情驱动流程模块
 *
 * 职责：
 * - 处理买卖订单超时（买撤单/卖转市价）
 * - 基于最新行情执行委托价跟踪与改单
 * - 提供未成交卖单快照供卖单合并决策使用
 */
import { OrderSide, OrderType, TimeInForceType } from 'longport';
import { logger } from '../../../utils/logger/index.js';
import {
  NON_REPLACEABLE_ORDER_STATUSES,
  NON_REPLACEABLE_ORDER_TYPES,
  PENDING_ORDER_STATUSES,
} from '../../../constants/index.js';
import type { Quote } from '../../../types/quote.js';
import { toDecimal } from '../utils.js';
import type { PendingSellOrderSnapshot, TrackedOrder } from '../types.js';
import type { QuoteFlow, QuoteFlowDeps } from './types.js';
import {
  calculatePriceDiffDecimal,
  normalizePriceText,
  resolveOrderIdFromSubmitResponse,
} from './utils.js';

/**
 * 创建行情驱动流程处理器。
 *
 * @param deps 行情驱动流依赖
 * @returns 行情驱动流接口
 */
export function createQuoteFlow(deps: QuoteFlowDeps): QuoteFlow {
  const {
    runtime,
    config,
    thresholdDecimal,
    orderRecorder,
    ctxPromise,
    rateLimiter,
    isExecutionAllowed,
    trackOrder,
    cancelOrder,
    cancelOrderWithRuntimeCleanup,
    replaceOrderPrice,
  } = deps;

  /**
   * 处理买入订单超时：仅撤销，不转市价。
   *
   * @param orderId 订单 ID
   * @param order 追踪订单
   * @returns 无返回值
   */
  async function handleBuyOrderTimeout(orderId: string, order: TrackedOrder): Promise<void> {
    const elapsed = Date.now() - order.submittedAt;
    logger.warn(`[订单监控] 买入订单 ${orderId} 超时(${Math.floor(elapsed / 1000)}秒)，撤销订单`);
    const remainingQuantity = order.submittedQuantity - order.executedQuantity;
    if (remainingQuantity <= 0) {
      runtime.trackedOrders.delete(orderId);
      return;
    }
    const cancelled = await cancelOrder(orderId);
    if (cancelled) {
      logger.info(`[订单监控] 买入订单 ${orderId} 已撤销，剩余未成交数量=${remainingQuantity}`);
    } else {
      logger.warn(`[订单监控] 买入订单 ${orderId} 撤销失败（可能已成交或已撤销）`);
    }
  }

  /**
   * 处理卖出订单超时：撤销后转市价单。
   *
   * @param orderId 订单 ID
   * @param order 追踪订单
   * @returns 无返回值
   */
  async function handleSellOrderTimeout(orderId: string, order: TrackedOrder): Promise<void> {
    const elapsed = Date.now() - order.submittedAt;
    logger.warn(
      `[订单监控] 卖出订单 ${orderId} 超时(${Math.floor(elapsed / 1000)}秒)，转换为市价单`,
    );
    const remainingQuantity = order.submittedQuantity - order.executedQuantity;
    if (remainingQuantity <= 0) {
      runtime.trackedOrders.delete(orderId);
      return;
    }

    try {
      const cancelResult = await cancelOrderWithRuntimeCleanup(orderId);
      if (!cancelResult.cancelled) {
        logger.warn(
          `[订单监控] 卖出订单 ${orderId} 撤销失败（可能已成交或已撤销），跳过市价单提交`,
        );
        return;
      }

      if (!isExecutionAllowed()) {
        logger.info(`[执行门禁] 门禁关闭，卖出订单 ${orderId} 超时转市价单被阻止，原订单已撤销`);
        return;
      }
      const ctx = await ctxPromise;
      if (!isExecutionAllowed()) {
        logger.info(`[执行门禁] 门禁已关闭，卖出订单 ${orderId} 转市价单被阻止，原订单已撤销`);
        return;
      }
      const marketOrderPayload = {
        symbol: order.symbol,
        side: order.side,
        orderType: OrderType.MO,
        submittedQuantity: toDecimal(remainingQuantity),
        timeInForce: TimeInForceType.Day,
        remark: `超时转市价-原订单${orderId}`,
      };
      await rateLimiter.throttle();
      if (!isExecutionAllowed()) {
        logger.info(
          `[执行门禁] 门禁已关闭，卖出订单 ${orderId} 转市价单在提交前被阻止，原订单已撤销`,
        );
        return;
      }
      const resp = await ctx.submitOrder(marketOrderPayload);
      const newOrderId = resolveOrderIdFromSubmitResponse(resp) ?? 'UNKNOWN';
      const direction: 'LONG' | 'SHORT' = order.isLongSymbol ? 'LONG' : 'SHORT';
      const relatedBuyOrderIds =
        cancelResult.cancelledRelatedBuyOrderIds ??
        orderRecorder.allocateRelatedBuyOrderIdsForRecovery(
          order.symbol,
          direction,
          remainingQuantity,
        );
      orderRecorder.submitSellOrder(
        newOrderId,
        order.symbol,
        direction,
        remainingQuantity,
        relatedBuyOrderIds,
      );

      logger.info(
        `[订单监控] 卖出订单 ${orderId} 已转为市价单，新订单ID=${newOrderId}，数量=${remainingQuantity}`,
      );

      trackOrder({
        orderId: newOrderId,
        symbol: order.symbol,
        side: order.side,
        price: 0,
        quantity: remainingQuantity,
        isLongSymbol: order.isLongSymbol,
        monitorSymbol: order.monitorSymbol,
        isProtectiveLiquidation: order.isProtectiveLiquidation,
        orderType: OrderType.MO,
      });
      const newTrackedOrder = runtime.trackedOrders.get(newOrderId);
      if (newTrackedOrder) {
        newTrackedOrder.convertedToMarket = true;
      }
    } catch (err) {
      logger.error(`[订单监控] 卖出订单 ${orderId} 转市价单失败:`, err);
    }
  }

  /**
   * 根据最新行情更新委托价并处理超时逻辑。
   *
   * @param quotesMap 最新行情映射
   * @returns 无返回值
   */
  async function processWithLatestQuotes(
    quotesMap: ReadonlyMap<string, Quote | null>,
  ): Promise<void> {
    const now = Date.now();
    for (const [orderId, order] of runtime.trackedOrders) {
      if (order.convertedToMarket) {
        continue;
      }
      const isBuyOrder = order.side === OrderSide.Buy;
      const timeoutConfig = isBuyOrder ? config.buyTimeout : config.sellTimeout;
      if (timeoutConfig.enabled) {
        const elapsed = now - order.submittedAt;
        if (elapsed >= timeoutConfig.timeoutMs) {
          await (isBuyOrder
            ? handleBuyOrderTimeout(orderId, order)
            : handleSellOrderTimeout(orderId, order));
          continue;
        }
      }

      if (
        NON_REPLACEABLE_ORDER_TYPES.has(order.orderType) ||
        NON_REPLACEABLE_ORDER_STATUSES.has(order.status)
      ) {
        continue;
      }

      if (now - order.lastPriceUpdateAt < config.priceUpdateIntervalMs) {
        continue;
      }
      const quote = quotesMap.get(order.symbol);
      if (!quote || !Number.isFinite(quote.price)) {
        continue;
      }
      const currentPrice = quote.price;
      const normalizedCurrentPriceText = normalizePriceText(currentPrice);
      const normalizedCurrentPriceNumber = Number(normalizedCurrentPriceText);
      const normalizedSubmittedPriceText = normalizePriceText(order.submittedPrice);
      const normalizedSubmittedPriceNumber = Number(normalizedSubmittedPriceText);
      const priceDiffDecimal = calculatePriceDiffDecimal(currentPrice, order.submittedPrice);
      if (priceDiffDecimal.comparedTo(thresholdDecimal) < 0) {
        continue;
      }
      const sideDesc = isBuyOrder ? '买入' : '卖出';
      const priceDirection =
        normalizedCurrentPriceNumber > normalizedSubmittedPriceNumber ? '上涨' : '下跌';
      logger.info(
        `[订单监控] ${sideDesc}订单 ${orderId} 当前价(${normalizedCurrentPriceText}) ` +
          `${priceDirection}，更新委托价：${normalizedSubmittedPriceText} → ${normalizedCurrentPriceText}`,
      );
      try {
        await replaceOrderPrice(orderId, normalizedCurrentPriceNumber);
      } catch (err) {
        logger.error(`[订单监控] 修改订单 ${orderId} 价格失败:`, err);
      }
    }
  }

  /**
   * 获取指定标的的未成交卖单快照。
   *
   * @param symbol 标的代码
   * @returns 卖单快照列表（按 submittedAt 升序）
   */
  function getPendingSellOrders(symbol: string): ReadonlyArray<PendingSellOrderSnapshot> {
    const pendingOrders: PendingSellOrderSnapshot[] = [];
    for (const order of runtime.trackedOrders.values()) {
      if (order.symbol !== symbol) {
        continue;
      }

      if (order.side !== OrderSide.Sell) {
        continue;
      }

      if (!PENDING_ORDER_STATUSES.has(order.status)) {
        continue;
      }
      const remaining = order.submittedQuantity - order.executedQuantity;
      if (!Number.isFinite(remaining) || remaining <= 0) {
        continue;
      }
      pendingOrders.push({
        orderId: order.orderId,
        symbol: order.symbol,
        side: order.side,
        status: order.status,
        orderType: order.orderType,
        submittedPrice: order.submittedPrice,
        submittedQuantity: order.submittedQuantity,
        executedQuantity: order.executedQuantity,
        submittedAt: order.submittedAt,
      });
    }
    return [...pendingOrders].sort((a, b) => a.submittedAt - b.submittedAt);
  }

  return {
    processWithLatestQuotes,
    getPendingSellOrders,
  };
}
