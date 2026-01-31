import { OrderSide, OrderStatus } from 'longport';
import type { MonitorConfig, OrderRecord, RawOrderFromAPI } from '../../types/index.js';
import type {
  DailyLossFilledOrderInput,
  DailyLossState,
  DailyLossTracker,
  DailyLossTrackerDeps,
} from './types.js';

function resolveBeijingDayKey(
  toBeijingTimeIso: (date: Date | null) => string,
  date: Date,
): string | null {
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  const iso = toBeijingTimeIso(date);
  const parts = iso.split('/');
  if (parts.length < 3) {
    return null;
  }
  return `${parts[0]}/${parts[1]}/${parts[2]}`;
}

function createEmptyState(): DailyLossState {
  return {
    buyOrders: [],
    sellOrders: [],
    dailyLossOffset: 0,
  };
}

function sumOrderCost(orders: ReadonlyArray<OrderRecord>): number {
  let total = 0;
  for (const order of orders) {
    const price = Number(order.executedPrice);
    const quantity = Number(order.executedQuantity);
    if (
      Number.isFinite(price) &&
      price > 0 &&
      Number.isFinite(quantity) &&
      quantity > 0
    ) {
      total += price * quantity;
    }
  }
  return total;
}

function calculateLossOffsetFromRecords(
  buyOrders: ReadonlyArray<OrderRecord>,
  sellOrders: ReadonlyArray<OrderRecord>,
  deps: Pick<DailyLossTrackerDeps, 'filteringEngine'>,
): number {
  if (buyOrders.length === 0 && sellOrders.length === 0) {
    return 0;
  }
  const totalBuy = sumOrderCost(buyOrders);
  const totalSell = sumOrderCost(sellOrders);
  const openBuyOrders = deps.filteringEngine.applyFilteringAlgorithm(
    [...buyOrders],
    [...sellOrders],
  );
  const openBuyCost = sumOrderCost(openBuyOrders);
  return totalBuy - totalSell - openBuyCost;
}

function buildStateFromOrders(
  orders: ReadonlyArray<RawOrderFromAPI>,
  deps: Pick<DailyLossTrackerDeps, 'filteringEngine' | 'classifyAndConvertOrders'>,
): DailyLossState {
  const { buyOrders, sellOrders } = deps.classifyAndConvertOrders(orders);
  const dailyLossOffset = calculateLossOffsetFromRecords(
    buyOrders,
    sellOrders,
    deps,
  );
  return {
    buyOrders,
    sellOrders,
    dailyLossOffset,
  };
}

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

export function createDailyLossTracker(deps: DailyLossTrackerDeps): DailyLossTracker {
  let dayKey: string | null = null;
  const statesByMonitor = new Map<string, { long: DailyLossState; short: DailyLossState }>();

  function resetIfNewDay(now: Date): void {
    const nextKey = resolveBeijingDayKey(deps.toBeijingTimeIso, now);
    if (!nextKey) {
      return;
    }
    if (dayKey !== nextKey) {
      dayKey = nextKey;
      statesByMonitor.clear();
    }
  }

  function initializeFromOrders(
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol'>>,
    now: Date,
  ): void {
    const nextKey = resolveBeijingDayKey(deps.toBeijingTimeIso, now);
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
      const orderDayKey = resolveBeijingDayKey(deps.toBeijingTimeIso, order.updatedAt);
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

  function recalculateFromAllOrders(
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol'>>,
    now: Date,
  ): void {
    initializeFromOrders(allOrders, monitors, now);
  }

  function recordFilledOrder(input: DailyLossFilledOrderInput): void {
    resetIfNewDay(new Date(input.executedTimeMs));
    if (!dayKey) {
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
        deps,
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

  function getLossOffset(monitorSymbol: string, isLongSymbol: boolean): number {
    const state = statesByMonitor.get(monitorSymbol);
    if (!state) {
      return 0;
    }
    return isLongSymbol ? state.long.dailyLossOffset : state.short.dailyLossOffset;
  }

  return {
    initializeFromOrders,
    recalculateFromAllOrders,
    recordFilledOrder,
    getLossOffset,
    resetIfNewDay,
  };
}
