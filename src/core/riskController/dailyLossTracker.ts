/**
 * 当日亏损追踪器：
 * - 按监控标的与方向累计已实现亏损偏移
 * - 基于当日成交订单与过滤算法计算未平仓买入成本
 */
import { OrderSide, OrderStatus } from 'longport';
import { logger } from '../../utils/logger/index.js';
import type { MonitorConfig, OrderRecord, RawOrderFromAPI } from '../../types/index.js';
import type {
  DailyLossFilledOrderInput,
  DailyLossState,
  DailyLossTracker,
  DailyLossTrackerDeps,
} from './types.js';
import { collectOrderOwnershipDiagnostics, resolveHongKongDayKey, sumOrderCost } from './utils.js';

/**
 * 构建空状态，避免分支重复初始化。
 */
function createEmptyState(): DailyLossState {
  return {
    buyOrders: [],
    sellOrders: [],
    dailyLossOffset: 0,
  };
}

/**
 * 计算当日盈亏偏移：
 * realizedPnL = totalSell - (totalBuy - openBuyCost)
 * 正值表示当日盈利，负值表示当日亏损。
 */
function calculateLossOffsetFromRecords(
  buyOrders: ReadonlyArray<OrderRecord>,
  sellOrders: ReadonlyArray<OrderRecord>,
  filteringEngine: DailyLossTrackerDeps['filteringEngine'],
): number {
  if (buyOrders.length === 0 && sellOrders.length === 0) {
    return 0;
  }
  const totalBuy = sumOrderCost(buyOrders);
  const totalSell = sumOrderCost(sellOrders);
  if (totalBuy === 0 && totalSell === 0) {
    return 0;
  }
  const openBuyOrders = buyOrders.length > 0
    ? filteringEngine.applyFilteringAlgorithm([...buyOrders], [...sellOrders])
    : [];
  const openBuyCost = sumOrderCost(openBuyOrders);
  return totalSell - totalBuy + openBuyCost;
}

/**
 * 将订单列表转换为当日状态并计算亏损偏移。
 */
function buildStateFromOrders(
  orders: ReadonlyArray<RawOrderFromAPI>,
  deps: Pick<DailyLossTrackerDeps, 'filteringEngine' | 'classifyAndConvertOrders'>,
): DailyLossState {
  const { buyOrders, sellOrders } = deps.classifyAndConvertOrders(orders);
  const dailyLossOffset = calculateLossOffsetFromRecords(
    buyOrders,
    sellOrders,
    deps.filteringEngine,
  );
  return {
    buyOrders,
    sellOrders,
    dailyLossOffset,
  };
}

/**
 * 将成交回报转换为订单记录，若数据不完整则返回 null。
 */
function createOrderRecordFromFill(input: DailyLossFilledOrderInput): OrderRecord | null {
  const executedPrice = Number(input.executedPrice);
  const executedQuantity = Number(input.executedQuantity);
  const executedTime = Number(input.executedTimeMs);
  if (
    !Number.isFinite(executedPrice) ||
    executedPrice <= 0 ||
    !Number.isFinite(executedQuantity) ||
    executedQuantity <= 0 ||
    !Number.isFinite(executedTime) ||
    executedTime <= 0
  ) {
    return null;
  }
  return {
    orderId: input.orderId ?? `${input.symbol}-${executedTime}`,
    symbol: input.symbol,
    executedPrice,
    executedQuantity,
    executedTime,
    submittedAt: undefined,
    updatedAt: new Date(executedTime),
  };
}

/**
 * 创建当日亏损追踪器实例，按监控标的与方向维护状态。
 */
export function createDailyLossTracker(deps: DailyLossTrackerDeps): DailyLossTracker {
  let dayKey: string | null = null;
  const statesByMonitor = new Map<string, { long: DailyLossState; short: DailyLossState }>();

  /**
   * 显式重置 dayKey 与 states。
   */
  function resetAll(now: Date): void {
    const nextKey = resolveHongKongDayKey(deps.toHongKongTimeIso, now);
    dayKey = nextKey;
    statesByMonitor.clear();
  }

  /**
   * 启动时根据历史成交订单初始化当日状态。
   */
  function initializeFromOrders(
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'>>,
    now: Date,
  ): void {
    const nextKey = resolveHongKongDayKey(deps.toHongKongTimeIso, now);
    dayKey = nextKey;
    statesByMonitor.clear();
    if (!nextKey) {
      return;
    }

    const grouped = new Map<string, { long: RawOrderFromAPI[]; short: RawOrderFromAPI[] }>();
    for (const order of allOrders) {
      if (order.status !== OrderStatus.Filled) {
        continue;
      }
      if (!(order.updatedAt instanceof Date)) {
        continue;
      }
      const orderDayKey = resolveHongKongDayKey(deps.toHongKongTimeIso, order.updatedAt);
      if (!orderDayKey || orderDayKey !== nextKey) {
        continue;
      }
      const ownership = deps.resolveOrderOwnership(order, monitors);
      if (!ownership) {
        continue;
      }
      const existing = grouped.get(ownership.monitorSymbol) ?? {
        long: [],
        short: [],
      };
      if (ownership.direction === 'LONG') {
        existing.long.push(order);
      } else {
        existing.short.push(order);
      }
      grouped.set(ownership.monitorSymbol, existing);
    }

    const diagnostics = collectOrderOwnershipDiagnostics({
      orders: allOrders,
      monitors,
      now,
      resolveOrderOwnership: deps.resolveOrderOwnership,
      toHongKongTimeIso: deps.toHongKongTimeIso,
      maxSamples: 3,
    });
    if (diagnostics && diagnostics.unmatchedFilled > 0) {
      const sampleText = diagnostics.unmatchedSamples
        .map((sample) => `${sample.symbol}:${sample.stockName}`)
        .join(' | ');
      logger.warn(
        `[日内亏损追踪] 未归属订单: 当日成交${diagnostics.inDayFilled}笔, ` +
          `未归属${diagnostics.unmatchedFilled}笔, 样例=${sampleText}`,
      );
    }

    for (const monitor of monitors) {
      const group = grouped.get(monitor.monitorSymbol);
      const longState = group
        ? buildStateFromOrders(group.long, deps)
        : createEmptyState();
      const shortState = group
        ? buildStateFromOrders(group.short, deps)
        : createEmptyState();
      statesByMonitor.set(monitor.monitorSymbol, {
        long: longState,
        short: shortState,
      });
    }
  }

  /**
   * 使用完整订单重新计算状态，作为纠偏手段。
   */
  function recalculateFromAllOrders(
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'>>,
    now: Date,
  ): void {
    initializeFromOrders(allOrders, monitors, now);
  }

  /**
   * 增量记录成交订单并更新亏损偏移。
   * dayKey 由 lifecycle riskDomain.midnightClear 通过 resetAll 统一驱动，此处仅记录当日成交。
   */
  function recordFilledOrder(input: DailyLossFilledOrderInput): void {
    if (!dayKey) {
      return;
    }
    const fillDayKey = resolveHongKongDayKey(deps.toHongKongTimeIso, new Date(input.executedTimeMs));
    if (fillDayKey !== dayKey) {
      return;
    }
    const record = createOrderRecordFromFill(input);
    if (!record) {
      return;
    }
    const isBuy = input.side === OrderSide.Buy;
    const isSell = input.side === OrderSide.Sell;
    if (!isBuy && !isSell) {
      return;
    }
    const existing = statesByMonitor.get(input.monitorSymbol) ?? {
      long: createEmptyState(),
      short: createEmptyState(),
    };
    const currentState = input.isLongSymbol ? existing.long : existing.short;
    const nextBuyOrders = isBuy
      ? [...currentState.buyOrders, record]
      : currentState.buyOrders;
    const nextSellOrders = isSell
      ? [...currentState.sellOrders, record]
      : currentState.sellOrders;
    const nextState: DailyLossState = {
      buyOrders: nextBuyOrders,
      sellOrders: nextSellOrders,
      dailyLossOffset: calculateLossOffsetFromRecords(
        nextBuyOrders,
        nextSellOrders,
        deps.filteringEngine,
      ),
    };

    if (input.isLongSymbol) {
      statesByMonitor.set(input.monitorSymbol, {
        long: nextState,
        short: existing.short,
      });
    } else {
      statesByMonitor.set(input.monitorSymbol, {
        long: existing.long,
        short: nextState,
      });
    }
  }

  /**
   * 获取指定标的与方向的当日亏损偏移。
   */
  function getLossOffset(monitorSymbol: string, isLongSymbol: boolean): number {
    const state = statesByMonitor.get(monitorSymbol);
    if (!state) {
      return 0;
    }
    return isLongSymbol ? state.long.dailyLossOffset : state.short.dailyLossOffset;
  }

  return {
    resetAll,
    initializeFromOrders,
    recalculateFromAllOrders,
    recordFilledOrder,
    getLossOffset,
  };
}
