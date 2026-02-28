/**
 * orderMonitor 恢复流程模块
 *
 * 职责：
 * - 管理 BOOTSTRAPPING 阶段订单事件缓存与回放
 * - 执行快照恢复、席位一致性校验与失败回滚
 * - 保证 trackedOrders 与 pendingSell 占用集合的一致性
 */
import { OrderSide, type PushOrderChanged } from 'longport';
import { logger } from '../../../utils/logger/index.js';
import { decimalToNumber, isValidPositiveNumber } from '../../../utils/helpers/index.js';
import { PENDING_ORDER_STATUSES } from '../../../constants/index.js';
import type { RawOrderFromAPI } from '../../../types/services.js';
import { resolveOrderOwnership } from '../../orderRecorder/orderOwnershipParser.js';
import { isSeatReady } from '../../../services/autoSymbolManager/utils.js';
import type {
  OrderSeatOwnership,
  RecoverySnapshotReconciliationParams,
  TrackOrderParams,
} from '../types.js';
import type { RecoveryFlow, RecoveryFlowDeps } from './types.js';
import { resolveSubmittedAtMs, resolveUpdatedAtMs } from './utils.js';

/**
 * 创建恢复流程处理器。
 *
 * @param deps 恢复流程依赖
 * @returns 恢复流程接口
 */
export function createRecoveryFlow(deps: RecoveryFlowDeps): RecoveryFlow {
  const {
    runtime,
    orderHoldRegistry,
    orderRecorder,
    tradingConfig,
    symbolRegistry,
    trackOrder,
    cancelOrder,
    handleOrderChangedWhenActive,
  } = deps;

  /**
   * 基于订单名称映射解析监控标的与方向。
   *
   * @param order 原始订单
   * @returns 归属信息，无法解析返回 null
   */
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

  /**
   * 校验订单是否与当前席位一致。
   *
   * @param order 原始订单
   * @param ownership 订单归属
   * @returns true 表示席位匹配
   */
  function isSeatMatchedForOrder(order: RawOrderFromAPI, ownership: OrderSeatOwnership): boolean {
    const seatState = symbolRegistry.getSeatState(ownership.monitorSymbol, ownership.direction);
    if (!isSeatReady(seatState)) {
      return false;
    }
    return seatState.symbol === order.symbol;
  }

  /**
   * 清空所有 pendingSell 运行态占用。
   *
   * @returns 无返回值
   */
  function clearAllPendingSellTracking(): void {
    const pendingSellSnapshot = orderRecorder.getPendingSellSnapshot();
    for (const pendingSell of pendingSellSnapshot) {
      orderRecorder.markSellCancelled(pendingSell.orderId);
    }
  }

  /**
   * 重置恢复运行态（trackedOrders/pendingSell/refreshQueue）。
   *
   * @returns 无返回值
   */
  function resetRecoveryTrackingState(): void {
    for (const trackedOrder of runtime.trackedOrders.values()) {
      orderHoldRegistry.markOrderClosed(trackedOrder.orderId);
    }
    runtime.trackedOrders.clear();
    runtime.pendingRefreshSymbols.length = 0;
    clearAllPendingSellTracking();
  }

  /**
   * 清空 BOOTSTRAPPING 阶段事件缓存。
   *
   * @returns 无返回值
   */
  function clearBootstrappingEventBuffer(): void {
    runtime.bootstrappingOrderEvents.clear();
  }

  /**
   * 在 BOOTSTRAPPING 期间缓存每个 orderId 的最新事件。
   *
   * @param event 订单推送事件
   * @returns 无返回值
   */
  function cacheBootstrappingEvent(event: PushOrderChanged): void {
    const current = runtime.bootstrappingOrderEvents.get(event.orderId);
    if (!current) {
      runtime.bootstrappingOrderEvents.set(event.orderId, event);
      return;
    }
    const currentUpdatedAt = resolveUpdatedAtMs(current.updatedAt);
    const nextUpdatedAt = resolveUpdatedAtMs(event.updatedAt);
    if (currentUpdatedAt !== null && nextUpdatedAt !== null && nextUpdatedAt >= currentUpdatedAt) {
      runtime.bootstrappingOrderEvents.set(event.orderId, event);
      return;
    }
    if (currentUpdatedAt === null && nextUpdatedAt !== null) {
      runtime.bootstrappingOrderEvents.set(event.orderId, event);
      return;
    }
    if (currentUpdatedAt === null && nextUpdatedAt === null) {
      runtime.bootstrappingOrderEvents.set(event.orderId, event);
    }
  }

  /**
   * 按更新时间回放 BOOTSTRAPPING 阶段缓存的最新订单事件。
   *
   * @returns 本轮回放的订单 ID 集合
   */
  function replayBootstrappingEvents(): ReadonlySet<string> {
    if (runtime.bootstrappingOrderEvents.size === 0) {
      return new Set<string>();
    }
    const replayEvents = [...runtime.bootstrappingOrderEvents.values()];
    replayEvents.sort((left, right) => {
      const leftMs = resolveUpdatedAtMs(left.updatedAt) ?? 0;
      const rightMs = resolveUpdatedAtMs(right.updatedAt) ?? 0;
      return leftMs - rightMs;
    });
    runtime.bootstrappingOrderEvents.clear();
    const replayedOrderIds = new Set<string>();
    for (const event of replayEvents) {
      replayedOrderIds.add(event.orderId);
      handleOrderChangedWhenActive(event);
    }
    return replayedOrderIds;
  }

  /**
   * 校验 tracked 卖单与 pendingSell 占用集合一致性。
   *
   * @returns 无返回值，发现不一致直接抛错
   */
  function assertPendingSellConsistency(): void {
    const pendingSellSnapshot = orderRecorder.getPendingSellSnapshot();
    const pendingSellOrderIds = new Set<string>();
    for (const pendingSell of pendingSellSnapshot) {
      pendingSellOrderIds.add(pendingSell.orderId);
    }

    const trackedSellOrderIds = new Set<string>();
    for (const trackedOrder of runtime.trackedOrders.values()) {
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
   * 快照恢复后执行对账校验。
   *
   * @param params 对账参数
   * @returns 无返回值，发现不一致直接抛错
   */
  function assertRecoverySnapshotReconciliation(
    params: RecoverySnapshotReconciliationParams,
  ): void {
    const { allOrders, cancelledMismatchedBuyOrderIds, replayedOrderIds } = params;
    const trackedOrderIds = new Set<string>();
    const nonPendingTrackedOrderIds: string[] = [];
    for (const trackedOrder of runtime.trackedOrders.values()) {
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
   * 恢复单笔 pending 订单追踪，并在卖单场景恢复 pendingSell 占用关系。
   *
   * @param order 原始订单
   * @param ownership 订单归属
   * @returns 无返回值
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
    const trackedOrder = runtime.trackedOrders.get(order.orderId);
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
   * 基于快照恢复未完成订单追踪（严格模式）。
   *
   * @param allOrders 全量订单快照
   * @returns 无返回值
   */
  async function recoverOrderTrackingFromSnapshot(
    allOrders: ReadonlyArray<RawOrderFromAPI>,
  ): Promise<void> {
    runtime.runtimeState = 'BOOTSTRAPPING';
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
      runtime.runtimeState = 'ACTIVE';
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

  return {
    cacheBootstrappingEvent,
    clearBootstrappingEventBuffer,
    resetRecoveryTrackingState,
    replayBootstrappingEvents,
    recoverOrderTrackingFromSnapshot,
  };
}
