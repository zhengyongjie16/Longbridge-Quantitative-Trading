/**
 * orderMonitor 行情驱动流程模块
 *
 * 职责：
 * - 处理买卖订单超时（outcome 驱动）
 * - 基于最新行情执行委托价跟踪与改单
 * - 调度 closeSyncQueue 定向对账
 */
import { OrderSide, OrderType, TimeInForceType } from 'longport';
import { logger } from '../../../utils/logger/index.js';
import {
  NON_REPLACEABLE_ORDER_STATUSES,
  NON_REPLACEABLE_ORDER_TYPES,
  PENDING_ORDER_STATUSES,
  TRADING,
} from '../../../constants/index.js';
import type { Quote } from '../../../types/quote.js';
import type { CancelOrderOutcome } from '../../../types/trader.js';
import { isConfirmedNonFilledClose, toDecimal } from '../utils.js';
import type { PendingSellOrderSnapshot, TrackedOrder } from '../types.js';
import type { QuoteFlow, QuoteFlowDeps } from './types.js';
import {
  calculatePriceDiffDecimal,
  normalizePriceText,
  resolveOrderIdFromSubmitResponse,
} from './utils.js';

const CANCEL_RETRY_BASE_DELAY_MS = 1000;
const CANCEL_RETRY_MAX_DELAY_MS = 30_000;

function resolveCancelRetryDelayMs(retryCount: number): number {
  const delay = CANCEL_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryCount - 1);
  return Math.min(delay, CANCEL_RETRY_MAX_DELAY_MS);
}

function shouldStopTimeoutConversion(outcome: CancelOrderOutcome): boolean {
  return outcome.kind === 'ALREADY_CLOSED' && outcome.closedReason === 'FILLED';
}

function resolveRelatedBuyOrderIdsFromOutcome(
  outcome: CancelOrderOutcome,
): ReadonlyArray<string> | null {
  if (outcome.kind === 'CANCEL_CONFIRMED' || outcome.kind === 'ALREADY_CLOSED') {
    return outcome.relatedBuyOrderIds;
  }

  return null;
}

function applyCancelRetryBackoff(order: TrackedOrder): void {
  order.cancelRetryCount += 1;
  order.nextCancelAttemptAt = Date.now() + resolveCancelRetryDelayMs(order.cancelRetryCount);
}

function resetCancelRetry(order: TrackedOrder): void {
  order.cancelRetryCount = 0;
  order.nextCancelAttemptAt = Date.now();
}

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
    cancelOrderWithOutcome,
    processCloseSyncQueue,
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
    const now = Date.now();
    if (order.nextCancelAttemptAt > now) {
      return;
    }

    const elapsed = now - order.submittedAt;
    const remainingQuantity = order.submittedQuantity - order.executedQuantity;
    if (remainingQuantity <= 0) {
      return;
    }

    logger.warn(`[订单监控] 买入订单 ${orderId} 超时(${Math.floor(elapsed / 1000)}秒)，尝试撤销`);

    const outcome = await cancelOrder(orderId);
    if (outcome.kind === 'CANCEL_CONFIRMED') {
      resetCancelRetry(order);
      logger.info(`[订单监控] 买入订单 ${orderId} 已撤销，剩余未成交数量=${remainingQuantity}`);
      return;
    }

    if (outcome.kind === 'ALREADY_CLOSED') {
      if (outcome.closedReason === 'FILLED') {
        logger.info(`[订单监控] 买入订单 ${orderId} 已成交，等待成交同步收口`);
      } else if (outcome.closedReason === 'NOT_FOUND') {
        logger.warn(`[订单监控] 买入订单 ${orderId} 处于 NOT_FOUND 对账流程，暂不清理追踪`);
      } else {
        logger.info(`[订单监控] 买入订单 ${orderId} 已关闭，关闭原因=${outcome.closedReason}`);
      }

      applyCancelRetryBackoff(order);
      return;
    }

    applyCancelRetryBackoff(order);
    logger.warn(
      `[订单监控] 买入订单 ${orderId} 撤销失败 kind=${outcome.kind}` +
        `，下次重试时间=${new Date(order.nextCancelAttemptAt).toISOString()}`,
    );
  }

  /**
   * 处理卖出订单超时：确认非成交终态后转市价单。
   *
   * @param orderId 订单 ID
   * @param order 追踪订单
   * @returns 无返回值
   */
  async function handleSellOrderTimeout(orderId: string, order: TrackedOrder): Promise<void> {
    const now = Date.now();
    if (order.nextCancelAttemptAt > now) {
      return;
    }

    const elapsed = now - order.submittedAt;
    const remainingQuantity = order.submittedQuantity - order.executedQuantity;
    if (remainingQuantity <= 0) {
      return;
    }

    logger.warn(
      `[订单监控] 卖出订单 ${orderId} 超时(${Math.floor(elapsed / 1000)}秒)，评估是否转市价单`,
    );

    const outcome = await cancelOrderWithOutcome(orderId);
    if (shouldStopTimeoutConversion(outcome)) {
      resetCancelRetry(order);
      logger.info(`[订单监控] 卖出订单 ${orderId} 已成交，禁止超时转市价`);
      return;
    }

    if (!isConfirmedNonFilledClose(outcome)) {
      applyCancelRetryBackoff(order);
      logger.warn(
        `[订单监控] 卖出订单 ${orderId} 未确认可转换终态，kind=${outcome.kind}` +
          `，下次重试时间=${new Date(order.nextCancelAttemptAt).toISOString()}`,
      );
      return;
    }

    resetCancelRetry(order);

    if (!isExecutionAllowed()) {
      logger.info(`[执行门禁] 门禁关闭，卖出订单 ${orderId} 超时转市价单被阻止`);
      return;
    }

    try {
      const ctx = await ctxPromise;
      if (!isExecutionAllowed()) {
        logger.info(`[执行门禁] 门禁已关闭，卖出订单 ${orderId} 转市价单被阻止`);
        return;
      }

      let timeoutConversionRemark = `超时转市价-原订单${orderId}`;
      if (order.isProtectiveLiquidation) {
        timeoutConversionRemark += TRADING.PROTECTIVE_LIQUIDATION_REMARK_SUFFIX;
      }

      const marketOrderPayload = {
        symbol: order.symbol,
        side: order.side,
        orderType: OrderType.MO,
        submittedQuantity: toDecimal(remainingQuantity),
        timeInForce: TimeInForceType.Day,
        remark: timeoutConversionRemark,
      };
      await rateLimiter.throttle();
      if (!isExecutionAllowed()) {
        logger.info(`[执行门禁] 门禁已关闭，卖出订单 ${orderId} 转市价单在提交前被阻止`);
        return;
      }

      if (order.executedQuantity > 0 && resolveRelatedBuyOrderIdsFromOutcome(outcome) === null) {
        await processCloseSyncQueue();
      }

      const response = await ctx.submitOrder(marketOrderPayload);
      const newOrderId = resolveOrderIdFromSubmitResponse(response) ?? 'UNKNOWN';
      const direction: 'LONG' | 'SHORT' = order.isLongSymbol ? 'LONG' : 'SHORT';
      const relatedBuyOrderIds =
        resolveRelatedBuyOrderIdsFromOutcome(outcome) ??
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
        liquidationTriggerLimit: order.liquidationTriggerLimit,
        liquidationCooldownConfig: order.liquidationCooldownConfig,
      });
      const newTrackedOrder = runtime.trackedOrders.get(newOrderId);
      if (newTrackedOrder) {
        newTrackedOrder.convertedToMarket = true;
      }
    } catch (error) {
      logger.error(`[订单监控] 卖出订单 ${orderId} 转市价单失败`, error);
      applyCancelRetryBackoff(order);
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
    await processCloseSyncQueue();

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
      logger.debug(
        `[订单监控] ${sideDesc}订单 ${orderId} 当前价(${normalizedCurrentPriceText}) ` +
          `${priceDirection}，更新委托价：${normalizedSubmittedPriceText} → ${normalizedCurrentPriceText}`,
      );
      await replaceOrderPrice(orderId, normalizedCurrentPriceNumber);
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
      if (order.symbol !== symbol || order.side !== OrderSide.Sell) {
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
