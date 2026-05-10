/**
 * orderMonitor routeProcessor 模块
 *
 * 职责：
 * - 以单 symbol route 为单位选择本轮唯一可执行动作
 * - 保持 timeout 优先于 replace 的动作语义
 * - 在卖单超时等待终态确认后执行结算与转市价提交
 */
import { OrderSide, OrderType, TimeInForceType } from 'longbridge';
import { logger } from '../../../utils/logger/index.js';
import {
  NON_REPLACEABLE_ORDER_STATUSES,
  NON_REPLACEABLE_ORDER_TYPES,
  ORDER_MONITOR_CANCEL_RETRY_BASE_DELAY_MS,
  ORDER_MONITOR_CANCEL_RETRY_MAX_DELAY_MS,
  ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS,
  ORDER_QUOTE_RETRY,
  TRADING,
} from '../../../constants/index.js';
import type { Quote } from '../../../types/quote.js';
import {
  resolveNextQuoteRetry,
  resolveQuoteReadinessForRequirement,
} from '../../../utils/quoteRetry/index.js';
import { extractOrderId, toDecimal } from '../utils.js';
import { wrapExternalApiRequest } from '../../../utils/apiFailure/index.js';
import type { TrackedOrder } from '../types.js';
import type {
  OrderMonitorTrackedOrder,
  RouteProcessor,
  RouteProcessorDeps,
  RouteRuntimeProcessParams,
  SellTimeoutResolution,
  TerminalClosedReason,
  TerminalSettlementInput,
  TimeoutMarketConversionTerminalState,
} from './types.js';
import {
  consumeLatestReplaceOutcome,
  consumeQueriedTerminalState,
  resetOrderReplaceRuntimeState,
} from './orderOps.js';
import {
  calculatePriceDiffDecimal,
  isClosedStatus,
  isWaitWsOnlyReplaceMode,
  normalizePriceText,
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
    case 'FILLED':
    case 'CANCELED':
    case 'REJECTED': {
      return true;
    }

    default: {
      return false;
    }
  }
}

function resolveTerminalSettlementInput(
  deps: RouteProcessorDeps,
  orderId: string,
  order: TrackedOrder,
  closedReason: TerminalClosedReason,
): TerminalSettlementInput | null {
  const queriedTerminalState = consumeQueriedTerminalState(deps.runtime, orderId);
  const resolvedClosedReason = queriedTerminalState?.closedReason ?? closedReason;
  if (!isSupportedTerminalCloseReason(resolvedClosedReason)) {
    return null;
  }

  return {
    params: {
      orderId,
      closedReason: resolvedClosedReason,
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
  if (queriedExecutedQuantity === null || !Number.isFinite(queriedExecutedQuantity)) {
    return null;
  }

  const remaining = order.submittedQuantity - queriedExecutedQuantity;
  if (!Number.isFinite(remaining)) {
    return null;
  }

  return Math.max(remaining, 0);
}

function canHandleClosedTimeoutRoute(order: OrderMonitorTrackedOrder): boolean {
  return (
    order.side === OrderSide.Sell &&
    order.timeoutMarketConversionPending &&
    order.timeoutMarketConversionTerminalState !== null
  );
}

function canAttemptTimeoutHandling(order: OrderMonitorTrackedOrder, now: number): boolean {
  if (isClosedStatus(order.status) && !canHandleClosedTimeoutRoute(order)) {
    return false;
  }

  if (order.nextCancelAttemptAt > now) {
    return false;
  }

  const remainingQuantity = order.submittedQuantity - order.executedQuantity;
  return remainingQuantity > 0;
}

function clearTimeoutMarketConversionState(order: OrderMonitorTrackedOrder): void {
  order.timeoutMarketConversionPending = false;
  order.timeoutMarketConversionTerminalState = null;
}

function markTimeoutMarketConversionPending(order: OrderMonitorTrackedOrder): void {
  order.timeoutMarketConversionPending = true;
  order.timeoutMarketConversionTerminalState = null;
  pauseCancelRetryAndWaitWs(order);
}

function resolvePendingTimeoutSettlementInput(
  orderId: string,
  terminalState: TimeoutMarketConversionTerminalState,
): TerminalSettlementInput | null {
  if (!isSupportedTerminalCloseReason(terminalState.closedReason)) {
    return null;
  }

  return {
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
}

function resolveSellTimeoutResolution(
  order: OrderMonitorTrackedOrder,
  settlementInput: TerminalSettlementInput,
): SellTimeoutResolution {
  if (settlementInput.params.closedReason === 'FILLED') {
    return {
      kind: 'SETTLE_FILLED',
      settlementInput,
    };
  }

  const marketConversionQuantity = resolveRemainingQuantityForConversion(
    order,
    settlementInput.queriedExecutedQuantity,
  );
  if (marketConversionQuantity === null) {
    return {
      kind: 'WAIT_RETRY',
    };
  }

  if (marketConversionQuantity <= 0) {
    return {
      kind: 'SETTLE_NO_REMAINDER',
      settlementInput,
    };
  }

  return {
    kind: 'SETTLE_AND_CONVERT',
    settlementInput,
    marketConversionQuantity,
  };
}

function compareTrackedOrderPriority(
  left: OrderMonitorTrackedOrder,
  right: OrderMonitorTrackedOrder,
): number {
  if (left.submittedAt !== right.submittedAt) {
    return left.submittedAt - right.submittedAt;
  }

  return left.orderId.localeCompare(right.orderId);
}

function getTrackedOrdersForSymbol(
  deps: RouteProcessorDeps,
  symbol: string,
): ReadonlyArray<OrderMonitorTrackedOrder> {
  const orderIds = deps.runtime.trackedOrderIdsBySymbol.get(symbol);
  if (!orderIds) {
    return [];
  }

  return [...orderIds]
    .map((orderId) => deps.runtime.trackedOrders.get(orderId) ?? null)
    .filter((order): order is OrderMonitorTrackedOrder => order !== null)
    .sort(compareTrackedOrderPriority);
}

/**
 * 判断当前 route pass 的 symbol generation 是否仍然有效。
 *
 * 卖单 timeout -> settlement -> submit MO 会在同一 pass 内短暂出现 route 为空，
 * 因此这里以 symbol generation 为 owner，而不是要求 route state 必然存在。
 */
function isRouteGenerationCurrent(
  runtime: RouteProcessorDeps['runtime'],
  params: Pick<RouteRuntimeProcessParams, 'symbol' | 'generation'>,
): boolean {
  if (!runtime.running) {
    return false;
  }

  return runtime.latestRouteGenerationBySymbol.get(params.symbol) === params.generation;
}

/**
 * 判断某个 tracked order 是否仍然附着在当前 symbol route 上。
 *
 * 该判断用于 await 之后继续写入 tracked order 运行态前的二次确认，
 * 防止旧 continuation 回写已经终态清理或被替换的订单对象。
 */
function isTrackedOrderStillAttachedToRoute(
  runtime: RouteProcessorDeps['runtime'],
  symbol: string,
  order: OrderMonitorTrackedOrder,
): boolean {
  if (runtime.closedOrderIds.has(order.orderId)) {
    return false;
  }

  if (runtime.trackedOrderLifecycles.get(order.orderId) !== 'OPEN') {
    return false;
  }

  const attachedOrder = runtime.trackedOrders.get(order.orderId);
  if (attachedOrder !== order) {
    return false;
  }

  const symbolBucket = runtime.trackedOrderIdsBySymbol.get(symbol);
  return symbolBucket?.has(order.orderId) ?? false;
}

/**
 * 在 broker 已接受 follow-up 市价单后，校验当前 route pass 是否仍允许把结果写回本地真相。
 *
 * 这一步是 timeout market conversion 的最终 guarded commit：
 * - stopAndDrain 后不得再向已停止 runtime 写回新 tracked order / pending sell
 * - generation 变化后，旧 route continuation 不得命中新 route
 *
 * 注意：旧卖单在 settlement 后会被正常移出 tracked route，因此这里不能再要求旧 order 仍 attached。
 * timeout -> settlement -> follow-up submit 的 owner 是当前 symbol generation，而不是旧 order 附着关系。
 *
 * @param params 当前 route generation 快照
 * @param runtime routeProcessor 共享运行态
 * @returns 当前 commit 是否仍然有效
 */
function canCommitTimeoutMarketConversion(
  params: Pick<RouteRuntimeProcessParams, 'symbol' | 'generation'>,
  runtime: RouteProcessorDeps['runtime'],
): boolean {
  return isRouteGenerationCurrent(runtime, params);
}

async function handleBuyOrderTimeout(
  params: RouteRuntimeProcessParams,
  deps: RouteProcessorDeps,
  orderId: string,
  order: OrderMonitorTrackedOrder,
): Promise<boolean> {
  const now = Date.now();
  if (!canAttemptTimeoutHandling(order, now)) {
    return false;
  }

  const outcome = await deps.cancelOrder(orderId);
  if (!isRouteGenerationCurrent(deps.runtime, params)) {
    resetOrderReplaceRuntimeState(deps.runtime, orderId);
    return true;
  }

  if (!isTrackedOrderStillAttachedToRoute(deps.runtime, params.symbol, order)) {
    resetOrderReplaceRuntimeState(deps.runtime, orderId);
    return false;
  }

  if (outcome.kind === 'CANCEL_CONFIRMED') {
    pauseCancelRetryAndWaitWs(order);
    logger.info(`[订单监控] 买入订单 ${orderId} 撤单请求成功，等待 WS 终态`);
    return true;
  }

  if (outcome.kind === 'ALREADY_CLOSED' && isSupportedTerminalCloseReason(outcome.closedReason)) {
    const settlementInput = resolveTerminalSettlementInput(
      deps,
      orderId,
      order,
      outcome.closedReason,
    );
    if (settlementInput === null) {
      applyCancelRetryBackoff(order);
      return true;
    }

    const settlementResult = deps.settleOrder(settlementInput.params);
    resetOrderReplaceRuntimeState(deps.runtime, orderId);
    if (!settlementResult.handled) {
      applyCancelRetryBackoff(order);
      return true;
    }

    logger.info(`[订单监控] 买入订单 ${orderId} 已确认终态=${settlementInput.params.closedReason}`);
    return true;
  }

  applyCancelRetryBackoff(order);
  return true;
}

/**
 * 提交卖单超时后的 follow-up 市价单。
 *
 * 这里要求 old order 的 pending sell 占用在整个异步提交窗口内保持连续：
 * - 进入该函数前，settlementFlow 已把旧卖单占用保留为 follow-up placeholder
 * - 提交前若 route/gate 已失效，则释放 placeholder，避免生成不存在新单的假占用
 * - broker 未接受新单前若提交失败，则释放 placeholder，避免本地残留不存在的卖单占用
 * - 提交成功后先登记新 orderId 的占用，再移除旧 placeholder，保证同一批 buy orders 无空窗
 *
 * @param params 当前 route generation 快照
 * @param deps routeProcessor 依赖
 * @param order 已进入 timeout conversion 的旧卖单
 * @param marketConversionQuantity follow-up 市价单数量
 * @param relatedBuyOrderIds 已由 settlementFlow 保留的连续占用集合
 * @returns 无返回值
 */
async function submitTimeoutMarketOrder(
  params: Pick<RouteRuntimeProcessParams, 'symbol' | 'generation'>,
  deps: RouteProcessorDeps,
  order: OrderMonitorTrackedOrder,
  marketConversionQuantity: number,
  relatedBuyOrderIds: ReadonlyArray<string>,
): Promise<void> {
  if (!isRouteGenerationCurrent(deps.runtime, params)) {
    deps.orderRecorder.markSellCancelled(order.orderId);
    return;
  }

  if (!deps.isExecutionAllowed()) {
    deps.orderRecorder.markSellCancelled(order.orderId);
    logger.info(`[执行门禁] 门禁关闭，卖出订单 ${order.orderId} 超时转市价单被阻止`);
    return;
  }

  let brokerSubmissionAccepted = false;
  let newOrderId: string | null = null;
  try {
    const { ctx } = deps;
    if (!isRouteGenerationCurrent(deps.runtime, params)) {
      deps.orderRecorder.markSellCancelled(order.orderId);
      return;
    }

    if (!deps.isExecutionAllowed()) {
      deps.orderRecorder.markSellCancelled(order.orderId);
      logger.info(`[执行门禁] 门禁已关闭，卖出订单 ${order.orderId} 转市价单被阻止`);
      return;
    }

    let timeoutConversionRemark = `超时转市价-原订单${order.orderId}`;
    if (order.isProtectiveLiquidation) {
      timeoutConversionRemark += TRADING.PROTECTIVE_LIQUIDATION_REMARK_SUFFIX;
    }

    await deps.rateLimiter.throttle();
    if (!isRouteGenerationCurrent(deps.runtime, params)) {
      deps.orderRecorder.markSellCancelled(order.orderId);
      return;
    }

    if (!deps.isExecutionAllowed()) {
      deps.orderRecorder.markSellCancelled(order.orderId);
      logger.info(`[执行门禁] 门禁已关闭，卖出订单 ${order.orderId} 转市价单在提交前被阻止`);
      return;
    }

    const response = await wrapExternalApiRequest({
      operation: 'TradeContext.submitOrder.timeoutMarketConversion',
      request: () =>
        ctx.submitOrder({
          symbol: order.symbol,
          side: order.side,
          orderType: OrderType.MO,
          submittedQuantity: toDecimal(marketConversionQuantity),
          timeInForce: TimeInForceType.Day,
          remark: timeoutConversionRemark,
        }),
      retryConfig: {
        retries: 0,
        delayMs: 0,
      },
    });
    brokerSubmissionAccepted = true;
    newOrderId = extractOrderId(response);
    if (!canCommitTimeoutMarketConversion(params, deps.runtime)) {
      deps.orderRecorder.markSellCancelled(order.orderId);
      throw new Error(`stale timeout market conversion commit: ${newOrderId}`);
    }

    const direction: 'LONG' | 'SHORT' = order.isLongSymbol ? 'LONG' : 'SHORT';
    deps.orderRecorder.submitSellOrder(
      newOrderId,
      order.symbol,
      direction,
      marketConversionQuantity,
      relatedBuyOrderIds,
    );
    deps.orderRecorder.markSellCancelled(order.orderId);

    deps.trackOrder({
      orderId: newOrderId,
      symbol: order.symbol,
      side: order.side,
      price: 0,
      initialSubmittedPrice: 0,
      quantity: marketConversionQuantity,
      isLongSymbol: order.isLongSymbol,
      monitorSymbol: order.monitorSymbol,
      isProtectiveLiquidation: order.isProtectiveLiquidation,
      orderType: OrderType.MO,
      liquidationTriggerLimit: order.liquidationTriggerLimit,
      liquidationCooldownConfig: order.liquidationCooldownConfig,
    });
  } catch (error: unknown) {
    if (!brokerSubmissionAccepted) {
      deps.orderRecorder.markSellCancelled(order.orderId);
      throw error;
    }

    if (newOrderId === null) {
      throw error;
    }

    if (
      error instanceof Error &&
      error.message.startsWith('stale timeout market conversion commit:')
    ) {
      throw error;
    }

    logger.error(
      `[订单监控] 卖出订单 ${order.orderId} 转市价单已提交，但本地同步失败，订单ID=${newOrderId}`,
      error,
    );
    throw new Error(`order submitted but local sync failed: ${newOrderId}`, {
      cause: error,
    });
  }
}

/**
 * 处理卖单超时。
 *
 * 业务顺序固定：
 * 1. 先确认旧卖单是否已进入可转换的终态，且剩余数量明确
 * 2. 由 settlementFlow 结算已成交部分，并决定旧 pending sell 占用是释放还是保留为 follow-up
 * 3. 只有在占用已连续保留后，才允许异步提交新的市价卖单
 *
 * @param params 当前 route pass 上下文
 * @param deps routeProcessor 依赖
 * @param orderId 超时卖单 ID
 * @param order 超时卖单运行态
 * @returns 本轮是否已消费该 timeout owner
 */
async function handleSellOrderTimeout(
  params: RouteRuntimeProcessParams,
  deps: RouteProcessorDeps,
  orderId: string,
  order: OrderMonitorTrackedOrder,
): Promise<boolean> {
  const now = Date.now();
  if (!canAttemptTimeoutHandling(order, now)) {
    return false;
  }

  let settlementInput: TerminalSettlementInput;
  if (order.timeoutMarketConversionPending && order.timeoutMarketConversionTerminalState !== null) {
    const resolvedSettlementInput = resolvePendingTimeoutSettlementInput(
      orderId,
      order.timeoutMarketConversionTerminalState,
    );
    if (resolvedSettlementInput === null) {
      applyCancelRetryBackoff(order);
      return true;
    }

    settlementInput = resolvedSettlementInput;
  } else {
    const outcome = await deps.cancelOrder(orderId);
    if (!isRouteGenerationCurrent(deps.runtime, params)) {
      resetOrderReplaceRuntimeState(deps.runtime, orderId);
      return true;
    }

    if (!isTrackedOrderStillAttachedToRoute(deps.runtime, params.symbol, order)) {
      resetOrderReplaceRuntimeState(deps.runtime, orderId);
      return false;
    }

    if (outcome.kind === 'CANCEL_CONFIRMED') {
      markTimeoutMarketConversionPending(order);
      logger.info(`[订单监控] 卖出订单 ${orderId} 撤单请求成功，等待 WS 非成交终态后再评估`);
      return true;
    }

    if (
      outcome.kind !== 'ALREADY_CLOSED' ||
      !isSupportedTerminalCloseReason(outcome.closedReason)
    ) {
      applyCancelRetryBackoff(order);
      return true;
    }

    const resolvedSettlementInput = resolveTerminalSettlementInput(
      deps,
      orderId,
      order,
      outcome.closedReason,
    );
    if (resolvedSettlementInput === null) {
      applyCancelRetryBackoff(order);
      return true;
    }

    settlementInput = resolvedSettlementInput;
  }

  const timeoutResolution = resolveSellTimeoutResolution(order, settlementInput);
  if (timeoutResolution.kind === 'WAIT_RETRY') {
    applyCancelRetryBackoff(order);
    return true;
  }

  const settlementParams =
    timeoutResolution.kind === 'SETTLE_AND_CONVERT'
      ? {
          ...timeoutResolution.settlementInput.params,
          pendingSellDisposition: {
            kind: 'HANDOFF_TO_FOLLOW_UP_SELL',
            followUpQuantity: timeoutResolution.marketConversionQuantity,
          } as const,
        }
      : timeoutResolution.settlementInput.params;
  const settlementResult = deps.settleOrder(settlementParams);
  resetOrderReplaceRuntimeState(deps.runtime, orderId);
  if (!settlementResult.handled) {
    applyCancelRetryBackoff(order);
    return false;
  }

  clearTimeoutMarketConversionState(order);
  resetCancelRetry(order);

  if (timeoutResolution.kind === 'SETTLE_FILLED') {
    logger.info(`[订单监控] 卖出订单 ${orderId} 已成交，禁止超时转市价`);
    return false;
  }

  if (timeoutResolution.kind === 'SETTLE_NO_REMAINDER') {
    return false;
  }

  if (!isRouteGenerationCurrent(deps.runtime, params)) {
    deps.orderRecorder.markSellCancelled(orderId);
    return true;
  }

  if (settlementResult.relatedBuyOrderIds === null) {
    throw new Error(`[订单监控] 卖出订单 ${orderId} 超时转市价缺少连续占用信息`);
  }

  await submitTimeoutMarketOrder(
    params,
    deps,
    order,
    timeoutResolution.marketConversionQuantity,
    settlementResult.relatedBuyOrderIds,
  );
  return true;
}

function shouldHandleTimeout(deps: RouteProcessorDeps, order: OrderMonitorTrackedOrder): boolean {
  if (order.convertedToMarket || order.orderType === OrderType.MO) {
    return false;
  }

  if (isClosedStatus(order.status) && !canHandleClosedTimeoutRoute(order)) {
    return false;
  }

  const timeoutConfig =
    order.side === OrderSide.Buy ? deps.config.buyTimeout : deps.config.sellTimeout;
  if (!timeoutConfig.enabled) {
    return false;
  }

  return Date.now() - order.submittedAt >= timeoutConfig.timeoutMs;
}

function canEnterReplaceFlow(deps: RouteProcessorDeps, order: OrderMonitorTrackedOrder): boolean {
  if (order.convertedToMarket) {
    return false;
  }

  if (shouldHandleTimeout(deps, order)) {
    return false;
  }

  if (order.nextCancelAttemptAt === ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS) {
    return false;
  }

  if (order.timeoutMarketConversionPending) {
    return false;
  }

  if (
    NON_REPLACEABLE_ORDER_TYPES.has(order.orderType) ||
    NON_REPLACEABLE_ORDER_STATUSES.has(order.status)
  ) {
    return false;
  }

  if (isWaitWsOnlyReplaceMode(order)) {
    return false;
  }

  if (Date.now() - order.lastPriceUpdateAt < deps.config.priceUpdateIntervalMs) {
    return false;
  }

  return true;
}

function shouldReplaceFromQuote(
  latestQuote: Quote,
  deps: RouteProcessorDeps,
  order: OrderMonitorTrackedOrder,
): boolean {
  if (!canEnterReplaceFlow(deps, order)) {
    return false;
  }

  if (latestQuote.symbol !== order.symbol || latestQuote.price <= 0) {
    return false;
  }

  const priceDiffDecimal = calculatePriceDiffDecimal(latestQuote.price, order.submittedPrice);
  if (priceDiffDecimal.comparedTo(deps.thresholdDecimal) < 0) {
    return false;
  }

  if (order.side === OrderSide.Buy && !deps.config.allowBuyOrderTrackingAboveInitialPrice) {
    const normalizedCurrentPriceNumber = Number(normalizePriceText(latestQuote.price));
    const normalizedInitialSubmittedPriceNumber = Number(
      normalizePriceText(order.initialSubmittedPrice),
    );
    if (normalizedCurrentPriceNumber > normalizedInitialSubmittedPriceNumber) {
      return false;
    }
  }

  return true;
}

function shouldRetryReplaceFromTimer(
  latestQuote: Quote,
  deps: RouteProcessorDeps,
  order: OrderMonitorTrackedOrder,
): boolean {
  if (order.replaceCapability !== 'TEMP_BLOCKED_BY_STATUS') {
    return false;
  }

  if (order.replaceResumeMode !== 'TIME_BACKOFF') {
    return false;
  }

  if (order.replaceBlockedUntilAt === null || order.replaceBlockedUntilAt > Date.now()) {
    return false;
  }

  return shouldReplaceFromQuote(latestQuote, deps, order);
}

function shouldReplaceForWakeup(
  params: RouteRuntimeProcessParams,
  latestQuote: Quote,
  deps: RouteProcessorDeps,
  order: OrderMonitorTrackedOrder,
): boolean {
  if (params.wakeupKind === 'QUOTE' || params.wakeupKind === 'ORDER_EVENT') {
    return shouldReplaceFromQuote(latestQuote, deps, order);
  }

  if (params.wakeupKind === 'TIMER') {
    return shouldRetryReplaceFromTimer(latestQuote, deps, order);
  }

  return false;
}

function applyQuoteRetryForUnavailableQuote(order: OrderMonitorTrackedOrder, now: number): void {
  if (order.quoteRetryNextAt !== null && now < order.quoteRetryNextAt) {
    return;
  }

  const nextRetry = resolveNextQuoteRetry({
    attempts: order.quoteRetryAttempts,
    nowMs: now,
    intervalMs: ORDER_QUOTE_RETRY.INTERVAL_MS,
    maxAttempts: ORDER_QUOTE_RETRY.MAX_ATTEMPTS,
  });
  if (nextRetry.exhausted) {
    order.quoteRetryAttempts = nextRetry.nextAttempts;
    order.quoteRetryNextAt = null;
    order.quoteRetryExhausted = true;
    return;
  }

  order.quoteRetryAttempts = nextRetry.nextAttempts;
  order.quoteRetryNextAt = nextRetry.nextRetryAt;
  order.quoteRetryExhausted = false;
}

function resetQuoteRetryState(order: OrderMonitorTrackedOrder): void {
  order.quoteRetryAttempts = 0;
  order.quoteRetryNextAt = null;
  order.quoteRetryExhausted = false;
}

function shouldAdvanceQuoteRetryFromTimer(
  deps: RouteProcessorDeps,
  order: OrderMonitorTrackedOrder,
): boolean {
  if (!canEnterReplaceFlow(deps, order)) {
    return false;
  }

  if (order.quoteRetryNextAt === null || order.quoteRetryNextAt > Date.now()) {
    return false;
  }

  return order.quoteRetryAttempts > 0;
}

export function createRouteProcessor(deps: RouteProcessorDeps): RouteProcessor {
  /**
   * 执行一次 symbol route 的动作选择。
   *
   * 顺序约束：
   * 1. timeout 永远优先于 replace
   * 2. 同一轮 pass 最多只消费一个 timeout/replace owner，然后立即返回
   * 3. quote 不可用时只推进 quote-retry 状态，不做普通 replace
   *
   * @param params 当前 route pass 上下文
   * @returns 无返回值
   */
  async function processRoute(params: RouteRuntimeProcessParams): Promise<void> {
    if (!isRouteGenerationCurrent(deps.runtime, params)) {
      return;
    }

    const trackedOrders = getTrackedOrdersForSymbol(deps, params.symbol);
    for (const order of trackedOrders) {
      if (!shouldHandleTimeout(deps, order)) {
        continue;
      }

      if (order.side === OrderSide.Buy) {
        const handled = await handleBuyOrderTimeout(params, deps, order.orderId, order);
        if (handled) {
          return;
        }

        continue;
      }

      const handled = await handleSellOrderTimeout(params, deps, order.orderId, order);
      if (handled) {
        return;
      }
    }

    const latestQuote = params.latestQuote;
    const quoteReadiness = resolveQuoteReadinessForRequirement({
      quote: latestQuote,
      requirement: 'PRICE',
    });
    if (quoteReadiness !== 'READY') {
      if (quoteReadiness !== 'MISSING') {
        logger.warn(
          `[订单监控] 跟价行情无效，跳过本轮改单: symbol=${params.symbol} readiness=${quoteReadiness}`,
        );
        return;
      }

      const now = Date.now();
      for (const order of trackedOrders) {
        if (params.wakeupKind === 'QUOTE') {
          if (!canEnterReplaceFlow(deps, order)) {
            continue;
          }

          applyQuoteRetryForUnavailableQuote(order, now);
          return;
        }

        if (params.wakeupKind === 'TIMER' && shouldAdvanceQuoteRetryFromTimer(deps, order)) {
          applyQuoteRetryForUnavailableQuote(order, now);
          return;
        }
      }

      return;
    }

    if (latestQuote === null) {
      return;
    }

    for (const order of trackedOrders) {
      if (!isTrackedOrderStillAttachedToRoute(deps.runtime, params.symbol, order)) {
        continue;
      }

      resetQuoteRetryState(order);

      const shouldReplace = shouldReplaceForWakeup(params, latestQuote, deps, order);
      if (!shouldReplace) {
        continue;
      }

      await deps.replaceOrderPrice(order.orderId, latestQuote.price);
      if (!isRouteGenerationCurrent(deps.runtime, params)) {
        resetOrderReplaceRuntimeState(deps.runtime, order.orderId);
        return;
      }

      if (!isTrackedOrderStillAttachedToRoute(deps.runtime, params.symbol, order)) {
        resetOrderReplaceRuntimeState(deps.runtime, order.orderId);
        continue;
      }

      const replaceOutcome = consumeLatestReplaceOutcome(deps.runtime, order.orderId);
      if (replaceOutcome?.kind === 'TERMINAL_CONFIRMED') {
        const terminal = replaceOutcome.terminalState;
        const settlementResult = deps.settleOrder({
          orderId: order.orderId,
          closedReason: terminal.closedReason,
          source: 'STATE_CHECK',
          executedPrice: terminal.executedPrice,
          executedQuantity: terminal.executedQuantity,
          executedTimeMs: terminal.executedTimeMs,
        });
        resetOrderReplaceRuntimeState(deps.runtime, order.orderId);
        if (!settlementResult.handled) {
          logger.warn(`[订单监控] 订单 ${order.orderId} 改单失败后确认终态，但结算未执行`);
        }
      }

      return;
    }
  }

  return {
    processRoute,
  };
}
