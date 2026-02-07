/**
 * 自动换标模块：换标状态机
 *
 * 职责：
 * - 撤单/卖出/绑定/等待行情/回补/完成
 * - 距离阈值触发与日内抑制
 */
import type { PendingOrder, Position } from '../../types/index.js';
import type {
  SeatDirection,
  SwitchOnDistanceParams,
  SwitchState,
  SwitchStateMachine,
  SwitchStateMachineDeps,
} from './types.js';

/** 从持仓列表中提取指定标的的持仓信息 */
function extractPosition(
  positions: ReadonlyArray<Position>,
  symbol: string,
): Position | null {
  if (!symbol) {
    return null;
  }
  return positions.find((pos) => pos.symbol === symbol) ?? null;
}

export function createSwitchStateMachine(
  deps: SwitchStateMachineDeps,
): SwitchStateMachine {
  const {
    autoSearchConfig,
    monitorConfig,
    monitorSymbol,
    symbolRegistry,
    trader,
    orderRecorder,
    riskChecker,
    now,
    switchStates,
    resolveSuppression,
    markSuppression,
    clearSeat,
    buildSeatState,
    updateSeatState,
    resolveAutoSearchThresholds,
    resolveAutoSearchThresholdInput,
    buildFindBestWarrantInput,
    findBestWarrant,
    resolveDirectionSymbols,
    calculateBuyQuantityByNotional,
    buildOrderSignal,
    signalObjectPool,
    pendingOrderStatuses,
    buySide,
    logger,
  } = deps;

  function isCancelableBuyOrder(order: PendingOrder, symbol: string): boolean {
    return order.symbol === symbol
      && order.side === buySide
      && pendingOrderStatuses.has(order.status);
  }

  async function findSwitchCandidate(
    direction: SeatDirection,
  ): Promise<{ symbol: string; callPrice: number } | null> {
    const thresholds = resolveAutoSearchThresholdInput({
      direction,
      logPrefix: '[自动换标] 缺少阈值配置，无法预寻标',
    });
    if (!thresholds) {
      return null;
    }
    const input = await buildFindBestWarrantInput({
      direction,
      currentTime: now(),
      minDistancePct: thresholds.minDistancePct,
      minTurnoverPerMinute: thresholds.minTurnoverPerMinute,
    });
    const best = await findBestWarrant(input);
    if (!best) {
      return null;
    }
    return { symbol: best.symbol, callPrice: best.callPrice };
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
    pendingOrders: ReadonlyArray<PendingOrder>,
  ): Promise<void> {
    const { direction, quotesMap, positions } = params;
    const { sellAction, buyAction } = resolveDirectionSymbols(direction);
    const seatVersion = symbolRegistry.getSeatVersion(monitorSymbol, direction);
    if (state.stage === 'CANCEL_PENDING') {
      const cancelTargets = pendingOrders.filter((order) =>
        isCancelableBuyOrder(order, state.oldSymbol),
      );

      if (cancelTargets.length > 0) {
        const results = await Promise.all(
          cancelTargets.map((order) => trader.cancelOrder(order.orderId)),
        );
        if (results.some((ok) => !ok)) {
          state.stage = 'FAILED';
          updateSeatState(direction, buildSeatState(null, 'EMPTY', null, null, null), false);
          switchStates.delete(direction);
          logger.error(`[自动换标] 撤销买入订单失败，换标中止: ${state.oldSymbol}`);
          return;
        }
      }
      state.stage = 'SELL_OUT';
    }

    if (state.stage === 'SELL_OUT') {
      const position = extractPosition(positions, state.oldSymbol);
      const totalQuantity = position?.quantity ?? 0;
      const availableQuantity = position?.availableQuantity ?? 0;

      if (Number.isFinite(totalQuantity) && totalQuantity > 0 && availableQuantity === 0) {
        return;
      }

      if (Number.isFinite(availableQuantity) && availableQuantity > 0) {
        if (state.sellSubmitted) {
          return;
        }
        const quote = quotesMap.get(state.oldSymbol);
        if (!quote?.price || !quote?.lotSize) {
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

      const latestSellRecord = orderRecorder.getLatestSellRecord(
        state.oldSymbol,
        direction === 'LONG',
      );
      if (latestSellRecord && latestSellRecord.executedTime >= state.startedAt) {
        const actualNotional = latestSellRecord.executedPrice * latestSellRecord.executedQuantity;
        if (Number.isFinite(actualNotional) && actualNotional > 0) {
          state.sellNotional = actualNotional;
        }
      }

      state.stage = 'BIND_NEW';
    }

    if (state.stage === 'BIND_NEW') {
      const nextSymbol = state.nextSymbol;
      if (!nextSymbol) {
        state.stage = 'FAILED';
        updateSeatState(direction, buildSeatState(null, 'EMPTY', null, null, null), false);
        switchStates.delete(direction);
        return;
      }

      updateSeatState(
        direction,
        buildSeatState(nextSymbol, 'SWITCHING', now().getTime(), now().getTime(), null),
        false,
      );

      if (state.shouldRebuy) {
        state.stage = 'WAIT_QUOTE';
      } else {
        state.stage = 'COMPLETE';
      }
    }

    if (state.stage === 'WAIT_QUOTE') {
      const nextSymbol = state.nextSymbol;
      if (!nextSymbol) {
        state.stage = 'FAILED';
        updateSeatState(direction, buildSeatState(null, 'EMPTY', null, null, null), false);
        switchStates.delete(direction);
        return;
      }
      const quote = quotesMap.get(nextSymbol);
      if (!quote?.price || !quote?.lotSize) {
        state.awaitingQuote = true;
        return;
      }
      state.awaitingQuote = false;
      state.stage = 'REBUY';
    }

    if (state.stage === 'REBUY') {
      const nextSymbol = state.nextSymbol;
      if (!nextSymbol) {
        state.stage = 'FAILED';
        updateSeatState(direction, buildSeatState(null, 'EMPTY', null, null, null), false);
        switchStates.delete(direction);
        return;
      }
      const quote = quotesMap.get(nextSymbol);
      if (!quote?.price || !quote?.lotSize) {
        state.awaitingQuote = true;
        state.stage = 'WAIT_QUOTE';
        return;
      }

      const buyNotional = state.sellNotional ?? monitorConfig.targetNotional;
      const buyQuantity = calculateBuyQuantityByNotional(
        buyNotional,
        quote.price,
        quote.lotSize,
      );

      if (buyQuantity) {
        state.stage = 'COMPLETE';
      } else {
        const signal = buildOrderSignal({
          action: buyAction,
          symbol: nextSymbol,
          quote,
          reason: '自动换标-移仓买入',
          orderTypeOverride: 'ELO',
          quantity: buyQuantity,
          seatVersion,
        });

        await trader.executeSignals([signal]);
        signalObjectPool.release(signal);
        state.stage = 'COMPLETE';
      }
    }

    if (state.stage === 'COMPLETE') {
      const nextSymbol = state.nextSymbol;
      if (nextSymbol) {
        updateSeatState(
          direction,
          buildSeatState(
            nextSymbol,
            'READY',
            now().getTime(),
            now().getTime(),
            state.nextCallPrice ?? null,
          ),
          false,
        );
      }
      switchStates.delete(direction);
    }
  }

  function hasPendingSwitch(direction: SeatDirection): boolean {
    const switchState = switchStates.get(direction);
    if (!switchState) {
      return false;
    }
    const currentVersion = symbolRegistry.getSeatVersion(monitorSymbol, direction);
    if (currentVersion !== switchState.seatVersion) {
      switchStates.delete(direction);
      return false;
    }
    const seatState = symbolRegistry.getSeatState(monitorSymbol, direction);
    const symbolMatches =
      seatState.symbol === switchState.oldSymbol ||
      seatState.symbol === switchState.nextSymbol;
    if (seatState.status !== 'SWITCHING' || !symbolMatches) {
      switchStates.delete(direction);
      return false;
    }
    if (switchState.stage === 'COMPLETE' || switchState.stage === 'FAILED') {
      switchStates.delete(direction);
      return false;
    }
    return true;
  }

  /**
   * 根据距回收价阈值决定是否触发换标，含日内抑制与候选标的检测。
   */
  async function maybeSwitchOnDistance({
    direction,
    monitorPrice,
    quotesMap,
    positions,
  }: SwitchOnDistanceParams): Promise<void> {
    if (!autoSearchConfig.autoSearchEnabled) {
      return;
    }

    const pendingSwitch = switchStates.get(direction);
    if (pendingSwitch) {
      const currentVersion = symbolRegistry.getSeatVersion(monitorSymbol, direction);
      if (currentVersion !== pendingSwitch.seatVersion) {
        switchStates.delete(direction);
        return;
      }
      const currentSeatState = symbolRegistry.getSeatState(monitorSymbol, direction);
      if (currentSeatState.status !== 'SWITCHING') {
        switchStates.delete(direction);
        logger.warn(`[auto-symbol] pending switch cleared: ${monitorSymbol} ${direction}`);
        return;
      }
      const symbolMatches =
        currentSeatState.symbol === pendingSwitch.oldSymbol ||
        currentSeatState.symbol === pendingSwitch.nextSymbol;
      if (!symbolMatches) {
        switchStates.delete(direction);
        logger.warn(`[auto-symbol] pending switch cleared: ${monitorSymbol} ${direction}`);
        return;
      }
      const pendingOrdersForOldSymbol = await trader.getPendingOrders([pendingSwitch.oldSymbol]);
      await processSwitchState(
        { direction, monitorPrice, quotesMap, positions },
        pendingSwitch,
        pendingOrdersForOldSymbol,
      );
      return;
    }

    if (monitorPrice == null) {
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

      const next = await findSwitchCandidate(direction);
      if (next && next.symbol === seatState.symbol) {
        markSuppression(direction, seatState.symbol);
        return;
      }

      const seatVersion = clearSeat({ direction, reason: '距回收价阈值越界' });

      const position = extractPosition(positions, seatState.symbol);
      const hasPosition = (position?.quantity ?? 0) > 0;

      switchStates.set(direction, {
        direction,
        seatVersion,
        stage: 'CANCEL_PENDING',
        oldSymbol: seatState.symbol,
        nextSymbol: next?.symbol ?? null,
        nextCallPrice: next?.callPrice ?? null,
        startedAt: now().getTime(),
        sellSubmitted: false,
        sellNotional: null,
        shouldRebuy: hasPosition,
        awaitingQuote: false,
      });

      const pendingOrdersForOldSymbol = await trader.getPendingOrders([seatState.symbol]);
      await processSwitchState(
        { direction, monitorPrice, quotesMap, positions },
        switchStates.get(direction)!,
        pendingOrdersForOldSymbol,
      );
    }
  }

  return {
    maybeSwitchOnDistance,
    hasPendingSwitch,
  };
}
