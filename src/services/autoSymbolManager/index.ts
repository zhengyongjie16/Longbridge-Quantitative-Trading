/**
 * 自动换标管理器：
 * - 负责席位初始化、自动寻标与换标流程
 * - 通过阈值与风险距离判断触发换标，并处理撤单/卖出/买入的完整链路
 */
import { OrderSide } from 'longport';
import { findBestWarrant } from '../autoSymbolFinder/index.js';
import {
  getHKDateKey,
  getTradingMinutesSinceOpen,
  isWithinMorningOpenProtection,
} from '../../utils/helpers/tradingTime.js';
import { logger } from '../../utils/logger/index.js';
import { signalObjectPool } from '../../utils/objectPool/index.js';
import { AUTO_SYMBOL_SEARCH_COOLDOWN_MS, PENDING_ORDER_STATUSES } from '../../constants/index.js';
import type {
  Signal,
  Position,
  Quote,
  PendingOrder,
  SeatState,
  SeatVersion,
} from '../../types/index.js';
import type {
  AutoSymbolManager,
  AutoSymbolManagerDeps,
  EnsureSeatOnStartupParams,
  SearchOnTickParams,
  SeatDirection,
  SwitchOnDistanceParams,
  SwitchState,
  SwitchSuppression,
} from './types.js';

/**
 * 将方向映射到对应的买卖动作与牛熊方向。
 */
function resolveDirectionSymbols(direction: SeatDirection): {
  readonly isBull: boolean;
  readonly buyAction: 'BUYCALL' | 'BUYPUT';
  readonly sellAction: 'SELLCALL' | 'SELLPUT';
} {
  return {
    isBull: direction === 'LONG',
    buyAction: direction === 'LONG' ? 'BUYCALL' : 'BUYPUT',
    sellAction: direction === 'LONG' ? 'SELLCALL' : 'SELLPUT',
  } as const;
}

/**
 * 根据席位方向提取自动寻标阈值配置，避免错误混用多/空阈值。
 */
function resolveAutoSearchThresholds(
  direction: SeatDirection,
  config: AutoSymbolManagerDeps['monitorConfig']['autoSearchConfig'],
): {
  readonly minPrice: number | null;
  readonly minTurnoverPerMinute: number | null;
  readonly switchDistanceRange:
    | AutoSymbolManagerDeps['monitorConfig']['autoSearchConfig']['switchDistanceRangeBull']
    | AutoSymbolManagerDeps['monitorConfig']['autoSearchConfig']['switchDistanceRangeBear'];
} {
  if (direction === 'LONG') {
    return {
      minPrice: config.autoSearchMinPriceBull,
      minTurnoverPerMinute: config.autoSearchMinTurnoverPerMinuteBull,
      switchDistanceRange: config.switchDistanceRangeBull,
    };
  }
  return {
    minPrice: config.autoSearchMinPriceBear,
    minTurnoverPerMinute: config.autoSearchMinTurnoverPerMinuteBear,
    switchDistanceRange: config.switchDistanceRangeBear,
  };
}

function buildSeatState(
  symbol: string | null,
  status: 'READY' | 'SEARCHING' | 'SWITCHING' | 'EMPTY',
  lastSwitchAt: number | null,
  lastSearchAt: number | null,
): SeatState {
  return {
    symbol,
    status,
    lastSwitchAt,
    lastSearchAt,
  } as const;
}

function extractPosition(
  positions: ReadonlyArray<Position>,
  symbol: string,
): Position | null {
  if (!symbol) {
    return null;
  }
  return positions.find((pos) => pos.symbol === symbol) ?? null;
}

function isCancelableBuyOrder(order: PendingOrder, symbol: string): boolean {
  return order.symbol === symbol
    && order.side === OrderSide.Buy
    && PENDING_ORDER_STATUSES.has(order.status);
}

/**
 * 根据名义金额计算买入数量，并按 lotSize 向下取整。
 * 无法满足最小手数时返回 null。
 */
function calculateBuyQuantityByNotional(
  notional: number,
  price: number,
  lotSize: number,
): number | null {
  if (!Number.isFinite(notional) || notional <= 0) {
    return null;
  }
  if (!Number.isFinite(price) || price <= 0) {
    return null;
  }
  if (!Number.isFinite(lotSize) || lotSize <= 0) {
    return null;
  }
  let rawQty = Math.floor(notional / price);
  rawQty = Math.floor(rawQty / lotSize) * lotSize;
  return rawQty >= lotSize ? rawQty : null;
}

/**
 * 使用对象池构造订单信号，避免频繁分配对象。
 */
function buildOrderSignal({
  action,
  symbol,
  quote,
  reason,
  orderTypeOverride,
  quantity,
  seatVersion,
}: {
  action: Signal['action'];
  symbol: string;
  quote: Quote | null;
  reason: string;
  orderTypeOverride: Signal['orderTypeOverride'];
  quantity: number | null;
  seatVersion: number;
}): Signal {
  const signal = signalObjectPool.acquire() as Signal;
  signal.symbol = symbol;
  signal.symbolName = quote?.name ?? symbol;
  signal.action = action;
  signal.reason = reason;
  signal.orderTypeOverride = orderTypeOverride ?? null;
  signal.price = quote?.price ?? null;
  signal.lotSize = quote?.lotSize ?? null;
  signal.quantity = quantity ?? null;
  signal.triggerTime = new Date();
  signal.seatVersion = seatVersion;
  return signal;
}

export function createAutoSymbolManager(deps: AutoSymbolManagerDeps): AutoSymbolManager {
  const {
    monitorConfig,
    symbolRegistry,
    marketDataClient,
    trader,
    riskChecker,
    orderRecorder,
    warrantListCacheConfig,
  } = deps;
  const now = deps.now ?? (() => new Date());

  const monitorSymbol = monitorConfig.monitorSymbol;
  const autoSearchConfig = monitorConfig.autoSearchConfig;

  const switchStates = new Map<SeatDirection, SwitchState>();
  const switchSuppressions = new Map<SeatDirection, SwitchSuppression>();

  function resolveSuppression(
    direction: SeatDirection,
    seatSymbol: string,
  ): SwitchSuppression | null {
    const record = switchSuppressions.get(direction);
    if (!record) {
      return null;
    }
    const currentKey = getHKDateKey(now());
    if (!currentKey || record.dateKey !== currentKey || record.symbol !== seatSymbol) {
      switchSuppressions.delete(direction);
      return null;
    }
    return record;
  }

  function markSuppression(direction: SeatDirection, seatSymbol: string): void {
    const dateKey = getHKDateKey(now());
    if (!dateKey) {
      return;
    }
    switchSuppressions.set(direction, { symbol: seatSymbol, dateKey });
  }

  async function findSwitchCandidate(direction: SeatDirection): Promise<string | null> {
    const { minPrice, minTurnoverPerMinute } = resolveAutoSearchThresholds(direction, autoSearchConfig);
    if (minPrice == null || minTurnoverPerMinute == null) {
      logger.error(`[自动换标] 缺少阈值配置，无法预寻标: ${monitorSymbol} ${direction}`);
      return null;
    }
    const ctx = await marketDataClient._getContext();
    const tradingMinutes = getTradingMinutesSinceOpen(now());
    const best = await findBestWarrant({
      ctx,
      monitorSymbol,
      isBull: direction === 'LONG',
      tradingMinutes,
      minPrice,
      minTurnoverPerMinute,
      expiryMinMonths: autoSearchConfig.autoSearchExpiryMinMonths,
      logger,
      ...(warrantListCacheConfig ? { cacheConfig: warrantListCacheConfig } : {}),
    });
    return best ? best.symbol : null;
  }

  function updateSeatState(
    direction: SeatDirection,
    nextState: ReturnType<typeof buildSeatState>,
    bumpOnSymbolChange: boolean,
  ): void {
    const current = symbolRegistry.getSeatState(monitorSymbol, direction);
    if (bumpOnSymbolChange && current.symbol !== nextState.symbol) {
      symbolRegistry.bumpSeatVersion(monitorSymbol, direction);
    }
    symbolRegistry.updateSeatState(monitorSymbol, direction, nextState);
  }

  /**
   * 启动时初始化席位状态：
   * - 未启用自动寻标：直接绑定配置标的
   * - 已启用自动寻标：优先使用历史标的，否则置为空席位
   */
  function ensureSeatOnStartup({
    direction,
    initialSymbol,
  }: EnsureSeatOnStartupParams): SeatState {
    if (!autoSearchConfig.autoSearchEnabled) {
      const symbol = direction === 'LONG' ? monitorConfig.longSymbol : monitorConfig.shortSymbol;
      const nextState = buildSeatState(symbol, 'READY', null, null);
      updateSeatState(direction, nextState, false);
      return nextState;
    }

    if (initialSymbol) {
      const nextState = buildSeatState(initialSymbol, 'READY', null, null);
      updateSeatState(direction, nextState, false);
      return nextState;
    }

    const nextState = buildSeatState(null, 'EMPTY', null, null);
    updateSeatState(direction, nextState, false);
    return nextState;
  }

  /**
   * 清空席位并进入换标流程，同时提升席位版本用于信号隔离。
   */
  function clearSeat({ direction, reason }: { direction: SeatDirection; reason: string }): SeatVersion {
    const timestamp = now().getTime();
    const currentState = symbolRegistry.getSeatState(monitorSymbol, direction);
    const nextState = buildSeatState(currentState.symbol ?? null, 'SWITCHING', timestamp, null);
    symbolRegistry.updateSeatState(monitorSymbol, direction, nextState);
    const nextVersion = symbolRegistry.bumpSeatVersion(monitorSymbol, direction);
    logger.warn(`[自动换标] ${monitorSymbol} ${direction} 清空席位: ${reason}`);
    return nextVersion;
  }

  function resetDailySwitchSuppression(): void {
    switchSuppressions.clear();
  }

  /**
   * 在席位为空时执行自动寻标，受开盘保护与冷却时间限制。
   */
  async function maybeSearchOnTick({
    direction,
    currentTime,
    canTradeNow,
  }: SearchOnTickParams): Promise<void> {
    if (!autoSearchConfig.autoSearchEnabled || !canTradeNow) {
      return;
    }

    const seatState = symbolRegistry.getSeatState(monitorSymbol, direction);
    if (seatState.status !== 'EMPTY') {
      return;
    }

    const lastSearchAt = seatState.lastSearchAt ?? 0;
    const nowMs = currentTime.getTime();
    if (nowMs - lastSearchAt < AUTO_SYMBOL_SEARCH_COOLDOWN_MS) {
      return;
    }

    if (autoSearchConfig.autoSearchOpenDelayMinutes > 0 &&
        isWithinMorningOpenProtection(currentTime, autoSearchConfig.autoSearchOpenDelayMinutes)) {
      return;
    }

    const { minPrice, minTurnoverPerMinute } = resolveAutoSearchThresholds(direction, autoSearchConfig);
    if (minPrice == null || minTurnoverPerMinute == null) {
      logger.error(`[自动寻标] 缺少阈值配置，跳过寻标: ${monitorSymbol} ${direction}`);
      return;
    }

    updateSeatState(
      direction,
      buildSeatState(null, 'SEARCHING', seatState.lastSwitchAt ?? null, nowMs),
      false,
    );

    const ctx = await marketDataClient._getContext();
    const tradingMinutes = getTradingMinutesSinceOpen(currentTime);
    const best = await findBestWarrant({
      ctx,
      monitorSymbol,
      isBull: direction === 'LONG',
      tradingMinutes,
      minPrice,
      minTurnoverPerMinute,
      expiryMinMonths: autoSearchConfig.autoSearchExpiryMinMonths,
      logger,
      ...(warrantListCacheConfig ? { cacheConfig: warrantListCacheConfig } : {}),
    });

    if (!best) {
      updateSeatState(
        direction,
        buildSeatState(null, 'EMPTY', seatState.lastSwitchAt ?? null, nowMs),
        false,
      );
      return;
    }

    const nextState = buildSeatState(best.symbol, 'READY', nowMs, nowMs);
    updateSeatState(direction, nextState, true);
  }

  /**
   * 换标状态机：
   * 1) 先撤销旧标的未成交买单
   * 2) 若有持仓则提交卖出并等待成交
   * 3) 卖出完成后更新席位并按需回补买入
   */
  async function processSwitchState(
    params: SwitchOnDistanceParams,
    state: SwitchState,
  ): Promise<void> {
    const { direction, quotesMap, positions, pendingOrders } = params;
    const { sellAction } = resolveDirectionSymbols(direction);
    const seatVersion = symbolRegistry.getSeatVersion(monitorSymbol, direction);

    // 先撤销旧标的未成交买单，避免换标期间重复持仓
    const cancelTargets = pendingOrders.filter((order) =>
      isCancelableBuyOrder(order, state.oldSymbol),
    );

    if (cancelTargets.length > 0) {
      const results = await Promise.all(
        cancelTargets.map((order) => trader.cancelOrder(order.orderId)),
      );
      if (results.some((ok) => !ok)) {
        updateSeatState(direction, buildSeatState(null, 'EMPTY', null, null), false);
        switchStates.delete(direction);
        logger.error(`[自动换标] 撤销买入订单失败，换标中止: ${state.oldSymbol}`);
        return;
      }
    }

    const position = extractPosition(positions, state.oldSymbol);
    const totalQuantity = position?.quantity ?? 0;
    const availableQuantity = position?.availableQuantity ?? 0;

    // 有持仓但不可用时等待解冻，避免卖出数量不准确
    if (Number.isFinite(totalQuantity) && totalQuantity > 0 && availableQuantity === 0) {
      return;
    }

    // 还有可用持仓时先提交卖出
    if (Number.isFinite(availableQuantity) && availableQuantity > 0) {
      if (!state.sellSubmitted) {
        const quote = quotesMap.get(state.oldSymbol) ?? null;
        if (!quote || quote.price == null || quote.lotSize == null) {
          return;
        }

        const signal = buildOrderSignal({
          action: sellAction,
          symbol: state.oldSymbol,
          quote,
          reason: '自动换标-移仓卖出',
          orderTypeOverride: 'ELO',
          quantity: availableQuantity,
          seatVersion,
        });

        await trader.executeSignals([signal]);
        signalObjectPool.release(signal);

        state.sellSubmitted = true;
        return;
      }
      return;
    }

    // 卖出完成后尝试记录真实成交金额，用于回补买入
    const latestSellRecord = orderRecorder.getLatestSellRecord(state.oldSymbol, direction === 'LONG');
    if (latestSellRecord && latestSellRecord.executedTime >= state.startedAt) {
      const actualNotional = latestSellRecord.executedPrice * latestSellRecord.executedQuantity;
      if (Number.isFinite(actualNotional) && actualNotional > 0) {
        state.sellNotional = actualNotional;
      }
    }

    const nextSymbol = state.nextSymbol;
    // 未找到候选标的则直接清空席位
    if (!nextSymbol) {
      updateSeatState(direction, buildSeatState(null, 'EMPTY', null, null), false);
      switchStates.delete(direction);
      return;
    }

    updateSeatState(
      direction,
      buildSeatState(nextSymbol, 'READY', now().getTime(), now().getTime()),
      false,
    );

    // 若没有持仓则不需要回补买入
    if (!state.shouldRebuy) {
      switchStates.delete(direction);
      return;
    }

    const quote = quotesMap.get(nextSymbol) ?? null;
    // 等待下一次行情数据补全价格与手数
    if (!quote || quote.price == null || quote.lotSize == null) {
      state.awaitingQuote = true;
      return;
    }

    const buyNotional = state.sellNotional ?? monitorConfig.targetNotional;
    const buyQuantity = calculateBuyQuantityByNotional(
      buyNotional,
      quote.price,
      quote.lotSize,
    );

    if (!buyQuantity) {
      switchStates.delete(direction);
      return;
    }

    const signal = buildOrderSignal({
      action: resolveDirectionSymbols(direction).buyAction,
      symbol: nextSymbol,
      quote,
      reason: '自动换标-移仓买入',
      orderTypeOverride: 'ELO',
      quantity: buyQuantity,
      seatVersion,
    });

    await trader.executeSignals([signal]);
    signalObjectPool.release(signal);
    switchStates.delete(direction);
  }

  /**
   * 根据距回收价阈值决定是否触发换标，含日内抑制与候选标的检测。
   */
  async function maybeSwitchOnDistance({
    direction,
    monitorPrice,
    quotesMap,
    positions,
    pendingOrders,
  }: SwitchOnDistanceParams): Promise<void> {
    if (!autoSearchConfig.autoSearchEnabled) {
      return;
    }

    const pendingSwitch = switchStates.get(direction);
    if (pendingSwitch) {
      const currentSeatState = symbolRegistry.getSeatState(monitorSymbol, direction);
      if (!currentSeatState.symbol || currentSeatState.status === 'EMPTY') {
        switchStates.delete(direction);
        logger.warn(
          `[自动换标] 席位已清空，终止待处理换标: ${monitorSymbol} ${direction}`,
        );
        return;
      }
      await processSwitchState({ direction, monitorPrice, quotesMap, positions, pendingOrders }, pendingSwitch);
      return;
    }

    const seatState = symbolRegistry.getSeatState(monitorSymbol, direction);
    if (!seatState.symbol || seatState.status !== 'READY') {
      return;
    }

    const distanceInfo = riskChecker.getWarrantDistanceInfo(
      direction === 'LONG',
      seatState.symbol,
      monitorPrice,
    );

    const distancePercent = distanceInfo?.distanceToStrikePercent ?? null;
    const range = resolveAutoSearchThresholds(direction, autoSearchConfig).switchDistanceRange;

    if (distancePercent == null || !range) {
      return;
    }

    // 阈值越界触发换标流程
    if (distancePercent <= range.min || distancePercent >= range.max) {
      if (resolveSuppression(direction, seatState.symbol)) {
        return;
      }

      const nextSymbol = await findSwitchCandidate(direction);
      if (nextSymbol && nextSymbol === seatState.symbol) {
        markSuppression(direction, seatState.symbol);
        return;
      }

      clearSeat({ direction, reason: '距回收价阈值越界' });

      const position = extractPosition(positions, seatState.symbol);
      const hasPosition = (position?.quantity ?? 0) > 0;

      switchStates.set(direction, {
        direction,
        oldSymbol: seatState.symbol,
        nextSymbol: nextSymbol ?? null,
        startedAt: now().getTime(),
        sellSubmitted: false,
        sellNotional: null,
        shouldRebuy: hasPosition,
        awaitingQuote: false,
      });

      await processSwitchState(
        { direction, monitorPrice, quotesMap, positions, pendingOrders },
        switchStates.get(direction)!,
      );
    }
  }

  return {
    ensureSeatOnStartup,
    maybeSearchOnTick,
    maybeSwitchOnDistance,
    clearSeat,
    resetDailySwitchSuppression,
  };
}
