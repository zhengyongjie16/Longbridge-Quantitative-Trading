/**
 * 订单监控模块（WebSocket 推送）
 *
 * 职责：
 * - WebSocket 订阅订单状态变化，实时响应成交/撤销/拒绝
 * - 价格跟踪：委托价跟随最新市价，确保订单能够成交
 * - 成交后更新：使用实际成交价更新本地订单记录
 * - 程序重启恢复：自动恢复追踪未完成订单
 *
 * 超时策略：
 * - 买入超时：仅撤销订单（避免追高）
 * - 卖出超时：撤销后转市价单（确保平仓）
 */
import {
  OrderStatus,
  OrderSide,
  OrderType,
  TimeInForceType,
  TopicType,
  type PushOrderChanged,
} from 'longport';
import { logger } from '../../utils/logger/index.js';
import { decimalToNumber, isValidPositiveNumber } from '../../utils/helpers/index.js';
import { isRecord } from '../../utils/primitives/index.js';
import {
  DEFAULT_PRICE_DECIMALS,
  NON_REPLACEABLE_ORDER_STATUSES,
  NON_REPLACEABLE_ORDER_TYPES,
  ORDER_PRICE_DIFF_THRESHOLD,
  PENDING_ORDER_STATUSES,
} from '../../constants/index.js';
import type { Quote } from '../../types/quote.js';
import type { GlobalConfig } from '../../types/config.js';
import type { PendingRefreshSymbol, RawOrderFromAPI } from '../../types/services.js';
import { resolveOrderOwnership } from '../orderRecorder/orderOwnershipParser.js';
import { isSeatReady } from '../../services/autoSymbolManager/utils.js';
import { toDecimal } from './utils.js';
import type {
  CancelOrderResult,
  OrderMonitor,
  OrderMonitorDeps,
  OrderMonitorRuntimeState,
  OrderSeatOwnership,
  TrackedOrder,
  OrderMonitorConfig,
  PendingSellOrderSnapshot,
  RecoverySnapshotReconciliationParams,
  TrackOrderParams,
} from './types.js';
import { recordTrade } from './tradeLogger.js';
import { formatError } from '../../utils/error/index.js';
import { toHongKongTimeIso } from '../../utils/time/index.js';
/**
 * 根据订单方向和席位方向解析信号动作（用于成交日志与本地记录）
 * @param side 订单方向 Buy/Sell
 * @param isLongSymbol 是否为做多标的（牛证/做多）
 * @returns 对应的信号动作 BUYCALL | BUYPUT | SELLCALL | SELLPUT
 */
function resolveSignalAction(
  side: OrderSide,
  isLongSymbol: boolean,
): 'BUYCALL' | 'BUYPUT' | 'SELLCALL' | 'SELLPUT' {
  if (side === OrderSide.Buy) {
    return isLongSymbol ? 'BUYCALL' : 'BUYPUT';
  }
  return isLongSymbol ? 'SELLCALL' : 'SELLPUT';
}
/**
 * 构建订单监控配置（将全局配置中的秒转换为毫秒，供超时与价格更新间隔使用）
 * @param globalConfig 全局配置，含买入/卖出超时秒数及价格更新间隔
 * @returns 订单监控所需配置（超时与间隔均为毫秒）
 */
function buildOrderMonitorConfig(globalConfig: GlobalConfig): OrderMonitorConfig {
  return {
    buyTimeout: {
      enabled: globalConfig.buyOrderTimeout.enabled,
      timeoutMs: globalConfig.buyOrderTimeout.timeoutSeconds * 1000,
    },
    sellTimeout: {
      enabled: globalConfig.sellOrderTimeout.enabled,
      timeoutMs: globalConfig.sellOrderTimeout.timeoutSeconds * 1000,
    },
    priceUpdateIntervalMs: globalConfig.orderMonitorPriceUpdateInterval * 1000,
    priceDiffThreshold: ORDER_PRICE_DIFF_THRESHOLD, // 固定值，不需要配置
  };
}
/**
 * 解析订单更新时间为毫秒时间戳（兼容 Date、number、ISO 字符串）
 * @param updatedAt SDK 推送或 API 返回的 updatedAt 字段
 * @returns 毫秒时间戳，无法解析时返回 null
 */
function resolveUpdatedAtMs(updatedAt: unknown): number | null {
  if (updatedAt instanceof Date) {
    return updatedAt.getTime();
  }
  if (typeof updatedAt === 'number') {
    return updatedAt;
  }
  if (typeof updatedAt === 'string' && updatedAt.trim()) {
    const parsed = Date.parse(updatedAt);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}
/**
 * 解析订单 submittedAt 为毫秒时间戳（兼容 Date、number、ISO 字符串）
 * @param submittedAt SDK 推送或 API 返回的 submittedAt 字段
 * @returns 毫秒时间戳，无法解析时返回 null
 */
function resolveSubmittedAtMs(submittedAt: unknown): number | null {
  if (submittedAt instanceof Date) {
    return submittedAt.getTime();
  }
  if (typeof submittedAt === 'number') {
    return submittedAt;
  }
  if (typeof submittedAt === 'string' && submittedAt.trim()) {
    const parsed = Date.parse(submittedAt);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}
/**
 * 判断是否为关闭状态（成交/撤销/拒绝）
 * @param status 订单状态
 * @returns 关闭状态返回 true
 */
function isClosedStatus(status: OrderStatus): boolean {
  return (
    status === OrderStatus.Filled ||
    status === OrderStatus.Canceled ||
    status === OrderStatus.Rejected
  );
}
/**
 * 解析追踪订单初始状态。
 * 默认行为：仅接受 pending 状态；缺失或非 pending 一律回退为 New。
 * @param initialStatus 可选初始状态（恢复链路传入）
 * @returns 可用于 trackedOrders 的初始状态
 */
function resolveInitialTrackedStatus(initialStatus?: OrderStatus): OrderStatus {
  if (initialStatus === undefined) {
    return OrderStatus.New;
  }
  if (!PENDING_ORDER_STATUSES.has(initialStatus)) {
    return OrderStatus.New;
  }
  return initialStatus;
}
/**
 * 从提交订单响应中提取订单 ID。
 * @param response submitOrder 返回值
 * @returns 订单ID，缺失时返回 null
 */
function resolveOrderIdFromSubmitResponse(response: unknown): string | null {
  if (!isRecord(response)) {
    return null;
  }
  const orderId = response['orderId'];
  return typeof orderId === 'string' && orderId.length > 0 ? orderId : null;
}
/** 价格标准化为固定小数位文本（与日志与阈值比较保持一致口径） */
function normalizePriceText(price: number): string {
  return price.toFixed(DEFAULT_PRICE_DECIMALS);
}
/** 基于原始价格计算差值（Decimal），避免比较阶段被四舍五入放大/缩小 */
function calculatePriceDiffDecimal(currentPrice: number, submittedPrice: number) {
  const currentPriceDecimal = toDecimal(currentPrice);
  const submittedPriceDecimal = toDecimal(submittedPrice);
  return currentPriceDecimal.sub(submittedPriceDecimal).abs();
}
/**
 * 创建订单监控器。
 * 订阅 WebSocket 订单推送、维护追踪订单列表、委托价跟随市价更新、超时转市价/撤单，成交后更新本地订单记录与浮亏刷新列表。
 * 订单状态与价格需实时响应，与 orderRecorder、dailyLossTracker、liquidationCooldownTracker 联动，统一在此处处理推送与副作用。
 * @param deps 依赖（ctxPromise、rateLimiter、cacheManager、orderRecorder、dailyLossTracker、orderHoldRegistry、tradingConfig 等）
 * @returns 实现 OrderMonitor 接口的实例（trackOrder、processWithLatestQuotes、cancelOrder、replaceOrderPrice 等）
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
  // 追踪中的订单
  const trackedOrders = new Map<string, TrackedOrder>();
  // 待刷新浮亏数据的标的列表（订单成交后添加，主循环中处理后清空）
  const pendingRefreshSymbols: PendingRefreshSymbol[] = [];
  // 启动/重建恢复期状态机：BOOTSTRAPPING 期间仅缓存事件，恢复完成后切换 ACTIVE
  const bootstrappingOrderEvents = new Map<string, PushOrderChanged>();
  let runtimeState: OrderMonitorRuntimeState = 'BOOTSTRAPPING';
  let initialized = false;
  /** 基于订单名称映射解析监控标的与方向（禁止默认方向） */
  function resolveOrderSeatOwnership(order: RawOrderFromAPI): OrderSeatOwnership | null {
    const resolved = resolveOrderOwnership(order, tradingConfig.monitors);
    if (!resolved) {
      return null;
    }
    return {
      monitorSymbol: resolved.monitorSymbol,
      direction: resolved.direction,
      isLongSymbol: resolved.direction === 'LONG',
    };
  }
  /** 校验订单是否与当前席位一致（方向 + READY + symbol 均匹配） */
  function isSeatMatchedForOrder(order: RawOrderFromAPI, ownership: OrderSeatOwnership): boolean {
    const seatState = symbolRegistry.getSeatState(ownership.monitorSymbol, ownership.direction);
    if (!isSeatReady(seatState)) {
      return false;
    }
    return seatState.symbol === order.symbol;
  }
  /** 在 BOOTSTRAPPING 期间缓存每个 orderId 的最新事件 */
  function cacheBootstrappingEvent(event: PushOrderChanged): void {
    const current = bootstrappingOrderEvents.get(event.orderId);
    if (!current) {
      bootstrappingOrderEvents.set(event.orderId, event);
      return;
    }
    const currentUpdatedAt = resolveUpdatedAtMs(current.updatedAt);
    const nextUpdatedAt = resolveUpdatedAtMs(event.updatedAt);
    if (currentUpdatedAt !== null && nextUpdatedAt !== null && nextUpdatedAt >= currentUpdatedAt) {
      bootstrappingOrderEvents.set(event.orderId, event);
      return;
    }
    if (currentUpdatedAt === null && nextUpdatedAt !== null) {
      bootstrappingOrderEvents.set(event.orderId, event);
      return;
    }
    if (currentUpdatedAt === null && nextUpdatedAt === null) {
      bootstrappingOrderEvents.set(event.orderId, event);
    }
  }
  /**
   * 处理 WebSocket 订单状态变化（ACTIVE）
   * 完全成交时用成交价更新本地记录，部分成交时继续追踪
   */
  function handleOrderChangedWhenActive(event: PushOrderChanged): void {
    const orderId = event.orderId;
    const trackedOrder = trackedOrders.get(orderId);
    if (!trackedOrder) {
      if (isClosedStatus(event.status)) {
        orderHoldRegistry.markOrderClosed(orderId);
      }
      return;
    }
    trackedOrder.status = event.status;
    const executedQuantity = decimalToNumber(event.executedQuantity);
    trackedOrder.executedQuantity = executedQuantity || 0;
    if (event.status === OrderStatus.Filled) {
      orderHoldRegistry.markOrderClosed(orderId);
      const executedPrice = decimalToNumber(event.executedPrice);
      const filledQuantity = decimalToNumber(event.executedQuantity);
      if (isValidPositiveNumber(executedPrice) && isValidPositiveNumber(filledQuantity)) {
        const executedTimeMs = resolveUpdatedAtMs(event.updatedAt);
        if (executedTimeMs === null) {
          logger.error(`[订单监控] 订单 ${orderId} 成交时间缺失，无法更新订单记录`);
          trackedOrders.delete(orderId);
          return;
        }
        if (trackedOrder.side === OrderSide.Buy) {
          orderRecorder.recordLocalBuy(
            trackedOrder.symbol,
            executedPrice,
            filledQuantity,
            trackedOrder.isLongSymbol,
            executedTimeMs,
          );
        } else {
          orderRecorder.recordLocalSell(
            trackedOrder.symbol,
            executedPrice,
            filledQuantity,
            trackedOrder.isLongSymbol,
            executedTimeMs,
            orderId,
          );
          orderRecorder.markSellFilled(orderId);
        }
        if (trackedOrder.monitorSymbol) {
          dailyLossTracker.recordFilledOrder({
            monitorSymbol: trackedOrder.monitorSymbol,
            symbol: trackedOrder.symbol,
            isLongSymbol: trackedOrder.isLongSymbol,
            side: trackedOrder.side,
            executedPrice,
            executedQuantity: filledQuantity,
            executedTimeMs,
            orderId,
          });
        }
        if (trackedOrder.isProtectiveLiquidation) {
          const direction = trackedOrder.isLongSymbol ? 'LONG' : 'SHORT';
          if (trackedOrder.monitorSymbol) {
            liquidationCooldownTracker.recordCooldown({
              symbol: trackedOrder.monitorSymbol,
              direction,
              executedTimeMs,
            });
          } else {
            logger.error(`[订单监控] 订单 ${orderId} 缺少监控标的代码，无法记录清仓冷却`);
          }
        }
        const signalAction = resolveSignalAction(trackedOrder.side, trackedOrder.isLongSymbol);
        const executedAt = toHongKongTimeIso(new Date(executedTimeMs));
        recordTrade({
          orderId,
          symbol: trackedOrder.symbol,
          symbolName: null,
          monitorSymbol: trackedOrder.monitorSymbol,
          action: signalAction,
          side: trackedOrder.side === OrderSide.Buy ? 'BUY' : 'SELL',
          quantity: String(filledQuantity),
          price: String(executedPrice),
          orderType: null,
          status: 'FILLED',
          error: null,
          reason: null,
          signalTriggerTime: null,
          executedAt,
          executedAtMs: executedTimeMs,
          timestamp: null,
          isProtectiveClearance: trackedOrder.isProtectiveLiquidation,
        });
        logger.info(
          `[订单监控] 订单 ${orderId} 完全成交，` +
            `成交价=${executedPrice.toFixed(3)}，成交数量=${filledQuantity}，` +
            '已更新本地订单记录',
        );
        refreshGate?.markStale();
        pendingRefreshSymbols.push({
          symbol: trackedOrder.symbol,
          isLongSymbol: trackedOrder.isLongSymbol,
          refreshAccount: true,
          refreshPositions: true,
        });
      } else {
        const executedPriceText = event.executedPrice?.toString() ?? 'null';
        const executedQuantityText = event.executedQuantity.toString();
        logger.warn(
          `[订单监控] 订单 ${orderId} 成交数据无效，` +
            `executedPrice=${executedPriceText}，executedQuantity=${executedQuantityText}`,
        );
      }
      trackedOrders.delete(orderId);
      return;
    }
    if (event.status === OrderStatus.Canceled || event.status === OrderStatus.Rejected) {
      orderHoldRegistry.markOrderClosed(orderId);
      if (trackedOrder.side === OrderSide.Sell) {
        orderRecorder.markSellCancelled(orderId);
      }
      trackedOrders.delete(orderId);
      logger.info(`[订单监控] 订单 ${orderId} 状态变为 ${event.status}，停止追踪`);
      return;
    }
    if (event.status === OrderStatus.PartialFilled) {
      if (trackedOrder.side === OrderSide.Sell) {
        orderRecorder.markSellPartialFilled(orderId, executedQuantity);
      }
      logger.info(
        `[订单监控] 订单 ${orderId} 部分成交，` +
          `已成交=${trackedOrder.executedQuantity}/${trackedOrder.submittedQuantity}，` +
          '等待完全成交后更新本地记录',
      );
    }
  }
  /** 清空所有 pendingSell 运行态占用，保证恢复可重复执行 */
  function clearAllPendingSellTracking(): void {
    const pendingSellSnapshot = orderRecorder.getPendingSellSnapshot();
    for (const pendingSell of pendingSellSnapshot) {
      orderRecorder.markSellCancelled(pendingSell.orderId);
    }
  }
  /** 重置恢复运行态（trackedOrders/pendingSell/refreshQueue），不触碰 BOOTSTRAPPING 事件缓存 */
  function resetRecoveryTrackingState(): void {
    for (const trackedOrder of trackedOrders.values()) {
      orderHoldRegistry.markOrderClosed(trackedOrder.orderId);
    }
    trackedOrders.clear();
    pendingRefreshSymbols.length = 0;
    clearAllPendingSellTracking();
  }
  /** 清空 BOOTSTRAPPING 阶段事件缓存 */
  function clearBootstrappingEventBuffer(): void {
    bootstrappingOrderEvents.clear();
  }
  /** 按更新时间回放 BOOTSTRAPPING 阶段缓存的最新订单事件 */
  function replayBootstrappingEvents(): ReadonlySet<string> {
    if (bootstrappingOrderEvents.size === 0) {
      return new Set<string>();
    }
    const replayEvents = [...bootstrappingOrderEvents.values()];
    replayEvents.sort((left, right) => {
      const leftMs = resolveUpdatedAtMs(left.updatedAt) ?? 0;
      const rightMs = resolveUpdatedAtMs(right.updatedAt) ?? 0;
      return leftMs - rightMs;
    });
    bootstrappingOrderEvents.clear();
    const replayedOrderIds = new Set<string>();
    for (const event of replayEvents) {
      replayedOrderIds.add(event.orderId);
      handleOrderChangedWhenActive(event);
    }
    return replayedOrderIds;
  }
  /** 校验跟踪卖单与 pendingSell 占用集合一致性，发现孤儿状态立即失败 */
  function assertPendingSellConsistency(): void {
    const pendingSellSnapshot = orderRecorder.getPendingSellSnapshot();
    const pendingSellOrderIds = new Set<string>();
    for (const pendingSell of pendingSellSnapshot) {
      pendingSellOrderIds.add(pendingSell.orderId);
    }
    const trackedSellOrderIds = new Set<string>();
    for (const trackedOrder of trackedOrders.values()) {
      if (trackedOrder.side !== OrderSide.Sell) {
        continue;
      }
      if (!PENDING_ORDER_STATUSES.has(trackedOrder.status)) {
        continue;
      }
      trackedSellOrderIds.add(trackedOrder.orderId);
    }
    const orphanTrackedOrders = [...trackedSellOrderIds].filter(
      (orderId) => !pendingSellOrderIds.has(orderId),
    );
    const orphanPendingSells = [...pendingSellOrderIds].filter(
      (orderId) => !trackedSellOrderIds.has(orderId),
    );
    if (orphanTrackedOrders.length === 0 && orphanPendingSells.length === 0) {
      return;
    }
    const orphanTrackedText = orphanTrackedOrders.join(', ') || 'none';
    const orphanPendingText = orphanPendingSells.join(', ') || 'none';
    throw new Error(
      `[订单监控] 恢复一致性校验失败: orphanTracked=[${orphanTrackedText}] orphanPending=[${orphanPendingText}]`,
    );
  }
  /**
   * 恢复回放后对账：
   * - trackedOrders 仅允许 pending 状态
   * - trackedOrders 不得出现快照外且不在回放集中的订单
   * - 快照中的 pending 订单必须被跟踪，或已在本轮撤销不匹配买单，或已由回放事件推进状态
   */
  function assertRecoverySnapshotReconciliation(
    params: RecoverySnapshotReconciliationParams,
  ): void {
    const { allOrders, cancelledMismatchedBuyOrderIds, replayedOrderIds } = params;
    const trackedOrderIds = new Set<string>();
    const nonPendingTrackedOrderIds: string[] = [];
    for (const trackedOrder of trackedOrders.values()) {
      trackedOrderIds.add(trackedOrder.orderId);
      if (!PENDING_ORDER_STATUSES.has(trackedOrder.status)) {
        nonPendingTrackedOrderIds.push(trackedOrder.orderId);
      }
    }
    if (nonPendingTrackedOrderIds.length > 0) {
      throw new Error(
        `[订单监控] 恢复对账失败: trackedNonPending=[${nonPendingTrackedOrderIds.join(', ')}]`,
      );
    }
    const snapshotPendingOrderIds = new Set<string>();
    for (const order of allOrders) {
      if (PENDING_ORDER_STATUSES.has(order.status)) {
        snapshotPendingOrderIds.add(order.orderId);
      }
    }
    const unexpectedTrackedOrderIds = [...trackedOrderIds].filter((orderId) => {
      if (snapshotPendingOrderIds.has(orderId)) {
        return false;
      }
      return !replayedOrderIds.has(orderId);
    });
    const missingTrackedOrderIds = [...snapshotPendingOrderIds].filter((orderId) => {
      if (trackedOrderIds.has(orderId)) {
        return false;
      }
      if (cancelledMismatchedBuyOrderIds.has(orderId)) {
        return false;
      }
      return !replayedOrderIds.has(orderId);
    });
    if (unexpectedTrackedOrderIds.length === 0 && missingTrackedOrderIds.length === 0) {
      return;
    }
    const unexpectedText = unexpectedTrackedOrderIds.join(', ') || 'none';
    const missingText = missingTrackedOrderIds.join(', ') || 'none';
    throw new Error(
      `[订单监控] 恢复对账失败: unexpectedTracked=[${unexpectedText}] missingTracked=[${missingText}]`,
    );
  }
  /**
   * 处理 WebSocket 订单状态变化
   * BOOTSTRAPPING：仅缓存最新事件；ACTIVE：实时更新订单状态
   */
  function handleOrderChanged(event: PushOrderChanged): void {
    if (runtimeState === 'BOOTSTRAPPING') {
      cacheBootstrappingEvent(event);
      return;
    }
    handleOrderChangedWhenActive(event);
  }
  testHooks?.setHandleOrderChanged?.(handleOrderChanged);
  /** 初始化 WebSocket 订阅（订阅 Private 主题） */
  async function initialize(): Promise<void> {
    runtimeState = 'BOOTSTRAPPING';
    if (initialized) {
      return;
    }
    const ctx = await ctxPromise;
    // 设置订单变化回调（回调签名包含 err 和 event 两个参数）
    ctx.setOnOrderChanged((err: Error | null, event: PushOrderChanged) => {
      if (err) {
        logger.error('[订单监控] WebSocket 推送错误:', err.message);
        return;
      }
      handleOrderChanged(event);
    });
    // 订阅私有通知
    await ctx.subscribe([TopicType.Private]);
    initialized = true;
    logger.info('[订单监控] WebSocket 订阅初始化成功');
  }
  /** 开始追踪订单（订单提交后调用） */
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
    trackedOrders.set(orderId, order);
    logger.info(
      `[订单监控] 开始追踪订单 ${orderId}，` +
        `标的=${symbol}，方向=${side === OrderSide.Buy ? '买入' : '卖出'}，` +
        `${isLongSymbol ? '做多' : '做空'}标的`,
    );
  }
  /**
   * 从 allOrders 快照恢复单笔未完成订单追踪（匹配席位时）
   * - 统一恢复 trackedOrders
   * - 卖单同步恢复 pendingSells 占用关系
   */
  function restorePendingOrderTracking(
    order: RawOrderFromAPI,
    ownership: OrderSeatOwnership,
  ): void {
    const submittedQuantity = decimalToNumber(order.quantity);
    if (!isValidPositiveNumber(submittedQuantity)) {
      throw new Error(`[订单监控] 订单 ${order.orderId} 委托数量无效，无法恢复追踪`);
    }
    const trackedPriceRaw = decimalToNumber(order.price);
    const trackedPrice = isValidPositiveNumber(trackedPriceRaw) ? trackedPriceRaw : 0;
    const submittedAtMs = resolveSubmittedAtMs(order.submittedAt);
    const executedQuantity = decimalToNumber(order.executedQuantity);
    const trackOrderParams: TrackOrderParams = {
      orderId: order.orderId,
      symbol: order.symbol,
      side: order.side,
      price: trackedPrice,
      quantity: submittedQuantity,
      ...(submittedAtMs === null ? {} : { submittedAtMs }),
      initialStatus: order.status,
      isLongSymbol: ownership.isLongSymbol,
      monitorSymbol: ownership.monitorSymbol,
      isProtectiveLiquidation: false,
      orderType: order.orderType,
    };
    trackOrder(trackOrderParams);
    const trackedOrder = trackedOrders.get(order.orderId);
    if (trackedOrder && executedQuantity > 0) {
      trackedOrder.executedQuantity = executedQuantity;
      logger.debug(`[订单监控] 恢复部分成交订单 ${order.orderId}，已成交数量=${executedQuantity}`);
    }
    if (order.side === OrderSide.Sell) {
      const relatedBuyOrderIds = orderRecorder.allocateRelatedBuyOrderIdsForRecovery(
        order.symbol,
        ownership.direction,
        submittedQuantity,
      );
      orderRecorder.submitSellOrder(
        order.orderId,
        order.symbol,
        ownership.direction,
        submittedQuantity,
        relatedBuyOrderIds,
        submittedAtMs ?? undefined,
      );
      if (executedQuantity > 0) {
        orderRecorder.markSellPartialFilled(order.orderId, executedQuantity);
      }
    }
  }
  /**
   * 基于快照恢复未完成订单追踪。
   * 规则：
   * - 卖单：必须可解析归属且匹配当前席位，否则 fail-fast
   * - 买单：归属不匹配或无法解析时立即撤单，撤单失败 fail-fast
   */
  async function recoverOrderTrackingFromSnapshot(
    allOrders: ReadonlyArray<RawOrderFromAPI>,
  ): Promise<void> {
    runtimeState = 'BOOTSTRAPPING';
    resetRecoveryTrackingState();
    let recoveredCount = 0;
    const cancelledMismatchedBuyOrderIds = new Set<string>();
    try {
      for (const order of allOrders) {
        if (!PENDING_ORDER_STATUSES.has(order.status)) {
          continue;
        }
        const ownership = resolveOrderSeatOwnership(order);
        const isMatched = ownership ? isSeatMatchedForOrder(order, ownership) : false;
        if (order.side === OrderSide.Sell) {
          if (!ownership) {
            throw new Error(`[订单监控] 卖单 ${order.orderId} 无法解析归属，阻断恢复`);
          }
          if (!isMatched) {
            throw new Error(`[订单监控] 卖单 ${order.orderId} 与当前席位不匹配，阻断恢复`);
          }
          restorePendingOrderTracking(order, ownership);
          recoveredCount += 1;
          continue;
        }
        if (order.side === OrderSide.Buy) {
          if (!ownership || !isMatched) {
            const cancelled = await cancelOrder(order.orderId);
            if (!cancelled) {
              throw new Error(`[订单监控] 买单 ${order.orderId} 不匹配且撤单失败，阻断恢复`);
            }
            cancelledMismatchedBuyOrderIds.add(order.orderId);
            continue;
          }
          restorePendingOrderTracking(order, ownership);
          recoveredCount += 1;
        }
      }
      const replayedOrderIds = replayBootstrappingEvents();
      assertPendingSellConsistency();
      assertRecoverySnapshotReconciliation({
        allOrders,
        cancelledMismatchedBuyOrderIds,
        replayedOrderIds,
      });
      runtimeState = 'ACTIVE';
      const cancelledMismatchedBuyCount = cancelledMismatchedBuyOrderIds.size;
      if (recoveredCount > 0 || cancelledMismatchedBuyCount > 0) {
        logger.info(
          `[订单监控] 快照恢复完成：恢复追踪=${recoveredCount}，撤销不匹配买单=${cancelledMismatchedBuyCount}`,
        );
      }
    } catch (error) {
      resetRecoveryTrackingState();
      throw error;
    }
  }
  /**
   * 撤销订单并执行运行态清理。
   * - 清理 trackedOrders / holdRegistry
   * - 对卖单返回已取消记录的关联买单 ID（用于后续转市价单复用）
   */
  async function cancelOrderWithRuntimeCleanup(orderId: string): Promise<CancelOrderResult> {
    const ctx = await ctxPromise;
    try {
      await rateLimiter.throttle();
      await ctx.cancelOrder(orderId);
      const trackedOrder = trackedOrders.get(orderId);
      let cancelledRelatedBuyOrderIds: ReadonlyArray<string> | null = null;
      cacheManager.clearCache();
      trackedOrders.delete(orderId);
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
  /** 撤销订单 */
  async function cancelOrder(orderId: string): Promise<boolean> {
    const cancelResult = await cancelOrderWithRuntimeCleanup(orderId);
    return cancelResult.cancelled;
  }
  /** 修改订单委托价格 */
  async function replaceOrderPrice(
    orderId: string,
    newPrice: number,
    quantity: number | null = null,
  ): Promise<void> {
    const ctx = await ctxPromise;
    const trackedOrder = trackedOrders.get(orderId);
    if (!trackedOrder) {
      logger.warn(`[订单修改] 订单 ${orderId} 未在追踪列表中`);
      return;
    }
    // 计算剩余数量
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
  /** 处理买入订单超时：仅撤销（避免追高） */
  async function handleBuyOrderTimeout(orderId: string, order: TrackedOrder): Promise<void> {
    const elapsed = Date.now() - order.submittedAt;
    logger.warn(`[订单监控] 买入订单 ${orderId} 超时(${Math.floor(elapsed / 1000)}秒)，撤销订单`);
    // 计算剩余数量
    const remainingQuantity = order.submittedQuantity - order.executedQuantity;
    if (remainingQuantity <= 0) {
      // 已经全部成交，移除追踪
      trackedOrders.delete(orderId);
      return;
    }
    const cancelled = await cancelOrder(orderId);
    if (cancelled) {
      logger.info(`[订单监控] 买入订单 ${orderId} 已撤销，剩余未成交数量=${remainingQuantity}`);
    } else {
      logger.warn(`[订单监控] 买入订单 ${orderId} 撤销失败（可能已成交或已撤销）`);
    }
  }
  /** 处理卖出订单超时：撤销后转市价单（确保平仓） */
  async function handleSellOrderTimeout(orderId: string, order: TrackedOrder): Promise<void> {
    const elapsed = Date.now() - order.submittedAt;
    logger.warn(
      `[订单监控] 卖出订单 ${orderId} 超时(${Math.floor(elapsed / 1000)}秒)，转换为市价单`,
    );
    // 计算剩余数量
    const remainingQuantity = order.submittedQuantity - order.executedQuantity;
    if (remainingQuantity <= 0) {
      // 已经全部成交，移除追踪
      trackedOrders.delete(orderId);
      return;
    }
    try {
      // 1. 撤销原订单
      const cancelResult = await cancelOrderWithRuntimeCleanup(orderId);
      // 如果撤销失败（订单可能已成交或已撤销），不继续提交市价单
      // 避免重复下单导致持仓数据错误
      if (!cancelResult.cancelled) {
        logger.warn(
          `[订单监控] 卖出订单 ${orderId} 撤销失败（可能已成交或已撤销），跳过市价单提交`,
        );
        return;
      }
      // 门禁检查：禁止在门禁关闭时发起新开单（撤销已执行，仅阻止市价单提交）
      if (!isExecutionAllowed()) {
        logger.info(`[执行门禁] 门禁关闭，卖出订单 ${orderId} 超时转市价单被阻止，原订单已撤销`);
        return;
      }
      // 2. 撤销成功后，使用市价单重新提交
      const ctx = await ctxPromise;
      // 二次门禁检查（await 后状态可能变化）
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
      // 追踪新的市价单（市价单通常很快成交，但仍需追踪）
      // 继承原订单的 isLongSymbol，确保成交后能正确更新本地记录
      trackOrder({
        orderId: newOrderId,
        symbol: order.symbol,
        side: order.side,
        price: 0, // 市价单无价格
        quantity: remainingQuantity,
        isLongSymbol: order.isLongSymbol, // 继承原订单的做多/做空标识
        monitorSymbol: order.monitorSymbol,
        isProtectiveLiquidation: order.isProtectiveLiquidation,
        orderType: OrderType.MO,
      });
      // 标记新订单已转换为市价单（避免再次转换）
      const newTrackedOrder = trackedOrders.get(newOrderId);
      if (newTrackedOrder) {
        newTrackedOrder.convertedToMarket = true;
      }
    } catch (err) {
      logger.error(`[订单监控] 卖出订单 ${orderId} 转市价单失败:`, err);
    }
  }
  /**
   * 根据最新行情更新委托价（主循环每秒调用）
   * 委托价跟随市价变化，确保订单能够成交
   */
  async function processWithLatestQuotes(
    quotesMap: ReadonlyMap<string, Quote | null>,
  ): Promise<void> {
    const now = Date.now();
    for (const [orderId, order] of trackedOrders) {
      // 跳过已转为市价单的订单
      if (order.convertedToMarket) {
        continue;
      }
      // 根据订单方向检查超时
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
      // 检查是否在修改间隔内
      if (now - order.lastPriceUpdateAt < config.priceUpdateIntervalMs) {
        continue;
      }
      // 获取最新行情
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
      // 价格差异小于阈值，不修改
      if (priceDiffDecimal.comparedTo(thresholdDecimal) < 0) {
        continue;
      }
      // 更新委托价
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
  /** 获取指定标的的未成交卖单快照 */
  function getPendingSellOrders(symbol: string): ReadonlyArray<PendingSellOrderSnapshot> {
    const pendingOrders: PendingSellOrderSnapshot[] = [];
    for (const order of trackedOrders.values()) {
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
  /** 获取并清空待刷新标的列表（订单成交后需刷新持仓和浮亏） */
  function getAndClearPendingRefreshSymbols(): PendingRefreshSymbol[] {
    if (pendingRefreshSymbols.length === 0) {
      return [];
    }
    return pendingRefreshSymbols.splice(0);
  }
  /** 清空恢复相关运行态（tracked/pendingSell/refreshQueue）与 BOOTSTRAPPING 事件缓存 */
  function clearTrackedOrders(): void {
    resetRecoveryTrackingState();
    clearBootstrappingEventBuffer();
    runtimeState = 'BOOTSTRAPPING';
  }
  return {
    initialize,
    trackOrder,
    cancelOrder,
    replaceOrderPrice,
    processWithLatestQuotes,
    recoverOrderTrackingFromSnapshot,
    getPendingSellOrders,
    getAndClearPendingRefreshSymbols,
    clearTrackedOrders,
  };
}
