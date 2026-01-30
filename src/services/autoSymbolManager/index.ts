import { OrderSide } from 'longport';
import { findBestWarrant } from '../autoSymbolFinder/index.js';
import { getTradingMinutesSinceOpen, isWithinMorningOpenProtection } from '../../utils/helpers/tradingTime.js';
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
} from './types.js';

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
  for (const pos of positions) {
    if (pos.symbol === symbol) {
      return pos;
    }
  }
  return null;
}

function isCancelableBuyOrder(order: PendingOrder, symbol: string): boolean {
  if (order.symbol !== symbol) {
    return false;
  }
  if (order.side !== OrderSide.Buy) {
    return false;
  }
  return PENDING_ORDER_STATUSES.has(order.status);
}

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
  const { monitorConfig, symbolRegistry, marketDataClient, trader, riskChecker, orderRecorder } = deps;
  const now = deps.now ?? (() => new Date());

  const monitorSymbol = monitorConfig.monitorSymbol;
  const autoSearchConfig = monitorConfig.autoSearchConfig;

  const switchStates = new Map<SeatDirection, SwitchState>();

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

  function clearSeat({ direction, reason }: { direction: SeatDirection; reason: string }): SeatVersion {
    const timestamp = now().getTime();
    const currentState = symbolRegistry.getSeatState(monitorSymbol, direction);
    const nextState = buildSeatState(currentState.symbol ?? null, 'SWITCHING', timestamp, null);
    symbolRegistry.updateSeatState(monitorSymbol, direction, nextState);
    const nextVersion = symbolRegistry.bumpSeatVersion(monitorSymbol, direction);
    logger.warn(`[自动换标] ${monitorSymbol} ${direction} 清空席位: ${reason}`);
    return nextVersion;
  }

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

  async function processSwitchState(
    params: SwitchOnDistanceParams,
    state: SwitchState,
  ): Promise<void> {
    const { direction, quotesMap, positions, pendingOrders } = params;
    const { sellAction } = resolveDirectionSymbols(direction);
    const seatVersion = symbolRegistry.getSeatVersion(monitorSymbol, direction);

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

    if (Number.isFinite(totalQuantity) && totalQuantity > 0 && availableQuantity === 0) {
      return;
    }

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

    const latestSellRecord = orderRecorder.getLatestSellRecord(state.oldSymbol, direction === 'LONG');
    if (latestSellRecord && latestSellRecord.executedTime >= state.startedAt) {
      const actualNotional = latestSellRecord.executedPrice * latestSellRecord.executedQuantity;
      if (Number.isFinite(actualNotional) && actualNotional > 0) {
        state.sellNotional = actualNotional;
      }
    }

    const { minPrice, minTurnoverPerMinute } = resolveAutoSearchThresholds(direction, autoSearchConfig);
    if (minPrice == null || minTurnoverPerMinute == null) {
      updateSeatState(direction, buildSeatState(null, 'EMPTY', null, null), false);
      switchStates.delete(direction);
      logger.error(`[自动换标] 缺少阈值配置，换标终止: ${monitorSymbol} ${direction}`);
      return;
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
    });

    if (!best) {
      updateSeatState(direction, buildSeatState(null, 'EMPTY', null, null), false);
      switchStates.delete(direction);
      return;
    }

    updateSeatState(
      direction,
      buildSeatState(best.symbol, 'READY', now().getTime(), now().getTime()),
      false,
    );

    if (!state.shouldRebuy) {
      switchStates.delete(direction);
      return;
    }

    const quote = quotesMap.get(best.symbol) ?? null;
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
      symbol: best.symbol,
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
      monitorPrice,
    );

    const distancePercent = distanceInfo?.distanceToStrikePercent ?? null;
    const range = resolveAutoSearchThresholds(direction, autoSearchConfig).switchDistanceRange;

    if (distancePercent == null || !range) {
      return;
    }

    if (distancePercent <= range.min || distancePercent >= range.max) {
      clearSeat({ direction, reason: '距回收价阈值越界' });

      const position = extractPosition(positions, seatState.symbol);
      const hasPosition = (position?.quantity ?? 0) > 0;

      switchStates.set(direction, {
        direction,
        oldSymbol: seatState.symbol,
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
  };
}
