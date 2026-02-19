/**
 * 自动换标模块：换标状态机
 *
 * 职责：
 * - 撤单/卖出/绑定/等待行情/回补/完成
 * - 距离阈值触发与日内抑制
 */
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import type { Position } from '../../types/account.js';
import type { PendingOrder } from '../../types/services.js';
import type {
  SwitchOnDistanceParams,
  SwitchState,
  SwitchStateMachine,
  SwitchStateMachineDeps,
} from './types.js';
import { resolveNextSearchFailureState } from './utils.js';

/**
 * 从持仓列表中提取指定标的的持仓信息。
 * @param positions - 持仓列表
 * @param symbol - 标的代码
 * @returns 匹配的持仓，无则 null
 */
function extractPosition(
  positions: ReadonlyArray<Position>,
  symbol: string,
): Position | null {
  if (!symbol) {
    return null;
  }
  return positions.find((pos) => pos.symbol === symbol) ?? null;
}

/**
 * 创建换标状态机，管理从撤单到回补买入的完整换标流程；通过距回收价阈值触发，含日内抑制与预寻标。
 * @param deps - 依赖（trader、orderRecorder、riskChecker、switchStates、buildOrderSignal、signalObjectPool 等）
 * @returns SwitchStateMachine 实例（maybeSwitchOnDistance、hasPendingSwitch）
 */
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
    maxSearchFailuresPerDay,
    getHKDateKey,
  } = deps;

  /** 判断订单是否为指定标的的可撤销买入挂单 */
  function isCancelableBuyOrder(order: PendingOrder, symbol: string): boolean {
    return order.symbol === symbol
      && order.side === buySide
      && pendingOrderStatuses.has(order.status);
  }

  /** 预寻标：在触发换标前查找候选标的，无合适标的时返回 null */
  async function findSwitchCandidate(
    direction: 'LONG' | 'SHORT',
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
   * 推进换标状态机，按阶段顺序执行撤单→卖出→绑定新标→等待行情→回补买入→完成。
   * 每次调用只推进到当前阶段的终点，需要等待外部条件（如持仓清零、行情到达）时提前返回，
   * 下一个 tick 再次调用时从当前阶段继续，直至 COMPLETE 或 FAILED。
   */
  async function processSwitchState(
    params: SwitchOnDistanceParams,
    state: SwitchState,
    pendingOrders: ReadonlyArray<PendingOrder>,
  ): Promise<void> {
    const { direction, quotesMap, positions } = params;
    const { sellAction, buyAction } = resolveDirectionSymbols(direction);
    const seatVersion = symbolRegistry.getSeatVersion(monitorSymbol, direction);

    function failAndClear(): void {
      state.stage = 'FAILED';
      const currentSeat = symbolRegistry.getSeatState(monitorSymbol, direction);
      const nowDate = now();
      const nowMs = nowDate.getTime();
      if (state.nextSymbol == null) {
        const hkDateKey = getHKDateKey(nowDate);
        const { nextFailCount, frozenTradingDayKey, shouldFreeze } = resolveNextSearchFailureState({
          currentSeat,
          hkDateKey,
          maxSearchFailuresPerDay,
        });
        if (shouldFreeze) {
          logger.warn(
            `[自动换标] ${monitorSymbol} ${direction} 当日寻标失败达 ${nextFailCount} 次，席位冻结`,
          );
        }
        updateSeatState(
          direction,
          buildSeatState({
            symbol: null,
            status: 'EMPTY',
            lastSwitchAt: currentSeat.lastSwitchAt,
            lastSearchAt: nowMs,
            callPrice: null,
            searchFailCountToday: nextFailCount,
            frozenTradingDayKey,
          }),
          false,
        );
      } else {
        updateSeatState(
          direction,
          buildSeatState({
            symbol: null,
            status: 'EMPTY',
            lastSwitchAt: currentSeat.lastSwitchAt,
            lastSearchAt: nowMs,
            callPrice: null,
            searchFailCountToday: 0,
            frozenTradingDayKey: null,
          }),
          false,
        );
      }
      switchStates.delete(direction);
    }

    if (state.stage === 'CANCEL_PENDING') {
      const cancelTargets = pendingOrders.filter((order) =>
        isCancelableBuyOrder(order, state.oldSymbol),
      );

      if (cancelTargets.length > 0) {
        const results = await Promise.all(
          cancelTargets.map((order) => trader.cancelOrder(order.orderId)),
        );
        if (results.some((ok) => !ok)) {
          failAndClear();
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

      if (isValidPositiveNumber(totalQuantity) && availableQuantity === 0) {
        return;
      }

      if (isValidPositiveNumber(availableQuantity)) {
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
        if (isValidPositiveNumber(actualNotional)) {
          state.sellNotional = actualNotional;
        }
      }

      state.stage = 'BIND_NEW';
    }

    if (state.stage === 'BIND_NEW') {
      const nextSymbol = state.nextSymbol;
      if (!nextSymbol) {
        failAndClear();
        return;
      }

      const bindNowMs = now().getTime();
      updateSeatState(
        direction,
        buildSeatState({
          symbol: nextSymbol,
          status: 'SWITCHING',
          lastSwitchAt: bindNowMs,
          lastSearchAt: bindNowMs,
          callPrice: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        }),
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
        failAndClear();
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
        failAndClear();
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

      if (buyQuantity != null && isValidPositiveNumber(buyQuantity)) {
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
      } else {
        logger.info(
          `[自动换标] 回补买入数量无效或过小，跳过回补: ${nextSymbol}, buyQuantity=${String(buyQuantity)}`,
        );
      }
      state.stage = 'COMPLETE';
    }

    if (state.stage === 'COMPLETE') {
      const nextSymbol = state.nextSymbol;
      if (nextSymbol) {
        const completeNowMs = now().getTime();
        updateSeatState(
          direction,
          buildSeatState({
            symbol: nextSymbol,
            status: 'READY',
            lastSwitchAt: completeNowMs,
            lastSearchAt: completeNowMs,
            callPrice: state.nextCallPrice ?? null,
            searchFailCountToday: 0,
            frozenTradingDayKey: null,
          }),
          false,
        );
      }
      switchStates.delete(direction);
    }
  }

  /** 检查指定方向是否存在有效的进行中换标流程 */
  function hasPendingSwitch(direction: 'LONG' | 'SHORT'): boolean {
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
   * 每 tick 检查当前席位距回收价是否越界，越界时触发换标流程。
   * 若已有进行中的换标则继续推进状态机；日内抑制防止同一标的重复触发；
   * 预寻标结果与旧标的相同时记录抑制并跳过，避免无效换标。
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
        logger.warn(`[自动换标] 进行中换标已清除: ${monitorSymbol} ${direction}`);
        return;
      }
      const symbolMatches =
        currentSeatState.symbol === pendingSwitch.oldSymbol ||
        currentSeatState.symbol === pendingSwitch.nextSymbol;
      if (!symbolMatches) {
        switchStates.delete(direction);
        logger.warn(`[自动换标] 进行中换标已清除: ${monitorSymbol} ${direction}`);
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
      if (next?.symbol === seatState.symbol) {
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
      const nextState = switchStates.get(direction);
      if (!nextState) {
        return;
      }
      await processSwitchState(
        { direction, monitorPrice, quotesMap, positions },
        nextState,
        pendingOrdersForOldSymbol,
      );
    }
  }

  return {
    maybeSwitchOnDistance,
    hasPendingSwitch,
  };
}
