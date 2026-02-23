/**
 * 自动换标模块：换标状态机
 *
 * 职责：
 * - 统一处理距离换标与周期换标的启动入口
 * - 推进换标状态机（撤单/卖出/绑定/等待行情/回补/完成）
 * - 处理周期换标到期后的空仓等待与触发
 */
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import type { Position } from '../../types/account.js';
import type { SeatState } from '../../types/seat.js';
import type { PendingOrder } from '../../types/services.js';
import type {
  SwitchMode,
  SwitchOnDistanceParams,
  SwitchOnIntervalParams,
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
function extractPosition(positions: ReadonlyArray<Position>, symbol: string): Position | null {
  if (!symbol) {
    return null;
  }
  return positions.find((pos) => pos.symbol === symbol) ?? null;
}

/**
 * 创建换标状态机，管理从撤单到回补买入的完整换标流程，并提供周期换标触发能力。
 * @param deps - 依赖（trader、orderRecorder、riskChecker、switchStates、buildOrderSignal、signalObjectPool 等）
 * @returns SwitchStateMachine 实例（maybeSwitchOnInterval、maybeSwitchOnDistance、hasPendingSwitch）
 */
export function createSwitchStateMachine(deps: SwitchStateMachineDeps): SwitchStateMachine {
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
    periodicSwitchPending,
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
    getTradingMinutesSinceOpen,
  } = deps;

  type StartSwitchFlowParams = {
    readonly direction: 'LONG' | 'SHORT';
    readonly reason: string;
    readonly switchMode: SwitchMode;
    readonly distanceContext?: SwitchOnDistanceParams;
    readonly processImmediately: boolean;
  };

  /** 判断订单是否为指定标的的可撤销买入挂单 */
  function isCancelableBuyOrder(order: PendingOrder, symbol: string): boolean {
    return (
      order.symbol === symbol && order.side === buySide && pendingOrderStatuses.has(order.status)
    );
  }

  /** 清除某方向的周期换标 pending 状态。 */
  function clearPeriodicPending(direction: 'LONG' | 'SHORT'): void {
    periodicSwitchPending.delete(direction);
  }

  /** 标记某方向已进入周期换标 pending（等待空仓）。 */
  function markPeriodicPending(direction: 'LONG' | 'SHORT', pendingSinceMs: number): void {
    periodicSwitchPending.set(direction, {
      pending: true,
      pendingSinceMs,
    });
  }

  /** 读取某方向的周期换标 pending 状态。 */
  function resolvePeriodicPending(direction: 'LONG' | 'SHORT'): {
    pending: boolean;
    pendingSinceMs: number | null;
  } {
    const state = periodicSwitchPending.get(direction);
    if (!state) {
      return {
        pending: false,
        pendingSinceMs: null,
      };
    }
    return state;
  }

  /** 判断席位是否为可触发换标的 READY 状态。 */
  function isReadySeat(seatState: SeatState): seatState is SeatState & { symbol: string } {
    return (
      seatState.status === 'READY' &&
      typeof seatState.symbol === 'string' &&
      seatState.symbol.length > 0
    );
  }

  /** 判断指定方向是否存在有效的进行中换标流程 */
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
      seatState.symbol === switchState.oldSymbol || seatState.symbol === switchState.nextSymbol;
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
   * 统一换标启动入口：
   * - 预寻标
   * - 同标的抑制
   * - 清席位并写入 switchStates
   * - 按需决定是否立即推进状态机（仅距离换标）
   */
  async function startSwitchFlow(params: StartSwitchFlowParams): Promise<void> {
    const { direction, reason, switchMode, distanceContext, processImmediately } = params;
    if (hasPendingSwitch(direction)) {
      return;
    }

    const seatState = symbolRegistry.getSeatState(monitorSymbol, direction);
    if (!isReadySeat(seatState)) {
      clearPeriodicPending(direction);
      return;
    }

    const seatSymbol = seatState.symbol;
    if (resolveSuppression(direction, seatSymbol)) {
      return;
    }

    const next = await findSwitchCandidate(direction);
    if (next?.symbol === seatSymbol) {
      markSuppression(direction, seatSymbol);
      logger.info(`[自动换标] ${monitorSymbol} ${direction} 预寻标命中同标的，记录当日抑制`);
      return;
    }

    const seatVersion = clearSeat({ direction, reason });
    clearPeriodicPending(direction);

    let shouldRebuy = false;
    if (switchMode === 'DISTANCE' && distanceContext) {
      const position = extractPosition(distanceContext.positions, seatSymbol);
      shouldRebuy = (position?.quantity ?? 0) > 0;
    }

    switchStates.set(direction, {
      direction,
      switchMode,
      seatVersion,
      stage: 'CANCEL_PENDING',
      oldSymbol: seatSymbol,
      nextSymbol: next?.symbol ?? null,
      nextCallPrice: next?.callPrice ?? null,
      startedAt: now().getTime(),
      sellSubmitted: false,
      sellNotional: null,
      shouldRebuy,
      awaitingQuote: false,
    });

    if (!processImmediately || !distanceContext) {
      return;
    }

    const startedState = switchStates.get(direction);
    if (!startedState) {
      return;
    }
    const pendingOrdersForOldSymbol = await trader.getPendingOrders([startedState.oldSymbol]);
    await processSwitchState(distanceContext, startedState, pendingOrdersForOldSymbol);
  }

  /**
   * 推进换标状态机，按阶段顺序执行撤单→卖出→绑定新标→等待行情→回补买入→完成。
   * 每次调用只推进到当前阶段的终点，需要等待外部条件时提前返回，下一次 tick 再继续。
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
            lastSeatReadyAt: currentSeat.lastSeatReadyAt,
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
            lastSeatReadyAt: currentSeat.lastSeatReadyAt,
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
      state.stage = state.switchMode === 'PERIODIC' ? 'BIND_NEW' : 'SELL_OUT';
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
      const currentSeat = symbolRegistry.getSeatState(monitorSymbol, direction);
      updateSeatState(
        direction,
        buildSeatState({
          symbol: nextSymbol,
          status: 'SWITCHING',
          lastSwitchAt: bindNowMs,
          lastSearchAt: bindNowMs,
          lastSeatReadyAt: currentSeat.lastSeatReadyAt,
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
      const buyQuantity = calculateBuyQuantityByNotional(buyNotional, quote.price, quote.lotSize);

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
            lastSeatReadyAt: completeNowMs,
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

  /**
   * 每 tick 检查是否满足周期换标触发条件。
   * 到期后若仍有持仓，则进入 pending 等待空仓；空仓后触发周期换标流程。
   */
  async function maybeSwitchOnInterval({
    direction,
    currentTime,
    canTradeNow,
    openProtectionActive,
  }: SwitchOnIntervalParams): Promise<void> {
    if (!autoSearchConfig.autoSearchEnabled || autoSearchConfig.switchIntervalMinutes <= 0) {
      clearPeriodicPending(direction);
      return;
    }

    if (hasPendingSwitch(direction)) {
      clearPeriodicPending(direction);
      return;
    }

    const seatState = symbolRegistry.getSeatState(monitorSymbol, direction);
    if (!isReadySeat(seatState)) {
      clearPeriodicPending(direction);
      return;
    }

    const periodicPendingState = resolvePeriodicPending(direction);
    if (
      periodicPendingState.pending &&
      periodicPendingState.pendingSinceMs != null &&
      seatState.lastSeatReadyAt != null &&
      seatState.lastSeatReadyAt > periodicPendingState.pendingSinceMs
    ) {
      clearPeriodicPending(direction);
    }

    if (!canTradeNow || openProtectionActive) {
      return;
    }

    if (seatState.lastSeatReadyAt == null) {
      clearPeriodicPending(direction);
      return;
    }

    const currentTradingMinutes = getTradingMinutesSinceOpen(currentTime);
    const readyTradingMinutes = getTradingMinutesSinceOpen(new Date(seatState.lastSeatReadyAt));
    if (currentTradingMinutes < readyTradingMinutes) {
      clearPeriodicPending(direction);
      return;
    }
    const elapsedTradingMinutes = currentTradingMinutes - readyTradingMinutes;
    if (elapsedTradingMinutes < autoSearchConfig.switchIntervalMinutes) {
      clearPeriodicPending(direction);
      return;
    }

    const buyOrders = orderRecorder.getBuyOrdersForSymbol(seatState.symbol, direction === 'LONG');
    if (buyOrders.length > 0) {
      const pendingState = resolvePeriodicPending(direction);
      if (!pendingState.pending) {
        markPeriodicPending(direction, currentTime.getTime());
        logger.warn(
          `[自动换标] ${monitorSymbol} ${direction} 周期换标到期但仍有持仓，进入等待空仓状态`,
        );
      }
      return;
    }

    const pendingState = resolvePeriodicPending(direction);
    if (pendingState.pending) {
      logger.info(`[自动换标] ${monitorSymbol} ${direction} 周期换标等待结束，检测到空仓开始换标`);
    }
    clearPeriodicPending(direction);

    await startSwitchFlow({
      direction,
      reason: '周期换标触发',
      switchMode: 'PERIODIC',
      processImmediately: false,
    });
  }

  /**
   * 每 tick 检查当前席位距回收价是否越界，越界时触发距离换标流程。
   * 若已有进行中的换标则继续推进状态机。
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

    if (hasPendingSwitch(direction)) {
      const pendingSwitch = switchStates.get(direction);
      if (!pendingSwitch) {
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
    if (!isReadySeat(seatState)) {
      clearPeriodicPending(direction);
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

    if (distancePercent <= range.min || distancePercent >= range.max) {
      clearPeriodicPending(direction);
      await startSwitchFlow({
        direction,
        reason: '距回收价阈值越界',
        switchMode: 'DISTANCE',
        distanceContext: { direction, monitorPrice, quotesMap, positions },
        processImmediately: true,
      });
    }
  }

  return {
    maybeSwitchOnInterval,
    maybeSwitchOnDistance,
    hasPendingSwitch,
  };
}
