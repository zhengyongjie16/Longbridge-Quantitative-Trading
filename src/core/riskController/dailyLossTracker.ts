/**
 * 当日亏损追踪器模块
 *
 * 功能/职责：按监控标的与方向累计已实现亏损偏移；内部基于当日成交订单与过滤算法（filteringEngine）计算未平仓买入成本。
 * 执行流程：调用方通过 recalculateFromAllOrders 或 recordFilledOrder 传入/增量订单，通过 getLossOffset(monitorSymbol, isLongSymbol) 获取当日亏损偏移；内部按 (monitorSymbol, direction) 分组维护订单与偏移。
 */
import { OrderSide, OrderStatus } from 'longbridge';
import { logger } from '../../utils/logger/index.js';
import type { MonitorConfig } from '../../types/config.js';
import type {
  DailyLossFilledOrderInput,
  DailyLossTracker,
  DailyLossTrackerDeps,
  ResetDirectionSegmentParams,
} from '../../types/risk.js';
import type { OrderRecord, RawOrderFromAPI } from '../../types/services.js';
import {
  decimalAdd,
  decimalGt,
  decimalSub,
  decimalToNumberValue,
  toDecimalValue,
} from '../../utils/numeric/index.js';
import type { DailyLossState } from './types.js';
import { buildCooldownKey } from '../../services/liquidationCooldown/utils.js';
import { collectOrderOwnershipDiagnostics, resolveHongKongDayKey, sumOrderCost } from './utils.js';

/**
 * 构建空状态，避免分支重复初始化。
 *
 * @returns 无买入/卖出订单、亏损偏移为 0 的 DailyLossState
 */
function createEmptyState(): DailyLossState {
  return {
    buyOrders: [],
    sellOrders: [],
    dailyLossOffset: 0,
  };
}

/**
 * 计算当日盈亏偏移：realizedPnL = totalSell - (totalBuy - openBuyCost)。
 * 仅记录亏损偏移：当 realizedPnL > 0（当日盈利）时按 0 处理；负值表示当日亏损偏移。
 *
 * @param buyOrders 买入订单记录
 * @param sellOrders 卖出订单记录
 * @param filteringEngine 过滤引擎（用于计算未平仓买入成本）
 * @returns 当日亏损偏移（非正数，0 表示无亏损或盈利）
 */
function calculateLossOffsetFromRecords(
  buyOrders: ReadonlyArray<OrderRecord>,
  sellOrders: ReadonlyArray<OrderRecord>,
  filteringEngine: DailyLossTrackerDeps['filteringEngine'],
): number {
  if (buyOrders.length === 0 && sellOrders.length === 0) {
    return 0;
  }

  const totalBuy = toDecimalValue(sumOrderCost(buyOrders));
  const totalSell = toDecimalValue(sumOrderCost(sellOrders));
  if (totalBuy.isZero() && totalSell.isZero()) {
    return 0;
  }

  const openBuyOrders =
    buyOrders.length > 0
      ? filteringEngine.applyFilteringAlgorithm([...buyOrders], [...sellOrders])
      : [];
  const openBuyCost = toDecimalValue(sumOrderCost(openBuyOrders));
  const realizedPnL = decimalAdd(decimalSub(totalSell, totalBuy), openBuyCost);
  if (decimalGt(realizedPnL, 0)) {
    return 0;
  }

  return decimalToNumberValue(realizedPnL);
}

/**
 * 将订单列表转换为当日状态并计算亏损偏移。
 *
 * @param orders 原始 API 订单列表
 * @param deps 依赖（filteringEngine、classifyAndConvertOrders）
 * @returns 含 buyOrders、sellOrders、dailyLossOffset 的状态
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
 *
 * @param input 成交回报（订单 ID、标的、成交价、成交量、成交时间等）
 * @returns OrderRecord 或 null（价格/数量/时间非法时）
 */
function createOrderRecordFromFill(input: DailyLossFilledOrderInput): OrderRecord | null {
  const executedPrice = input.executedPrice;
  const executedQuantity = input.executedQuantity;
  const executedTime = input.executedTimeMs;
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
 * 创建当日亏损追踪器实例。
 * 按 (monitorSymbol, direction) 维护当日买入/卖出订单与亏损偏移，支持 resetAll、recalculateFromAllOrders、recordFilledOrder、getLossOffset。
 * 风控与浮亏计算依赖当日已实现盈亏偏移，需在跨日时重置、启动时从全量订单初始化、成交时增量更新。
 * @param deps 依赖（filteringEngine、resolveOrderOwnership、classifyAndConvertOrders、toHongKongTimeIso）
 * @returns 实现 DailyLossTracker 接口的实例
 */
export function createDailyLossTracker(deps: DailyLossTrackerDeps): DailyLossTracker {
  let dayKey: string | null = null;
  const statesByMonitor = new Map<string, { long: DailyLossState; short: DailyLossState }>();

  /** 分段起始时间：按 "monitorSymbol:direction" 为键，成交时间 < segmentStartMs 的不纳入偏移计算 */
  const segmentStartByDirection = new Map<string, number>();

  /** 幂等保护：按 "monitorSymbol:direction" 记录上次 resetDirectionSegment 的 cooldownEndMs */
  const lastResetByCooldownEndMs = new Map<string, number>();

  /**
   * 显式重置 dayKey、states 与分段元数据。
   */
  function resetAll(now: Date): void {
    const nextKey = resolveHongKongDayKey(deps.toHongKongTimeIso, now);
    dayKey = nextKey;
    statesByMonitor.clear();
    segmentStartByDirection.clear();
    lastResetByCooldownEndMs.clear();
  }

  /**
   * 启动时根据历史成交订单初始化当日状态。
   * externalSegmentStarts 可选：按 "monitorSymbol:direction" 为键恢复分段起始时间。
   */
  function initializeFromOrders(
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'>>,
    now: Date,
    externalSegmentStarts?: ReadonlyMap<string, number>,
  ): void {
    const nextKey = resolveHongKongDayKey(deps.toHongKongTimeIso, now);
    dayKey = nextKey;
    statesByMonitor.clear();
    // 恢复外部提供的分段起始时间（启动恢复链传入）
    if (externalSegmentStarts) {
      for (const [key, startMs] of externalSegmentStarts) {
        segmentStartByDirection.set(key, startMs);
      }
    }

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

      // 分段过滤：仅计入 executedTime >= segmentStartMs 的成交
      const directionKey = buildCooldownKey(ownership.monitorSymbol, ownership.direction);
      const segmentStart = segmentStartByDirection.get(directionKey);
      if (segmentStart !== undefined) {
        const orderTimeMs = order.updatedAt.getTime();
        if (orderTimeMs < segmentStart) {
          continue;
        }
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
      const longState = group ? buildStateFromOrders(group.long, deps) : createEmptyState();
      const shortState = group ? buildStateFromOrders(group.short, deps) : createEmptyState();
      statesByMonitor.set(monitor.monitorSymbol, {
        long: longState,
        short: shortState,
      });
    }
  }

  /**
   * 使用完整订单重新计算状态，作为纠偏手段。
   * externalSegmentStarts 可选：提供分段起始时间以过滤旧段成交。
   */
  function recalculateFromAllOrders(
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'>>,
    now: Date,
    externalSegmentStarts?: ReadonlyMap<string, number>,
  ): void {
    initializeFromOrders(allOrders, monitors, now, externalSegmentStarts);
  }

  /**
   * 增量记录成交订单并更新亏损偏移。
   * dayKey 由 lifecycle riskDomain.midnightClear 通过 resetAll 统一驱动，此处仅记录当日成交。
   * 分段过滤：仅接受 executedTimeMs >= 当前分段起始时间的成交。
   */
  function recordFilledOrder(input: DailyLossFilledOrderInput): void {
    if (!dayKey) {
      return;
    }

    const fillDayKey = resolveHongKongDayKey(
      deps.toHongKongTimeIso,
      new Date(input.executedTimeMs),
    );
    if (fillDayKey !== dayKey) {
      return;
    }

    // 分段过滤：成交时间早于分段起始时间的不纳入
    const directionKey = buildCooldownKey(
      input.monitorSymbol,
      input.isLongSymbol ? 'LONG' : 'SHORT',
    );
    const segmentStart = segmentStartByDirection.get(directionKey);
    if (segmentStart !== undefined && input.executedTimeMs < segmentStart) {
      return;
    }

    const record = createOrderRecordFromFill(input);
    if (!record) {
      return;
    }

    if (input.side !== OrderSide.Buy && input.side !== OrderSide.Sell) {
      return;
    }

    const existing = statesByMonitor.get(input.monitorSymbol) ?? {
      long: createEmptyState(),
      short: createEmptyState(),
    };
    const currentState = input.isLongSymbol ? existing.long : existing.short;
    const isBuy = input.side === OrderSide.Buy;
    const nextBuyOrders = isBuy ? [...currentState.buyOrders, record] : currentState.buyOrders;
    const nextSellOrders = isBuy ? currentState.sellOrders : [...currentState.sellOrders, record];
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

  /**
   * 重置指定 monitor+direction 的分段：清空旧段订单与偏移，设置新分段起始时间。
   * 幂等：同一 cooldownEndMs 重复调用不产生副作用。
   */
  function resetDirectionSegment({
    monitorSymbol,
    direction,
    segmentStartMs,
    cooldownEndMs,
  }: ResetDirectionSegmentParams): void {
    const key = buildCooldownKey(monitorSymbol, direction);
    // 幂等保护：同一 cooldownEndMs 不重复执行
    if (lastResetByCooldownEndMs.get(key) === cooldownEndMs) {
      return;
    }

    lastResetByCooldownEndMs.set(key, cooldownEndMs);
    segmentStartByDirection.set(key, segmentStartMs);

    // 清空该方向的订单与偏移，进入新分段
    const existing = statesByMonitor.get(monitorSymbol);
    if (!existing) {
      return;
    }

    const isLong = direction === 'LONG';
    if (isLong) {
      statesByMonitor.set(monitorSymbol, {
        long: createEmptyState(),
        short: existing.short,
      });
    } else {
      statesByMonitor.set(monitorSymbol, {
        long: existing.long,
        short: createEmptyState(),
      });
    }
  }

  return {
    resetAll,
    recalculateFromAllOrders,
    recordFilledOrder,
    getLossOffset,
    resetDirectionSegment,
  };
}
