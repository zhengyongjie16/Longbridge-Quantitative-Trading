/**
 * orderMonitor 行情驱动流程模块
 *
 * 职责：
 * - 处理买卖订单超时、撤单重试与改单结果消费
 * - 基于最新行情执行委托价跟踪与改单
 * - 在必要时消费单订单权威终态并驱动结算
 */
import { OrderSide, OrderStatus, OrderType, TimeInForceType } from 'longbridge';
import { logger } from '../../../utils/logger/index.js';
import {
  NON_REPLACEABLE_ORDER_STATUSES,
  NON_REPLACEABLE_ORDER_TYPES,
  ORDER_MONITOR_CANCEL_RETRY_BASE_DELAY_MS,
  ORDER_MONITOR_CANCEL_RETRY_MAX_DELAY_MS,
  ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS,
  PENDING_ORDER_STATUSES,
  TRADING,
} from '../../../constants/index.js';
import type { Quote } from '../../../types/quote.js';
import type { CancelOrderOutcome } from '../../../types/trader.js';
import { toDecimal } from '../utils.js';
import type { PendingSellOrderSnapshot, TrackedOrder } from '../types.js';
import type {
  OrderMonitorTrackedOrder,
  QuoteFlow,
  QuoteFlowDeps,
  TerminalClosedReason,
  TerminalSettlementInput,
} from './types.js';
import {
  consumeLatestReplaceOutcome,
  consumeQueriedTerminalState,
  resetOrderReplaceRuntimeState,
} from './orderOps.js';
import {
  calculatePriceDiffDecimal,
  isWaitWsOnlyReplaceMode,
  normalizePriceText,
  resolveOrderIdFromSubmitResponse,
} from './utils.js';

function resolveCancelRetryDelayMs(retryCount: number): number {
  const delay = ORDER_MONITOR_CANCEL_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryCount - 1);
  return Math.min(delay, ORDER_MONITOR_CANCEL_RETRY_MAX_DELAY_MS);
}

function applyCancelRetryBackoff(order: TrackedOrder): void {
  order.cancelRetryCount += 1;
  order.nextCancelAttemptAt = Date.now() + resolveCancelRetryDelayMs(order.cancelRetryCount);
}

function resetCancelRetry(order: TrackedOrder): void {
  order.cancelRetryCount = 0;
  order.nextCancelAttemptAt = Date.now();
}

function pauseCancelRetryAndWaitWs(order: TrackedOrder): void {
  order.cancelRetryCount = 0;
  order.nextCancelAttemptAt = ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS;
}

function isSupportedTerminalCloseReason(
  closedReason: string,
): closedReason is TerminalClosedReason {
  switch (closedReason) {
    case 'FILLED': {
      return true;
    }

    case 'CANCELED': {
      return true;
    }

    case 'REJECTED': {
      return true;
    }

    default: {
      return false;
    }
  }
}

function resolveTerminalSettlementInput(
  runtime: QuoteFlowDeps['runtime'],
  orderId: string,
  order: TrackedOrder,
  outcome: CancelOrderOutcome,
): TerminalSettlementInput | null {
  if (outcome.kind !== 'ALREADY_CLOSED' || !isSupportedTerminalCloseReason(outcome.closedReason)) {
    return null;
  }

  const queriedTerminalState = consumeQueriedTerminalState(runtime, orderId);
  const closedReason = queriedTerminalState?.closedReason ?? outcome.closedReason;
  if (!isSupportedTerminalCloseReason(closedReason)) {
    return null;
  }

  return {
    params: {
      orderId,
      closedReason,
      source: 'API',
      executedPrice: queriedTerminalState?.executedPrice ?? order.executedPrice ?? null,
      executedQuantity: queriedTerminalState?.executedQuantity ?? order.executedQuantity,
      executedTimeMs: queriedTerminalState?.executedTimeMs ?? order.lastExecutedTimeMs ?? null,
    },
    queriedExecutedQuantity: queriedTerminalState?.executedQuantity ?? null,
  };
}

function resolveRemainingQuantityForConversion(
  order: TrackedOrder,
  queriedExecutedQuantity: number | null,
): number | null {
  if (!Number.isFinite(queriedExecutedQuantity) || queriedExecutedQuantity === null) {
    return null;
  }

  const remaining = order.submittedQuantity - queriedExecutedQuantity;
  if (!Number.isFinite(remaining)) {
    return null;
  }

  return Math.max(remaining, 0);
}

function clearTimeoutMarketConversionState(order: OrderMonitorTrackedOrder): void {
  order.timeoutMarketConversionPending = false;
  order.timeoutMarketConversionTerminalState = null;
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
    replaceOrderPrice,
    settleOrder,
  } = deps;

  /**
   * 处理买入订单超时：仅撤销，不转市价。
   *
   * @param orderId 订单 ID
   * @param order 追踪订单
   * @returns 无返回值
   */
  async function handleBuyOrderTimeout(
    orderId: string,
    order: OrderMonitorTrackedOrder,
  ): Promise<void> {
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
      pauseCancelRetryAndWaitWs(order);
      logger.info(`[订单监控] 买入订单 ${orderId} 撤单请求成功，等待 WS 终态`);
      return;
    }

    if (outcome.kind === 'ALREADY_CLOSED' && isSupportedTerminalCloseReason(outcome.closedReason)) {
      const settlementInput = resolveTerminalSettlementInput(runtime, orderId, order, outcome);
      if (settlementInput === null) {
        applyCancelRetryBackoff(order);
        return;
      }

      const result = settleOrder(settlementInput.params);
      resetOrderReplaceRuntimeState(runtime, orderId);
      if (!result.handled) {
        applyCancelRetryBackoff(order);
        return;
      }

      logger.info(
        `[订单监控] 买入订单 ${orderId} 已确认终态=${settlementInput.params.closedReason}`,
      );
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
  async function handleSellOrderTimeout(
    orderId: string,
    order: OrderMonitorTrackedOrder,
  ): Promise<void> {
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

    let settlementInput: TerminalSettlementInput;
    if (
      order.timeoutMarketConversionPending &&
      order.timeoutMarketConversionTerminalState !== null
    ) {
      const terminalState = order.timeoutMarketConversionTerminalState;
      if (!isSupportedTerminalCloseReason(terminalState.closedReason)) {
        applyCancelRetryBackoff(order);
        return;
      }

      settlementInput = {
        params: {
          orderId,
          closedReason: terminalState.closedReason,
          source: terminalState.source,
          executedPrice: terminalState.executedPrice,
          executedQuantity: terminalState.executedQuantity,
          executedTimeMs: terminalState.executedTimeMs,
        },
        queriedExecutedQuantity: terminalState.executedQuantity,
      };
    } else {
      const outcome = await cancelOrder(orderId);
      if (outcome.kind === 'CANCEL_CONFIRMED') {
        order.timeoutMarketConversionPending = true;
        order.timeoutMarketConversionTerminalState = null;
        pauseCancelRetryAndWaitWs(order);
        logger.info(`[订单监控] 卖出订单 ${orderId} 撤单请求成功，等待 WS 非成交终态后再评估`);
        return;
      }

      if (
        outcome.kind !== 'ALREADY_CLOSED' ||
        !isSupportedTerminalCloseReason(outcome.closedReason)
      ) {
        applyCancelRetryBackoff(order);
        logger.warn(
          `[订单监控] 卖出订单 ${orderId} 未确认可转换终态，kind=${outcome.kind}` +
            `，下次重试时间=${new Date(order.nextCancelAttemptAt).toISOString()}`,
        );
        return;
      }

      const resolvedSettlementInput = resolveTerminalSettlementInput(
        runtime,
        orderId,
        order,
        outcome,
      );
      if (resolvedSettlementInput === null) {
        applyCancelRetryBackoff(order);
        return;
      }

      settlementInput = resolvedSettlementInput;
    }

    const settlementResult = settleOrder(settlementInput.params);
    resetOrderReplaceRuntimeState(runtime, orderId);
    if (!settlementResult.handled) {
      applyCancelRetryBackoff(order);
      return;
    }

    clearTimeoutMarketConversionState(order);
    resetCancelRetry(order);

    if (settlementInput.params.closedReason === 'FILLED') {
      logger.info(`[订单监控] 卖出订单 ${orderId} 已成交，禁止超时转市价`);
      return;
    }

    const marketConversionQuantity = resolveRemainingQuantityForConversion(
      order,
      settlementInput.queriedExecutedQuantity,
    );
    if (marketConversionQuantity === null) {
      logger.warn(`[订单监控] 卖出订单 ${orderId} 已确认非成交终态，但剩余数量不明确，禁止转市价`);
      return;
    }

    if (marketConversionQuantity <= 0) {
      logger.info(`[订单监控] 卖出订单 ${orderId} 已无可转市价剩余数量`);
      return;
    }

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
        submittedQuantity: toDecimal(marketConversionQuantity),
        timeInForce: TimeInForceType.Day,
        remark: timeoutConversionRemark,
      };
      await rateLimiter.throttle();
      if (!isExecutionAllowed()) {
        logger.info(`[执行门禁] 门禁已关闭，卖出订单 ${orderId} 转市价单在提交前被阻止`);
        return;
      }

      const response = await ctx.submitOrder(marketOrderPayload);
      const newOrderId = resolveOrderIdFromSubmitResponse(response) ?? 'UNKNOWN';
      const direction: 'LONG' | 'SHORT' = order.isLongSymbol ? 'LONG' : 'SHORT';
      const relatedBuyOrderIds =
        settlementResult.relatedBuyOrderIds ??
        orderRecorder.allocateRelatedBuyOrderIdsForRecovery(
          order.symbol,
          direction,
          marketConversionQuantity,
        );
      orderRecorder.submitSellOrder(
        newOrderId,
        order.symbol,
        direction,
        marketConversionQuantity,
        relatedBuyOrderIds,
      );

      logger.info(
        `[订单监控] 卖出订单 ${orderId} 已转为市价单，新订单ID=${newOrderId}，数量=${marketConversionQuantity}`,
      );

      trackOrder({
        orderId: newOrderId,
        symbol: order.symbol,
        side: order.side,
        price: 0,
        quantity: marketConversionQuantity,
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

      if (isWaitWsOnlyReplaceMode(order)) {
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
      const replaceOutcome = consumeLatestReplaceOutcome(runtime, orderId);
      if (replaceOutcome?.kind !== 'TERMINAL_CONFIRMED') {
        continue;
      }

      const terminal = replaceOutcome.terminalState;
      const settlementResult = settleOrder({
        orderId,
        closedReason: terminal.closedReason,
        source: 'STATE_CHECK',
        executedPrice: terminal.executedPrice,
        executedQuantity: terminal.executedQuantity,
        executedTimeMs: terminal.executedTimeMs,
      });
      resetOrderReplaceRuntimeState(runtime, orderId);
      if (!settlementResult.handled) {
        logger.warn(`[订单监控] 订单 ${orderId} 改单失败后确认终态，但结算未执行`);
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
      if (order.symbol !== symbol || order.side !== OrderSide.Sell) {
        continue;
      }

      if (!PENDING_ORDER_STATUSES.has(order.status)) {
        continue;
      }

      if (order.status === OrderStatus.PartialWithdrawal) {
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
