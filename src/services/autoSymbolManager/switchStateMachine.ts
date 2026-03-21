/**
 * 自动换标模块：换标状态机
 *
 * 功能：管理从撤单到回补买入的完整换标流程。
 * 职责：统一处理距离换标与周期换标的启动入口，推进换标状态机（撤单/卖出/绑定/等待行情/回补/完成），处理周期换标到期后的空仓等待与触发。
 * 执行流程：maybeSwitchOnDistance/maybeSwitchOnInterval 触发 → startSwitchFlow 初始化状态 → processSwitchState 推进各阶段 → 完成或失败。
 */
import { ORDER_QUOTE_RETRY } from '../../constants/index.js';
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import type { DecimalInput } from '../../utils/numeric/types.js';
import { isQuoteReadyForRequirement, resolveNextQuoteRetry } from '../../utils/quoteRetry.js';
import { decimalGte, decimalLte } from '../../utils/numeric/index.js';
import type { Position } from '../../types/account.js';
import type { Quote } from '../../types/quote.js';
import type { SeatState } from '../../types/seat.js';
import type { PendingOrder } from '../../types/services.js';
import type { CancelOrderOutcome } from '../../types/trader.js';
import { isCancelAcceptedOrTerminalNonFilledClose } from '../../core/trader/utils.js';
import type {
  PeriodicSeatBlockSource,
  PeriodicSeatBlockingReason,
  PeriodicSwitchPendingState,
  StartSwitchFlowParams,
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

function hasQuoteRetryElapsed(state: SwitchState, nowMs: number): boolean {
  return state.quoteRetryNextAt === null || nowMs >= state.quoteRetryNextAt;
}

function resetQuoteRetryState(state: SwitchState): void {
  state.quoteRetryAttempts = 0;
  state.quoteRetryNextAt = null;
  state.quoteRetryExhausted = false;
}

function advanceQuoteRetryState(state: SwitchState, nowMs: number): void {
  const nextRetry = resolveNextQuoteRetry({
    attempts: state.quoteRetryAttempts,
    nowMs,
    intervalMs: ORDER_QUOTE_RETRY.INTERVAL_MS,
    maxAttempts: ORDER_QUOTE_RETRY.MAX_ATTEMPTS,
  });
  state.quoteRetryAttempts = nextRetry.nextAttempts;
  state.quoteRetryNextAt = nextRetry.nextRetryAt;
  state.quoteRetryExhausted = nextRetry.exhausted;
}

function isQuoteReadyForRebuy(
  quote: Quote | null | undefined,
): quote is Quote & { lotSize: number } {
  return (
    isQuoteReadyForRequirement({ quote, requirement: 'PRICE_AND_LOT_SIZE' }) &&
    quote !== null &&
    quote !== undefined &&
    isValidPositiveNumber(quote.lotSize)
  );
}

async function fetchRealtimeQuote(
  marketDataClient: SwitchStateMachineDeps['marketDataClient'],
  symbol: string,
): Promise<Quote | null> {
  const quotes = await marketDataClient.getQuotes([symbol]);
  return quotes.get(symbol) ?? null;
}

/** 判断席位是否为可触发换标的 ACTIVE 状态。 */
function isActiveSeat(seatState: SeatState): seatState is SeatState & { symbol: string } {
  return (
    seatState.status === 'ACTIVE' &&
    typeof seatState.symbol === 'string' &&
    seatState.symbol.length > 0
  );
}

/**
 * 判断周期 pending 是否应因席位重新进入 ACTIVE 而失效。
 * 仅当 lastSeatActivatedAt 晚于 pendingSinceMs 时失效，表示周期基线已重置。
 */
function shouldResetPeriodicPendingBySeatActivatedAt(params: {
  readonly pendingSinceMs: number | null;
  readonly lastSeatActivatedAt: number | null;
}): boolean {
  if (params.pendingSinceMs === null || params.lastSeatActivatedAt === null) {
    return false;
  }

  return params.lastSeatActivatedAt > params.pendingSinceMs;
}

function resolveCancelFailureReason(outcome: CancelOrderOutcome): string {
  if (outcome.kind === 'ALREADY_CLOSED') {
    return `${outcome.kind}:${outcome.closedReason}`;
  }

  if (outcome.kind === 'RETRYABLE_FAILURE' || outcome.kind === 'UNKNOWN_FAILURE') {
    return `${outcome.kind}:${outcome.errorCode ?? 'UNKNOWN'}`;
  }

  return outcome.kind;
}

function isFilledCloseOutcome(outcome: CancelOrderOutcome): boolean {
  return outcome.kind === 'ALREADY_CLOSED' && outcome.closedReason === 'FILLED';
}

function hasOpenBuyExposure(params: {
  readonly orderRecorder: SwitchStateMachineDeps['orderRecorder'];
  readonly symbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly positions: ReadonlyArray<Position>;
}): boolean {
  const { orderRecorder, symbol, direction, positions } = params;
  const buyOrders = orderRecorder.getBuyOrdersForSymbol(symbol, direction === 'LONG');
  if (buyOrders.length > 0) {
    return true;
  }

  const position = extractPosition(positions, symbol);
  return (position?.quantity ?? 0) > 0;
}

/**
 * 统一判定周期换标是否仍被本地席位占用阻塞。
 * 周期换标只关心当前席位标的是否仍有未平仓买单记录，或仍有任意本地 pending order 链路。
 */
function resolvePeriodicSeatBlockSource(params: {
  readonly orderRecorder: SwitchStateMachineDeps['orderRecorder'];
  readonly trader: SwitchStateMachineDeps['trader'];
  readonly symbol: string;
  readonly direction: 'LONG' | 'SHORT';
}): PeriodicSeatBlockSource {
  const { orderRecorder, trader, symbol, direction } = params;
  const buyOrders = orderRecorder.getBuyOrdersForSymbol(symbol, direction === 'LONG');
  if (buyOrders.length > 0) {
    return 'ORDER_RECORDER';
  }

  if (trader.getOrderHoldSymbols().has(symbol)) {
    return 'LOCAL_PENDING_ORDER';
  }

  return 'EMPTY';
}

function resolveDistanceTriggerSide(params: {
  readonly direction: 'LONG' | 'SHORT';
  readonly distancePercent: DecimalInput;
  readonly range: { readonly min: DecimalInput; readonly max: DecimalInput };
}): 'SAFE' | 'DANGER' | null {
  const { direction, distancePercent, range } = params;
  if (direction === 'LONG') {
    if (decimalLte(distancePercent, range.min)) {
      return 'DANGER';
    }

    if (decimalGte(distancePercent, range.max)) {
      return 'SAFE';
    }

    return null;
  }

  if (decimalGte(distancePercent, range.max)) {
    return 'DANGER';
  }

  if (decimalLte(distancePercent, range.min)) {
    return 'SAFE';
  }

  return null;
}

/**
 * 创建换标状态机，管理从撤单到回补买入的完整换标流程，并提供周期换标触发能力。
 * @param deps - 依赖（trader、orderRecorder、riskChecker、switchStates、buildOrderSignal、signalObjectPool 等）
 * @returns SwitchStateMachine 实例（maybeSwitchOnInterval、maybeSwitchOnDistance、hasPendingSwitch）
 */
export function createSwitchStateMachine(deps: SwitchStateMachineDeps): SwitchStateMachine {
  const {
    autoSearchConfig,
    monitorSymbol,
    symbolRegistry,
    trader,
    orderRecorder,
    riskChecker,
    marketDataClient,
    now,
    switchStates,
    periodicSwitchPending,
    resolveSuppression,
    markSuppression,
    enterSwitchingSeat,
    buildSeatState,
    updateSeatState,
    resolveDirectionalAutoSearchPolicy,
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
    calculateTradingDurationMsBetween,
    getTradingCalendarSnapshot,
  } = deps;

  /** 判断订单是否为指定标的的可撤销买入挂单 */
  function isCancelableBuyOrder(order: PendingOrder, symbol: string): boolean {
    return (
      order.symbol === symbol && order.side === buySide && pendingOrderStatuses.has(order.status)
    );
  }

  async function executeSwitchSignal(
    signal: ReturnType<SwitchStateMachineDeps['buildOrderSignal']>,
    submitFailedMessage: string,
  ): Promise<Awaited<ReturnType<SwitchStateMachineDeps['trader']['executeSignals']>> | null> {
    let executionResult: Awaited<ReturnType<SwitchStateMachineDeps['trader']['executeSignals']>>;
    try {
      executionResult = await trader.executeSignals([signal]);
    } finally {
      signalObjectPool.release(signal);
    }

    if (executionResult.submittedCount <= 0) {
      logger.warn(submitFailedMessage);
      return null;
    }

    return executionResult;
  }

  /** 清除某方向的周期换标 pending 状态。 */
  function clearPeriodicPending(direction: 'LONG' | 'SHORT'): void {
    periodicSwitchPending.delete(direction);
  }

  /** 标记某方向已进入周期换标 pending（等待空仓）。 */
  function markPeriodicPending(
    direction: 'LONG' | 'SHORT',
    pendingSinceMs: number,
    blockedBy: PeriodicSeatBlockingReason,
  ): void {
    periodicSwitchPending.set(direction, {
      pending: true,
      pendingSinceMs,
      blockedBy,
    });
  }

  /** 读取某方向的周期换标 pending 状态。 */
  function resolvePeriodicPending(direction: 'LONG' | 'SHORT'): PeriodicSwitchPendingState {
    const state = periodicSwitchPending.get(direction);
    if (!state) {
      return {
        pending: false,
        pendingSinceMs: null,
      };
    }

    return state;
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
    const policy = resolveDirectionalAutoSearchPolicy({
      direction,
      logPrefix: '[自动换标] 缺少阈值配置，无法预寻标',
    });
    if (policy === null) {
      return null;
    }

    const input = await buildFindBestWarrantInput({
      currentTime: now(),
      policy,
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
   * - 将席位切换为 SWITCHING 并写入 switchStates
   * - 按需决定是否立即推进状态机（仅距离换标）
   */
  async function startSwitchFlow(params: StartSwitchFlowParams): Promise<void> {
    const isPeriodicTrigger = params.triggerKind === 'PERIODIC';
    const direction = isPeriodicTrigger ? params.direction : params.distanceContext.direction;
    const reason = params.reason;
    const switchMode = isPeriodicTrigger ? 'PERIODIC' : 'DISTANCE';
    const suppressionTriggerKind =
      params.triggerKind === 'DISTANCE_DANGER_SIDE' ? null : params.triggerKind;
    const distanceContext = isPeriodicTrigger ? null : params.distanceContext;

    if (hasPendingSwitch(direction)) {
      return;
    }

    const seatState = symbolRegistry.getSeatState(monitorSymbol, direction);
    if (!isActiveSeat(seatState)) {
      clearPeriodicPending(direction);
      return;
    }

    const seatVersionAtStart = symbolRegistry.getSeatVersion(monitorSymbol, direction);
    const seatSymbol = seatState.symbol;
    if (
      suppressionTriggerKind !== null &&
      resolveSuppression(direction, seatSymbol, suppressionTriggerKind)
    ) {
      return;
    }

    const next = await findSwitchCandidate(direction);
    const latestSeatState = symbolRegistry.getSeatState(monitorSymbol, direction);
    const latestSeatVersion = symbolRegistry.getSeatVersion(monitorSymbol, direction);
    if (!isActiveSeat(latestSeatState)) {
      clearPeriodicPending(direction);
      return;
    }

    if (latestSeatVersion !== seatVersionAtStart || latestSeatState.symbol !== seatSymbol) {
      clearPeriodicPending(direction);
      return;
    }

    if (switchMode === 'PERIODIC') {
      const periodicBlockSource = resolvePeriodicSeatBlockSource({
        orderRecorder,
        trader,
        symbol: latestSeatState.symbol,
        direction,
      });
      if (periodicBlockSource !== 'EMPTY') {
        markPeriodicPending(direction, now().getTime(), periodicBlockSource);
        logger.warn(
          `[自动换标] ${monitorSymbol} ${direction} 周期换标触发前复核发现本地占用，继续等待 blockedBy=${periodicBlockSource}`,
        );
        return;
      }
    }

    if (next?.symbol === latestSeatState.symbol) {
      if (suppressionTriggerKind !== null) {
        markSuppression(direction, latestSeatState.symbol, suppressionTriggerKind);
        logger.info(`[自动换标] ${monitorSymbol} ${direction} 预寻标命中同标的，记录当日抑制`);
      }

      return;
    }

    const seatVersion = enterSwitchingSeat({ direction, reason });
    clearPeriodicPending(direction);

    let shouldRebuy = false;
    if (distanceContext !== null) {
      const position = extractPosition(distanceContext.positions, latestSeatState.symbol);
      shouldRebuy = (position?.quantity ?? 0) > 0;
    }

    switchStates.set(direction, {
      direction,
      switchMode,
      seatVersion,
      stage: 'CANCEL_PENDING',
      oldSymbol: latestSeatState.symbol,
      nextSymbol: next?.symbol ?? null,
      nextCallPrice: next?.callPrice ?? null,
      sellSubmitted: false,
      sellOrderId: null,
      sellNotional: null,
      shouldRebuy,
      quoteRetryAttempts: 0,
      quoteRetryNextAt: null,
      quoteRetryExhausted: false,
      cancelRequestSubmitted: false,
    });

    if (switchMode === 'PERIODIC') {
      return;
    }

    const startedState = switchStates.get(direction);
    if (!startedState) {
      return;
    }

    if (distanceContext === null) {
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
    const { direction, positions } = params;
    const { sellAction, buyAction } = resolveDirectionSymbols(direction);
    const seatVersion = symbolRegistry.getSeatVersion(monitorSymbol, direction);
    let cachedNextQuote: Quote | null | undefined;

    async function getNextQuote(): Promise<Quote | null> {
      if (cachedNextQuote !== undefined) {
        return cachedNextQuote;
      }

      const nextSymbol = state.nextSymbol;
      if (!nextSymbol) {
        return null;
      }

      cachedNextQuote = await fetchRealtimeQuote(marketDataClient, nextSymbol);
      return cachedNextQuote;
    }

    function failAndClear(reason: string): void {
      logger.error(
        `[自动换标] 状态机失败并清席位 ` +
          `monitorSymbol=${monitorSymbol} direction=${direction} oldSymbol=${state.oldSymbol} ` +
          `nextSymbol=${state.nextSymbol ?? 'null'} stage=${state.stage} reason=${reason}`,
      );
      state.stage = 'FAILED';
      const currentSeat = symbolRegistry.getSeatState(monitorSymbol, direction);
      const nowDate = now();
      const nowMs = nowDate.getTime();
      if (state.nextSymbol === null) {
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
            lastSeatActivatedAt: currentSeat.lastSeatActivatedAt,
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
            lastSeatActivatedAt: currentSeat.lastSeatActivatedAt,
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

      if (cancelTargets.length > 0 && !state.cancelRequestSubmitted) {
        const cancelOutcomes = await Promise.all(
          cancelTargets.map((order) => trader.cancelOrder(order.orderId)),
        );
        const sawFilledOutcome = cancelOutcomes.some(isFilledCloseOutcome);
        if (sawFilledOutcome && state.switchMode === 'DISTANCE') {
          state.shouldRebuy = true;
        }

        const unconfirmedOutcome = cancelOutcomes.find(
          (outcome) =>
            !isCancelAcceptedOrTerminalNonFilledClose(outcome) && !isFilledCloseOutcome(outcome),
        );
        if (unconfirmedOutcome) {
          failAndClear(`CANCEL_PENDING_FAILED:${resolveCancelFailureReason(unconfirmedOutcome)}`);
          return;
        }

        state.cancelRequestSubmitted = true;
        return;
      }

      if (cancelTargets.length > 0) {
        return;
      }

      const openBuyExposure = hasOpenBuyExposure({
        orderRecorder,
        symbol: state.oldSymbol,
        direction,
        positions,
      });
      if (state.switchMode === 'PERIODIC' && openBuyExposure) {
        return;
      }

      if (state.switchMode === 'DISTANCE' && openBuyExposure) {
        state.shouldRebuy = true;
      }

      state.cancelRequestSubmitted = false;
      resetQuoteRetryState(state);
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

        if (!hasQuoteRetryElapsed(state, now().getTime())) {
          return;
        }

        const quote = await fetchRealtimeQuote(marketDataClient, state.oldSymbol);
        if (!isQuoteReadyForRequirement({ quote, requirement: 'PRICE' })) {
          advanceQuoteRetryState(state, now().getTime());
          if (state.quoteRetryExhausted) {
            failAndClear('QUOTE_RETRY_EXHAUSTED:SELL_OUT');
          }

          return;
        }

        resetQuoteRetryState(state);

        const signal = buildOrderSignal({
          action: sellAction,
          symbol: state.oldSymbol,
          quote,
          reason: '自动换标-移仓卖出',
          orderTypeOverride: 'ELO',
          quantity: availableQuantity,
          seatVersion,
        });

        const executionResult = await executeSwitchSignal(
          signal,
          `[自动换标] 移仓卖出未提交成功，等待重试: monitorSymbol=${monitorSymbol} direction=${direction} symbol=${state.oldSymbol}`,
        );
        if (executionResult === null) {
          return;
        }

        state.sellSubmitted = true;
        state.sellOrderId = executionResult.submittedOrderIds[0] ?? null;
        return;
      }

      if (state.shouldRebuy && !state.sellSubmitted && !isValidPositiveNumber(totalQuantity)) {
        const openBuyExposure = hasOpenBuyExposure({
          orderRecorder,
          symbol: state.oldSymbol,
          direction,
          positions,
        });
        if (openBuyExposure) {
          return;
        }

        state.shouldRebuy = false;
      }

      if (state.sellOrderId !== null) {
        const sellRecord = orderRecorder.getSellRecordByOrderId(state.sellOrderId);
        const actualNotional = sellRecord
          ? sellRecord.executedPrice * sellRecord.executedQuantity
          : Number.NaN;
        if (isValidPositiveNumber(actualNotional)) {
          state.sellNotional = actualNotional;
        }
      }

      state.stage = 'BIND_NEW';
    }

    if (state.stage === 'BIND_NEW') {
      const nextSymbol = state.nextSymbol;
      if (!nextSymbol) {
        failAndClear('MISSING_NEXT_SYMBOL_ON_BIND');
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
          lastSeatActivatedAt: currentSeat.lastSeatActivatedAt,
          callPrice: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        }),
        false,
      );

      resetQuoteRetryState(state);
      state.stage = state.shouldRebuy ? 'WAIT_QUOTE' : 'COMPLETE';
    }

    if (state.stage === 'WAIT_QUOTE') {
      const nextSymbol = state.nextSymbol;
      if (!nextSymbol) {
        failAndClear('MISSING_NEXT_SYMBOL_ON_WAIT_QUOTE');
        return;
      }

      if (!hasQuoteRetryElapsed(state, now().getTime())) {
        return;
      }

      const quote = await getNextQuote();
      if (!isQuoteReadyForRebuy(quote)) {
        advanceQuoteRetryState(state, now().getTime());
        if (state.quoteRetryExhausted) {
          failAndClear('QUOTE_RETRY_EXHAUSTED:WAIT_QUOTE');
        }

        return;
      }

      state.stage = 'REBUY';
    }

    if (state.stage === 'REBUY') {
      const nextSymbol = state.nextSymbol;
      if (!nextSymbol) {
        failAndClear('MISSING_NEXT_SYMBOL_ON_REBUY');
        return;
      }

      const quote = await getNextQuote();
      if (!isQuoteReadyForRebuy(quote)) {
        if (!hasQuoteRetryElapsed(state, now().getTime())) {
          state.stage = 'WAIT_QUOTE';
          return;
        }

        advanceQuoteRetryState(state, now().getTime());
        if (state.quoteRetryExhausted) {
          failAndClear('QUOTE_RETRY_EXHAUSTED:REBUY');
          return;
        }

        state.stage = 'WAIT_QUOTE';
        return;
      }

      resetQuoteRetryState(state);

      const buyNotional = state.sellNotional;
      if (!isValidPositiveNumber(buyNotional)) {
        failAndClear('MISSING_REBUY_NOTIONAL');
        return;
      }

      const buyQuantity = calculateBuyQuantityByNotional(buyNotional, quote.price, quote.lotSize);

      if (buyQuantity !== null && isValidPositiveNumber(buyQuantity)) {
        const signal = buildOrderSignal({
          action: buyAction,
          symbol: nextSymbol,
          quote,
          reason: '自动换标-移仓买入',
          orderTypeOverride: 'ELO',
          quantity: buyQuantity,
          seatVersion,
        });

        const executionResult = await executeSwitchSignal(
          signal,
          `[自动换标] 回补买入未提交成功，等待重试: monitorSymbol=${monitorSymbol} direction=${direction} symbol=${nextSymbol}`,
        );
        if (executionResult === null) {
          return;
        }
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
            status: 'ACTIVATING',
            lastSwitchAt: completeNowMs,
            lastSearchAt: completeNowMs,
            lastSeatActivatedAt: null,
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
   * 到期后若当前席位标的仍被本地订单链路占用，则进入 pending 等待；仅当本地未平仓买单记录与本地 pending order 都清空后才触发周期换标。
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
    if (!isActiveSeat(seatState)) {
      clearPeriodicPending(direction);
      return;
    }

    const periodicPendingState = resolvePeriodicPending(direction);
    if (
      periodicPendingState.pending &&
      shouldResetPeriodicPendingBySeatActivatedAt({
        pendingSinceMs: periodicPendingState.pendingSinceMs,
        lastSeatActivatedAt: seatState.lastSeatActivatedAt,
      })
    ) {
      clearPeriodicPending(direction);
    }

    const pendingStateAfterReset = resolvePeriodicPending(direction);
    if (pendingStateAfterReset.pending) {
      if (!canTradeNow || openProtectionActive) {
        return;
      }

      const blockSource = resolvePeriodicSeatBlockSource({
        orderRecorder,
        trader,
        symbol: seatState.symbol,
        direction,
      });
      if (blockSource !== 'EMPTY') {
        if (pendingStateAfterReset.blockedBy !== blockSource) {
          logger.warn(
            `[自动换标] ${monitorSymbol} ${direction} 周期换标继续等待，blockedBy=${blockSource}`,
          );
        }

        markPeriodicPending(
          direction,
          pendingStateAfterReset.pendingSinceMs ?? currentTime.getTime(),
          blockSource,
        );
        return;
      }

      logger.info(
        `[自动换标] ${monitorSymbol} ${direction} 周期换标等待结束，检测到本地空仓开始换标`,
      );
      clearPeriodicPending(direction);
      await startSwitchFlow({
        direction,
        reason: '周期换标触发',
        triggerKind: 'PERIODIC',
      });
      return;
    }

    if (!canTradeNow || openProtectionActive) {
      return;
    }

    if (seatState.lastSeatActivatedAt === null) {
      clearPeriodicPending(direction);
      return;
    }

    const elapsedTradingMs = calculateTradingDurationMsBetween({
      startMs: seatState.lastSeatActivatedAt,
      endMs: currentTime.getTime(),
      calendarSnapshot: getTradingCalendarSnapshot(),
    });
    const intervalMs = autoSearchConfig.switchIntervalMinutes * 60_000;
    if (elapsedTradingMs < intervalMs) {
      return;
    }

    const blockSource = resolvePeriodicSeatBlockSource({
      orderRecorder,
      trader,
      symbol: seatState.symbol,
      direction,
    });
    if (blockSource !== 'EMPTY') {
      const pendingState = resolvePeriodicPending(direction);
      if (!pendingState.pending || pendingState.blockedBy !== blockSource) {
        markPeriodicPending(direction, currentTime.getTime(), blockSource);
        logger.warn(
          `[自动换标] ${monitorSymbol} ${direction} 周期换标到期但本地仍被占用，进入等待空仓状态 blockedBy=${blockSource}`,
        );
      }

      return;
    }

    const pendingState = resolvePeriodicPending(direction);
    if (pendingState.pending) {
      logger.info(
        `[自动换标] ${monitorSymbol} ${direction} 周期换标等待结束，检测到本地空仓开始换标`,
      );
    }

    clearPeriodicPending(direction);

    await startSwitchFlow({
      direction,
      reason: '周期换标触发',
      triggerKind: 'PERIODIC',
    });
  }

  /**
   * 每 tick 检查当前席位距回收价是否越界，越界时触发距离换标流程。
   * 若已有进行中的换标则继续推进状态机。
   */
  async function maybeSwitchOnDistance({
    direction,
    monitorPrice,
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
        { direction, monitorPrice, positions },
        pendingSwitch,
        pendingOrdersForOldSymbol,
      );
      return;
    }

    if (monitorPrice === null) {
      return;
    }

    const seatState = symbolRegistry.getSeatState(monitorSymbol, direction);
    if (!isActiveSeat(seatState)) {
      clearPeriodicPending(direction);
      return;
    }

    const distanceInfo = riskChecker.getWarrantDistanceInfo(
      direction === 'LONG',
      seatState.symbol,
      monitorPrice,
    );
    const distancePercent = distanceInfo?.distanceToStrikePercent ?? null;
    const policy = resolveDirectionalAutoSearchPolicy({
      direction,
      logPrefix: '[自动换标] 缺少阈值配置，无法检查换标区间',
    });
    if (distancePercent === null || policy === null) {
      return;
    }

    const range = policy.switchDistanceRange;
    const distanceTriggerSide = resolveDistanceTriggerSide({
      direction,
      distancePercent,
      range,
    });
    if (distanceTriggerSide === null) {
      return;
    }

    await startSwitchFlow({
      reason: '距回收价阈值越界',
      triggerKind: distanceTriggerSide === 'SAFE' ? 'DISTANCE_SAFE_SIDE' : 'DISTANCE_DANGER_SIDE',
      distanceContext: { direction, monitorPrice, positions },
    });
  }

  return {
    maybeSwitchOnInterval,
    maybeSwitchOnDistance,
    hasPendingSwitch,
  };
}
