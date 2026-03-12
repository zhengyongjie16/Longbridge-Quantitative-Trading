/**
 * 订单监控模块（WebSocket 推送）
 *
 * 职责：
 * - 组装恢复流、事件流、订单操作流、单订单状态查询与终态结算流程
 * - 初始化 WebSocket 私有主题订阅并分发订单推送
 * - 对外暴露 OrderMonitor 接口，保持原有签名不变
 */
import { TopicType, type PushOrderChanged } from 'longbridge';
import { logger } from '../../../utils/logger/index.js';
import { toDecimal } from '../utils.js';
import type { OrderMonitor, OrderMonitorDeps } from '../types.js';
import type { PendingRefreshSymbol } from '../../../types/services.js';
import type { OrderMonitorRuntimeStore, OrderMonitorTrackedOrder } from './types.js';
import { buildOrderMonitorConfig } from './utils.js';
import { createRecoveryFlow } from './recoveryFlow.js';
import { createEventFlow } from './eventFlow.js';
import { createSettlementFlow } from './settlementFlow.js';
import { createOrderStatusQuery } from './orderStatusQuery.js';
import {
  consumeQueriedTerminalState,
  createOrderOps,
  resetOrderReplaceRuntimeState,
} from './orderOps.js';
import { createQuoteFlow } from './quoteFlow.js';
import type { CancelOrderOutcome } from '../../../types/trader.js';

/**
 * 创建订单监控器。
 *
 * @param deps 依赖（ctxPromise、rateLimiter、cacheManager、orderRecorder、dailyLossTracker、orderHoldRegistry、tradingConfig 等）
 * @returns 实现 OrderMonitor 接口的实例
 */
export function createOrderMonitor(deps: OrderMonitorDeps): OrderMonitor {
  const {
    ctxPromise,
    rateLimiter,
    cacheManager,
    orderRecorder,
    dailyLossTracker,
    orderHoldRegistry,
    liquidationCooldownTracker,
    testHooks,
    tradingConfig,
    symbolRegistry,
    refreshGate,
    isExecutionAllowed,
  } = deps;
  const config = buildOrderMonitorConfig(tradingConfig.global);
  const thresholdDecimal = toDecimal(config.priceDiffThreshold);
  const runtime: OrderMonitorRuntimeStore = {
    trackedOrders: new Map<string, OrderMonitorTrackedOrder>(),
    trackedOrderLifecycles: new Map(),
    pendingRefreshSymbols: [],
    bootstrappingOrderEvents: new Map<string, PushOrderChanged>(),
    closedOrderIds: new Set(),
    queriedTerminalStateByOrderId: new Map(),
    latestReplaceOutcomeByOrderId: new Map(),
    runtimeState: 'BOOTSTRAPPING',
  };
  let initialized = false;

  const settlementFlow = createSettlementFlow({
    runtime,
    orderHoldRegistry,
    orderRecorder,
    dailyLossTracker,
    liquidationCooldownTracker,
    ...(refreshGate ? { refreshGate } : {}),
  });

  const orderStatusQuery = createOrderStatusQuery({
    ctxPromise,
    rateLimiter,
  });

  const orderOps = createOrderOps({
    runtime,
    ctxPromise,
    rateLimiter,
    cacheManager,
    orderHoldRegistry,
    orderStatusQuery,
  });

  let activeHandler: ((event: PushOrderChanged) => void) | null = null;
  const recoveryFlow = createRecoveryFlow({
    runtime,
    orderHoldRegistry,
    orderRecorder,
    tradingConfig,
    symbolRegistry,
    trackOrder: orderOps.trackOrder,
    cancelOrder: orderOps.cancelOrder,
    settleOrder: settlementFlow.settleOrder,
    handleOrderChangedWhenActive: (event) => {
      if (!activeHandler) {
        throw new Error('[订单监控] ACTIVE 事件处理器尚未初始化');
      }

      activeHandler(event);
    },
  });

  const eventFlow = createEventFlow({
    runtime,
    orderRecorder,
    settleOrder: settlementFlow.settleOrder,
    cacheBootstrappingEvent: recoveryFlow.cacheBootstrappingEvent,
  });
  activeHandler = eventFlow.handleOrderChangedWhenActive;

  const quoteFlow = createQuoteFlow({
    runtime,
    config,
    thresholdDecimal,
    orderRecorder,
    ctxPromise,
    rateLimiter,
    isExecutionAllowed,
    trackOrder: orderOps.trackOrder,
    cancelOrder: orderOps.cancelOrder,
    settleOrder: settlementFlow.settleOrder,
    replaceOrderPrice: orderOps.replaceOrderPrice,
  });

  async function cancelOrder(orderId: string): Promise<CancelOrderOutcome> {
    const outcome = await orderOps.cancelOrder(orderId);
    if (outcome.kind !== 'ALREADY_CLOSED') {
      return outcome;
    }

    const trackedOrder = runtime.trackedOrders.get(orderId);
    if (!trackedOrder) {
      resetOrderReplaceRuntimeState(runtime, orderId);
      return outcome;
    }

    const terminalState = consumeQueriedTerminalState(runtime, orderId);
    if (terminalState === null) {
      logger.error(
        `[订单监控] 订单 ${orderId} 已确认终态，但缺少权威终态快照，拒绝向调用方暴露半成品结果`,
      );
      return {
        kind: 'UNKNOWN_FAILURE',
        errorCode: null,
        message: `missing terminal state snapshot for settled cancel order ${orderId}`,
      };
    }

    const alreadySettled = runtime.closedOrderIds.has(orderId);
    const settlementResult = settlementFlow.settleOrder({
      orderId,
      closedReason: terminalState.closedReason,
      source: 'STATE_CHECK',
      executedPrice: terminalState.executedPrice,
      executedQuantity: terminalState.executedQuantity,
      executedTimeMs: terminalState.executedTimeMs,
    });
    resetOrderReplaceRuntimeState(runtime, orderId);
    if (!settlementResult.handled && !alreadySettled) {
      logger.error(
        `[订单监控] 订单 ${orderId} 已确认终态，但本地结算失败，拒绝向调用方暴露未结算结果`,
      );
      return {
        kind: 'UNKNOWN_FAILURE',
        errorCode: null,
        message: `terminal settlement failed for cancel order ${orderId}`,
      };
    }

    return {
      ...outcome,
      relatedBuyOrderIds: settlementResult.relatedBuyOrderIds,
    };
  }

  testHooks?.setHandleOrderChanged?.(eventFlow.handleOrderChanged);

  /**
   * 初始化 WebSocket 订阅（订阅 Private 主题）。
   *
   * @returns 初始化 Promise
   */
  async function initialize(): Promise<void> {
    runtime.runtimeState = 'BOOTSTRAPPING';
    if (initialized) {
      return;
    }

    const ctx = await ctxPromise;
    ctx.setOnOrderChanged((err: Error | null, event: PushOrderChanged) => {
      if (err) {
        logger.error('[订单监控] WebSocket 推送错误:', err.message);
        return;
      }

      eventFlow.handleOrderChanged(event);
    });
    await ctx.subscribe([TopicType.Private]);
    initialized = true;
    logger.info('[订单监控] WebSocket 订阅初始化成功');
  }

  /**
   * 获取并清空待刷新标的列表。
   *
   * @returns 待刷新标的数组
   */
  function getAndClearPendingRefreshSymbols(): PendingRefreshSymbol[] {
    if (runtime.pendingRefreshSymbols.length === 0) {
      return [];
    }

    return runtime.pendingRefreshSymbols.splice(0);
  }

  /**
   * 清空恢复相关运行态与 BOOTSTRAPPING 事件缓存。
   *
   * @returns 无返回值
   */
  function clearTrackedOrders(): void {
    recoveryFlow.resetRecoveryTrackingState();
    recoveryFlow.clearBootstrappingEventBuffer();
    runtime.trackedOrderLifecycles.clear();
    runtime.closedOrderIds.clear();
    runtime.runtimeState = 'BOOTSTRAPPING';
  }

  return {
    initialize,
    trackOrder: orderOps.trackOrder,
    cancelOrder,
    replaceOrderPrice: orderOps.replaceOrderPrice,
    processWithLatestQuotes: quoteFlow.processWithLatestQuotes,
    recoverOrderTrackingFromSnapshot: recoveryFlow.recoverOrderTrackingFromSnapshot,
    getPendingSellOrders: quoteFlow.getPendingSellOrders,
    getAndClearPendingRefreshSymbols,
    clearTrackedOrders,
  };
}
