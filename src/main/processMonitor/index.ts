/**
 * @module processMonitor
 * @description 单个监控标的处理模块
 *
 * 核心职责：
 * - 处理单个监控标的的完整交易循环
 * - 实时监控价格变化和浮亏状态
 * - 获取K线数据，计算技术指标
 * - 生成交易信号并分发到对应队列
 *
 * 执行流程：
 * - 提取行情数据 → 自动换标/席位同步 → 监控价格/浮亏变化
 * - 获取K线/计算指标 → 缓存指标快照 → 获取持仓
 * - 生成信号 → 分流信号到队列/验证器
 *
 * 信号处理规则：
 * - 开盘保护期间：跳过信号生成，仅保留行情/指标展示
 *
 * 信号分流规则（交易时段内）：
 * - 立即卖出信号 → SellTaskQueue
 * - 立即买入信号 → BuyTaskQueue
 * - 延迟验证信号 → DelayedSignalVerifier
 */

import { buildIndicatorSnapshot } from '../../services/indicators/index.js';
import { logger } from '../../utils/logger/index.js';
import {
  positionObjectPool,
  signalObjectPool,
} from '../../utils/objectPool/index.js';
import {
  formatSignalLog,
  formatSymbolDisplay,
  formatError,
  releaseSnapshotObjects,
} from '../../utils/helpers/index.js';
import { MONITOR, VALID_SIGNAL_ACTIONS, TRADING, WARRANT_LIQUIDATION_ORDER_TYPE } from '../../constants/index.js';
import { getPositions } from './utils.js';
import { isSeatReady } from '../../services/autoSymbolManager/utils.js';

import type { CandleData, Signal, Quote, Position, RawOrderFromAPI } from '../../types/index.js';
import type { ProcessMonitorParams } from './types.js';

/**
 * 处理单个监控标的
 *
 * @param context 处理上下文，包含所有必要的依赖和状态
 * @param quotesMap 预先批量获取的行情数据 Map（提升性能，避免每个监控标的单独获取行情）
 */
export async function processMonitor(
  context: ProcessMonitorParams,
  quotesMap: ReadonlyMap<string, Quote | null>,
): Promise<void> {
  const { monitorContext, context: mainContext, runtimeFlags } = context;
  const {
    marketDataClient,
    trader,
    lastState,
    marketMonitor,
    indicatorCache,
    buyTaskQueue,
    sellTaskQueue,
    tradingConfig,
  } = mainContext;
  const { canTradeNow, openProtectionActive } = runtimeFlags;
  // 使用各自监控标的独立的延迟信号验证器（每个监控标的使用各自的验证配置）
  const {
    config,
    state,
    strategy,
    orderRecorder,
    dailyLossTracker,
    riskChecker,
    unrealizedLossMonitor,
    delayedSignalVerifier,
    symbolRegistry,
    autoSymbolManager,
  } = monitorContext;

  const MONITOR_SYMBOL = config.monitorSymbol;
  const autoSearchEnabled = config.autoSearchConfig.autoSearchEnabled;

  // 1. 从预先获取的行情 Map 中提取监控标的行情（无需单独 API 调用）
  const monitorQuote = quotesMap.get(MONITOR_SYMBOL) ?? null;

  const monitorCurrentPrice = monitorQuote?.price ?? null;
  const resolvedMonitorPrice = Number.isFinite(monitorCurrentPrice) ? monitorCurrentPrice : null;
  const lastMonitorPrice = Number.isFinite(state.monitorPrice) ? state.monitorPrice : null;
  const monitorPriceChanged =
    resolvedMonitorPrice != null &&
    (lastMonitorPrice == null ||
      Math.abs(resolvedMonitorPrice - lastMonitorPrice) > MONITOR.PRICE_CHANGE_THRESHOLD);
  if (monitorPriceChanged && resolvedMonitorPrice != null) {
    state.monitorPrice = resolvedMonitorPrice;
  }

  if (autoSearchEnabled) {
    await autoSymbolManager.maybeSearchOnTick({
      direction: 'LONG',
      currentTime: runtimeFlags.currentTime,
      canTradeNow,
    });
    await autoSymbolManager.maybeSearchOnTick({
      direction: 'SHORT',
      currentTime: runtimeFlags.currentTime,
      canTradeNow,
    });
  }

  if (monitorPriceChanged) {
    if (autoSearchEnabled) {
      const seatLong = symbolRegistry.getSeatState(MONITOR_SYMBOL, 'LONG');
      const seatShort = symbolRegistry.getSeatState(MONITOR_SYMBOL, 'SHORT');
      const pendingSymbols: string[] = [];
      if (seatLong.symbol) {
        pendingSymbols.push(seatLong.symbol);
      }
      if (seatShort.symbol && seatShort.symbol !== seatLong.symbol) {
        pendingSymbols.push(seatShort.symbol);
      }
      const pendingOrders =
        pendingSymbols.length > 0
          ? await trader.getPendingOrders(pendingSymbols)
          : [];

      await autoSymbolManager.maybeSwitchOnDistance({
        direction: 'LONG',
        monitorPrice: resolvedMonitorPrice,
        quotesMap,
        positions: lastState.cachedPositions,
        pendingOrders,
      });
      await autoSymbolManager.maybeSwitchOnDistance({
        direction: 'SHORT',
        monitorPrice: resolvedMonitorPrice,
        quotesMap,
        positions: lastState.cachedPositions,
        pendingOrders,
      });
    }
  }

  const previousSeatState = monitorContext.seatState;
  const previousLongSeatState = previousSeatState.long;
  const previousShortSeatState = previousSeatState.short;

  let longSeatState = symbolRegistry.getSeatState(MONITOR_SYMBOL, 'LONG');
  let shortSeatState = symbolRegistry.getSeatState(MONITOR_SYMBOL, 'SHORT');
  let longSeatVersion = symbolRegistry.getSeatVersion(MONITOR_SYMBOL, 'LONG');
  let shortSeatVersion = symbolRegistry.getSeatVersion(MONITOR_SYMBOL, 'SHORT');

  function syncSeatContext(): void {
    monitorContext.seatState = {
      long: longSeatState,
      short: shortSeatState,
    };
    monitorContext.seatVersion = {
      long: longSeatVersion,
      short: shortSeatVersion,
    };
  }

  syncSeatContext();

  let longSeatReady = false;
  let shortSeatReady = false;
  let LONG_SYMBOL = '';
  let SHORT_SYMBOL = '';

  if (isSeatReady(longSeatState)) {
    longSeatReady = true;
    LONG_SYMBOL = longSeatState.symbol;
  }
  if (isSeatReady(shortSeatState)) {
    shortSeatReady = true;
    SHORT_SYMBOL = shortSeatState.symbol;
  }

  // 2. 提取做多/做空标的行情
  let longQuote = longSeatReady ? (quotesMap.get(LONG_SYMBOL) ?? null) : null;
  let shortQuote = shortSeatReady ? (quotesMap.get(SHORT_SYMBOL) ?? null) : null;

  // 更新 MonitorContext 中的行情缓存（供买入/卖出处理器使用）
  monitorContext.longQuote = longQuote;
  monitorContext.shortQuote = shortQuote;
  monitorContext.monitorQuote = monitorQuote;

  if (longSeatReady) {
    monitorContext.longSymbolName = longQuote?.name ?? LONG_SYMBOL;
  }
  if (shortSeatReady) {
    monitorContext.shortSymbolName = shortQuote?.name ?? SHORT_SYMBOL;
  }

  function isDirectionAction(
    action: string | null | undefined,
    direction: 'LONG' | 'SHORT',
  ): boolean {
    if (!action) {
      return false;
    }
    const isLongAction = action === 'BUYCALL' || action === 'SELLCALL';
    return direction === 'LONG' ? isLongAction : !isLongAction;
  }

  function clearQueuesForDirection(direction: 'LONG' | 'SHORT'): void {
    const removedDelayed = delayedSignalVerifier.cancelAllForDirection(MONITOR_SYMBOL, direction);
    const removedBuy = buyTaskQueue.removeTasks(
      (task) => task.monitorSymbol === MONITOR_SYMBOL && isDirectionAction(task.data?.action, direction),
      (task) => signalObjectPool.release(task.data),
    );
    const removedSell = sellTaskQueue.removeTasks(
      (task) => task.monitorSymbol === MONITOR_SYMBOL && isDirectionAction(task.data?.action, direction),
      (task) => signalObjectPool.release(task.data),
    );

    const totalRemoved = removedDelayed + removedBuy + removedSell;
    if (totalRemoved > 0) {
      logger.info(
        `[自动换标] ${MONITOR_SYMBOL} ${direction} 清理待执行信号：延迟=${removedDelayed} 买入=${removedBuy} 卖出=${removedSell}`,
      );
    }

  }

  function clearWarrantInfoForDirection(direction: 'LONG' | 'SHORT'): void {
    riskChecker.clearWarrantInfo(direction === 'LONG');
  }

  if (previousLongSeatState.status === 'READY' && longSeatState.status !== 'READY') {
    clearWarrantInfoForDirection('LONG');
    clearQueuesForDirection('LONG');
  }
  if (previousShortSeatState.status === 'READY' && shortSeatState.status !== 'READY') {
    clearWarrantInfoForDirection('SHORT');
    clearQueuesForDirection('SHORT');
  }

  let cachedAllOrders: ReadonlyArray<RawOrderFromAPI> | null = null;
  async function ensureAllOrders(): Promise<ReadonlyArray<RawOrderFromAPI>> {
    if (!cachedAllOrders) {
      cachedAllOrders = await orderRecorder.fetchAllOrdersFromAPI(true);
    }
    return cachedAllOrders;
  }

  let cachedAccountSnapshot: typeof lastState.cachedAccount | null | undefined;
  let cachedPositionsSnapshot: ReadonlyArray<Position> | null | undefined;
  async function refreshAccountCaches(): Promise<void> {
    if (cachedAccountSnapshot === undefined) {
      cachedAccountSnapshot = await trader.getAccountSnapshot();
      if (cachedAccountSnapshot) {
        lastState.cachedAccount = cachedAccountSnapshot;
      }
    }
    if (cachedPositionsSnapshot === undefined) {
      cachedPositionsSnapshot = await trader.getStockPositions();
      if (cachedPositionsSnapshot) {
        lastState.cachedPositions = [...cachedPositionsSnapshot];
        lastState.positionCache.update(cachedPositionsSnapshot);
      }
    }
  }

  function markSeatAsEmpty(direction: 'LONG' | 'SHORT', reason: string): void {
    clearWarrantInfoForDirection(direction);
    const nextState = {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: Date.now(),
      lastSearchAt: null,
    } as const;

    symbolRegistry.updateSeatState(MONITOR_SYMBOL, direction, nextState);
    const nextVersion = symbolRegistry.bumpSeatVersion(MONITOR_SYMBOL, direction);

    if (direction === 'LONG') {
      longSeatState = nextState;
      longSeatVersion = nextVersion;
      longSeatReady = false;
      LONG_SYMBOL = '';
      longQuote = null;
      monitorContext.longQuote = null;
      monitorContext.longSymbolName = '';
    } else {
      shortSeatState = nextState;
      shortSeatVersion = nextVersion;
      shortSeatReady = false;
      SHORT_SYMBOL = '';
      shortQuote = null;
      monitorContext.shortQuote = null;
      monitorContext.shortSymbolName = '';
    }

    syncSeatContext();
    clearQueuesForDirection(direction);
    logger.error(`[自动换标] ${MONITOR_SYMBOL} ${direction} 换标失败：${reason}`);
  }

  async function refreshSeatAfterSwitch(
    direction: 'LONG' | 'SHORT',
    previousState: typeof longSeatState,
    currentState: typeof longSeatState,
    quote: Quote | null,
    symbolName: string | null,
  ): Promise<void> {
    if (!isSeatReady(currentState)) {
      return;
    }
    const nextSymbol = currentState.symbol;
    const previousSymbol = previousState.symbol;
    if (!nextSymbol || nextSymbol === previousSymbol) {
      return;
    }

    clearWarrantInfoForDirection(direction);

    const allOrders = await ensureAllOrders();
    dailyLossTracker.recalculateFromAllOrders(allOrders, tradingConfig.monitors, new Date());
    await orderRecorder.refreshOrdersFromAllOrders(
      nextSymbol,
      direction === 'LONG',
      allOrders,
      quote,
    );
    await refreshAccountCaches();
    const dailyLossOffset = dailyLossTracker.getLossOffset(
      MONITOR_SYMBOL,
      direction === 'LONG',
    );
    await riskChecker.refreshUnrealizedLossData(
      orderRecorder,
      nextSymbol,
      direction === 'LONG',
      quote,
      dailyLossOffset,
    );

    const warrantRefreshResult = await riskChecker.refreshWarrantInfoForSymbol(
      marketDataClient,
      nextSymbol,
      direction === 'LONG',
      symbolName,
    );
    if (warrantRefreshResult.status === 'error') {
      markSeatAsEmpty(
        direction,
        `获取牛熊证信息失败：${warrantRefreshResult.reason}`,
      );
      return;
    }
    if (warrantRefreshResult.status === 'skipped') {
      markSeatAsEmpty(direction, '未提供行情客户端，无法刷新牛熊证信息');
      return;
    }
    if (warrantRefreshResult.status === 'notWarrant') {
      logger.warn(
        `[自动换标] ${MONITOR_SYMBOL} ${direction} 标的 ${nextSymbol} 不是牛熊证`,
      );
    }

    if (previousSymbol && previousSymbol !== nextSymbol) {
      const previousQuote = quotesMap.get(previousSymbol) ?? null;
      const existingSeat = symbolRegistry.resolveSeatBySymbol(previousSymbol);
      if (!existingSeat) {
        orderRecorder.clearBuyOrders(previousSymbol, direction === 'LONG', previousQuote);
        orderRecorder.clearOrdersCacheForSymbol(previousSymbol);
      }
    }
  }

  await refreshSeatAfterSwitch(
    'LONG',
    previousLongSeatState,
    longSeatState,
    longQuote,
    monitorContext.longSymbolName ?? null,
  );
  await refreshSeatAfterSwitch(
    'SHORT',
    previousShortSeatState,
    shortSeatState,
    shortQuote,
    monitorContext.shortSymbolName ?? null,
  );

  const longWarrantDistanceInfo = longSeatReady
    ? riskChecker.getWarrantDistanceInfo(true, LONG_SYMBOL, monitorCurrentPrice)
    : null;
  const shortWarrantDistanceInfo = shortSeatReady
    ? riskChecker.getWarrantDistanceInfo(false, SHORT_SYMBOL, monitorCurrentPrice)
    : null;

  // 监控价格变化并显示
  const priceChanged = marketMonitor.monitorPriceChanges(
    longQuote,
    shortQuote,
    LONG_SYMBOL,
    SHORT_SYMBOL,
    state,
    longWarrantDistanceInfo,
    shortWarrantDistanceInfo,
  );

  // 实时检查浮亏（仅在价格变化时检查）
  if (priceChanged) {
    await unrealizedLossMonitor.monitorUnrealizedLoss({
      longQuote,
      shortQuote,
      longSymbol: LONG_SYMBOL,
      shortSymbol: SHORT_SYMBOL,
      monitorSymbol: MONITOR_SYMBOL,
      riskChecker,
      trader,
      orderRecorder,
      dailyLossTracker,
    });
  }

  // 获取K线并计算指标
  const monitorCandles = await marketDataClient
    .getCandlesticks(MONITOR_SYMBOL, TRADING.CANDLE_PERIOD, TRADING.CANDLE_COUNT)
    .catch(() => null);

  if (!monitorCandles || monitorCandles.length === 0) {
    logger.warn(`未获取到监控标的 ${formatSymbolDisplay(MONITOR_SYMBOL, monitorContext.monitorSymbolName)} K线数据`);
    return;
  }

  // 使用缓存的配置（避免每次循环重复提取）
  const { rsiPeriods, emaPeriods, psyPeriods } = monitorContext;

  const monitorSnapshot = buildIndicatorSnapshot(
    MONITOR_SYMBOL,
    monitorCandles as CandleData[],
    rsiPeriods,
    emaPeriods,
    psyPeriods,
  );

  // 如果指标快照为 null，提前返回
  if (!monitorSnapshot) {
    logger.warn(`[${formatSymbolDisplay(MONITOR_SYMBOL, monitorContext.monitorSymbolName)}] 无法构建指标快照，跳过本次处理`);
    return;
  }

  // 监控指标变化
  marketMonitor.monitorIndicatorChanges(
    monitorSnapshot,
    monitorQuote,
    MONITOR_SYMBOL,
    emaPeriods,
    rsiPeriods,
    psyPeriods,
    state,
  );

  // 将指标快照存入 IndicatorCache（供延迟验证器查询）
  indicatorCache.push(MONITOR_SYMBOL, monitorSnapshot);

  // 释放上一次快照中的 kdj 和 macd 对象（如果它们没有被 monitorValues 引用）
  // 注意：如果缓存命中，state.lastMonitorSnapshot 可能与 monitorSnapshot 是同一个对象
  // 此时不应释放，否则会导致缓存的 snapshot 中的 kdj/macd 对象被意外释放
  if (state.lastMonitorSnapshot !== monitorSnapshot) {
    releaseSnapshotObjects(state.lastMonitorSnapshot, state.monitorValues);
  }
  // 保存当前快照供下次循环使用
  state.lastMonitorSnapshot = monitorSnapshot;

  // 获取持仓（使用 try-finally 确保释放）
  // 使用 PositionCache 进行 O(1) 查找
  const { longPosition, shortPosition } = getPositions(
    lastState.positionCache,
    LONG_SYMBOL,
    SHORT_SYMBOL,
  );

  try {
    function tryCreateLiquidationSignal(
      symbol: string,
      symbolName: string | null,
      isLongSymbol: boolean,
      position: Position | null,
      quote: Quote | null,
    ): {
      signal: Signal;
      isLongSymbol: boolean;
      quote: Quote | null;
    } | null {
      if (!symbol) {
        return null;
      }

      const availableQuantity = position?.availableQuantity ?? 0;
      if (!Number.isFinite(availableQuantity) || availableQuantity <= 0) {
        return null;
      }

      if (resolvedMonitorPrice == null) {
        return null;
      }

      const liquidationResult = riskChecker.checkWarrantDistanceLiquidation(
        symbol,
        isLongSymbol,
        resolvedMonitorPrice,
      );
      if (!liquidationResult.shouldLiquidate) {
        return null;
      }

      const signal = signalObjectPool.acquire() as Signal;
      signal.symbol = symbol;
      signal.symbolName = symbolName;
      signal.action = isLongSymbol ? 'SELLCALL' : 'SELLPUT';
      signal.reason = liquidationResult.reason ?? '牛熊证距回收价触发清仓';
      signal.price = quote?.price ?? null;
      signal.lotSize = quote?.lotSize ?? null;
      signal.quantity = availableQuantity;
      signal.triggerTime = new Date();
      signal.orderTypeOverride = WARRANT_LIQUIDATION_ORDER_TYPE;
      signal.isProtectiveLiquidation = false;
      signal.seatVersion = isLongSymbol ? longSeatVersion : shortSeatVersion;

      return { signal, isLongSymbol, quote };
    }

    if (monitorPriceChanged && !autoSearchEnabled) {
      const liquidationTasks: Array<{
        signal: Signal;
        isLongSymbol: boolean;
        quote: Quote | null;
      }> = [];
      const longSymbolName = longQuote?.name ?? monitorContext.longSymbolName ?? null;
      const shortSymbolName = shortQuote?.name ?? monitorContext.shortSymbolName ?? null;

      const longTask = tryCreateLiquidationSignal(
        LONG_SYMBOL,
        longSymbolName,
        true,
        longPosition,
        longQuote,
      );
      if (longTask) {
        liquidationTasks.push(longTask);
      }

      const shortTask = tryCreateLiquidationSignal(
        SHORT_SYMBOL,
        shortSymbolName,
        false,
        shortPosition,
        shortQuote,
      );
      if (shortTask) {
        liquidationTasks.push(shortTask);
      }

      if (liquidationTasks.length > 0) {
        try {
          await trader.executeSignals(liquidationTasks.map((task) => task.signal));

          for (const task of liquidationTasks) {
            orderRecorder.clearBuyOrders(task.signal.symbol, task.isLongSymbol, task.quote);
            const dailyLossOffset = dailyLossTracker.getLossOffset(
              MONITOR_SYMBOL,
              task.isLongSymbol,
            );
            await riskChecker.refreshUnrealizedLossData(
              orderRecorder,
              task.signal.symbol,
              task.isLongSymbol,
              task.quote,
              dailyLossOffset,
            );
          }
        } catch (err) {
          logger.error(
            `[牛熊证距回收价清仓失败] ${formatError(err)}`,
          );
        } finally {
          for (const task of liquidationTasks) {
            signalObjectPool.release(task.signal);
          }
        }
      }
    }

    if (openProtectionActive) {
      // 开盘保护期间跳过信号生成与入队
      return;
    }

    // 生成信号
    const { immediateSignals, delayedSignals } = strategy.generateCloseSignals(
      monitorSnapshot,
      LONG_SYMBOL,
      SHORT_SYMBOL,
      orderRecorder,
    );

    // 6. 为信号设置标的中文名称和价格信息（用于日志显示和后续处理）
    function enrichSignal(signal: Signal): void {
      const sigSymbol = signal.symbol;
      if (sigSymbol === LONG_SYMBOL && longQuote) {
        if (signal.symbolName == null && longQuote.name != null) signal.symbolName = longQuote.name;
        signal.price ??= longQuote.price;
        if (signal.lotSize == null && longQuote.lotSize != null) signal.lotSize = longQuote.lotSize;
      } else if (sigSymbol === SHORT_SYMBOL && shortQuote) {
        if (signal.symbolName == null && shortQuote.name != null) signal.symbolName = shortQuote.name;
        signal.price ??= shortQuote.price;
        if (signal.lotSize == null && shortQuote.lotSize != null) signal.lotSize = shortQuote.lotSize;
      }
    }

    function resolveSeatForSignal(signal: Signal): {
      seatSymbol: string;
      seatVersion: number;
      quote: Quote | null;
      isBuySignal: boolean;
    } | null {
      const isBuySignal = signal.action === 'BUYCALL' || signal.action === 'BUYPUT';
      const isLongSignal = signal.action === 'BUYCALL' || signal.action === 'SELLCALL';
      const seatState = isLongSignal ? longSeatState : shortSeatState;
      if (!isSeatReady(seatState)) {
        return null;
      }
      const seatSymbol = seatState.symbol;
      const seatVersion = isLongSignal ? longSeatVersion : shortSeatVersion;
      const quote = isLongSignal ? longQuote : shortQuote;
      return { seatSymbol, seatVersion, quote, isBuySignal };
    }

    // 信号分流：立即信号 → TaskQueue/SellTaskQueue，延迟信号 → DelayedSignalVerifier
    // 处理立即信号
    for (const signal of immediateSignals) {
      // 验证信号有效性
      if (!signal?.symbol || !signal?.action) {
        logger.warn(`[跳过信号] 无效的信号对象: ${JSON.stringify(signal)}`);
        signalObjectPool.release(signal);
        continue;
      }
      if (!VALID_SIGNAL_ACTIONS.has(signal.action)) {
        logger.warn(`[跳过信号] 未知的信号类型: ${signal.action}, 标的: ${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)}`);
        signalObjectPool.release(signal);
        continue;
      }

      const seatInfo = resolveSeatForSignal(signal);
      if (!seatInfo) {
        logger.info(`[跳过信号] 席位不可用: ${formatSignalLog(signal)}`);
        signalObjectPool.release(signal);
        continue;
      }
      if (signal.symbol !== seatInfo.seatSymbol) {
        logger.info(`[跳过信号] 席位已切换: ${formatSignalLog(signal)}`);
        signalObjectPool.release(signal);
        continue;
      }
      if (seatInfo.isBuySignal && !seatInfo.quote) {
        logger.info(`[跳过信号] 行情未就绪: ${formatSignalLog(signal)}`);
        signalObjectPool.release(signal);
        continue;
      }
      signal.seatVersion = seatInfo.seatVersion;

      // 补充信号信息
      enrichSignal(signal);

      // 只在交易时段才推入任务队列
      if (canTradeNow) {
        logger.info(`[立即信号] ${formatSignalLog(signal)}`);

        // 根据信号类型分流到不同队列
        const isSellSignal = signal.action === 'SELLCALL' || signal.action === 'SELLPUT';

        if (isSellSignal) {
          // 卖出信号 → SellTaskQueue（独立队列，不被买入阻塞）
          sellTaskQueue.push({
            type: 'IMMEDIATE_SELL',
            data: signal,
            monitorSymbol: MONITOR_SYMBOL,
          });
        } else {
          // 买入信号 → BuyTaskQueue
          buyTaskQueue.push({
            type: 'IMMEDIATE_BUY',
            data: signal,
            monitorSymbol: MONITOR_SYMBOL,
          });
        }
      } else {
        logger.info(`[立即信号] ${formatSignalLog(signal)}（非交易时段，暂不执行）`);
        signalObjectPool.release(signal);
      }
    }

    // 处理延迟信号
    for (const signal of delayedSignals) {
      // 验证信号有效性
      if (!signal?.symbol || !signal?.action) {
        logger.warn(`[跳过信号] 无效的信号对象: ${JSON.stringify(signal)}`);
        signalObjectPool.release(signal);
        continue;
      }
      if (!VALID_SIGNAL_ACTIONS.has(signal.action)) {
        logger.warn(`[跳过信号] 未知的信号类型: ${signal.action}, 标的: ${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)}`);
        signalObjectPool.release(signal);
        continue;
      }

      const seatInfo = resolveSeatForSignal(signal);
      if (!seatInfo) {
        logger.info(`[跳过信号] 席位不可用: ${formatSignalLog(signal)}`);
        signalObjectPool.release(signal);
        continue;
      }
      if (signal.symbol !== seatInfo.seatSymbol) {
        logger.info(`[跳过信号] 席位已切换: ${formatSignalLog(signal)}`);
        signalObjectPool.release(signal);
        continue;
      }
      if (seatInfo.isBuySignal && !seatInfo.quote) {
        logger.info(`[跳过信号] 行情未就绪: ${formatSignalLog(signal)}`);
        signalObjectPool.release(signal);
        continue;
      }
      signal.seatVersion = seatInfo.seatVersion;

      // 补充信号信息
      enrichSignal(signal);

      // 只在交易时段才添加到延迟验证器
      if (canTradeNow) {
        logger.info(`[延迟验证信号] ${formatSignalLog(signal)}`);
        delayedSignalVerifier.addSignal(signal, MONITOR_SYMBOL);
      } else {
        logger.info(`[延迟验证信号] ${formatSignalLog(signal)}（非交易时段，暂不添加验证）`);
        signalObjectPool.release(signal);
      }
    }

    // 注意：旧的信号验证、风险检查和订单执行逻辑已移至买入/卖出处理器
    // 买入/卖出处理器通过 lastState.positionCache 获取持仓数据
    // DelayedSignalVerifier 验证通过后会将信号推入 BuyTaskQueue / SellTaskQueue
    // 买入/卖出处理器会消费对应队列的任务并执行完整的交易流程

  } finally {
    // 释放持仓对象回池（确保在所有退出路径上都释放）
    if (longPosition) {
      positionObjectPool.release(longPosition);
    }
    if (shortPosition) {
      positionObjectPool.release(shortPosition);
    }
  }
}
