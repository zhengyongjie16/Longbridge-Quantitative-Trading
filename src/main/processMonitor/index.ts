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
  releaseSnapshotObjects,
} from '../../utils/helpers/index.js';
import { MONITOR, VALID_SIGNAL_ACTIONS, TRADING } from '../../constants/index.js';
import { clearQueuesForDirection as clearQueuesForDirectionUtil, getPositions } from './utils.js';
import { isSeatReady } from '../../services/autoSymbolManager/utils.js';

import type { CandleData, Signal, Quote } from '../../types/index.js';
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
    lastState,
    marketMonitor,
    indicatorCache,
    buyTaskQueue,
    sellTaskQueue,
    monitorTaskQueue,
  } = mainContext;
  const { canTradeNow, openProtectionActive } = runtimeFlags;
  // 使用各自监控标的独立的延迟信号验证器（每个监控标的使用各自的验证配置）
  const {
    config,
    state,
    strategy,
    orderRecorder,
    riskChecker,
    delayedSignalVerifier,
    autoSymbolManager,
    symbolRegistry,
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
  if (monitorPriceChanged) {
    state.monitorPrice = resolvedMonitorPrice;
  }

  const currentTimeMs = runtimeFlags.currentTime.getTime();

  const autoSearchSeatSnapshots = autoSearchEnabled
    ? {
      long: symbolRegistry.getSeatState(MONITOR_SYMBOL, 'LONG'),
      short: symbolRegistry.getSeatState(MONITOR_SYMBOL, 'SHORT'),
    }
    : null;

  if (autoSearchSeatSnapshots) {
    const { long: longSeatSnapshot, short: shortSeatSnapshot } = autoSearchSeatSnapshots;

    monitorTaskQueue.scheduleLatest({
      type: 'AUTO_SYMBOL_TICK',
      dedupeKey: `${MONITOR_SYMBOL}:AUTO_SYMBOL_TICK:LONG`,
      monitorSymbol: MONITOR_SYMBOL,
      data: {
        monitorSymbol: MONITOR_SYMBOL,
        direction: 'LONG',
        seatVersion: symbolRegistry.getSeatVersion(MONITOR_SYMBOL, 'LONG'),
        symbol: longSeatSnapshot.symbol ?? null,
        currentTimeMs,
        canTradeNow,
      },
    });
    monitorTaskQueue.scheduleLatest({
      type: 'AUTO_SYMBOL_TICK',
      dedupeKey: `${MONITOR_SYMBOL}:AUTO_SYMBOL_TICK:SHORT`,
      monitorSymbol: MONITOR_SYMBOL,
      data: {
        monitorSymbol: MONITOR_SYMBOL,
        direction: 'SHORT',
        seatVersion: symbolRegistry.getSeatVersion(MONITOR_SYMBOL, 'SHORT'),
        symbol: shortSeatSnapshot.symbol ?? null,
        currentTimeMs,
        canTradeNow,
      },
    });

    const hasPendingSwitch =
      autoSymbolManager.hasPendingSwitch('LONG') || autoSymbolManager.hasPendingSwitch('SHORT');
    if (monitorPriceChanged || hasPendingSwitch) {
      monitorTaskQueue.scheduleLatest({
        type: 'AUTO_SYMBOL_SWITCH_DISTANCE',
        dedupeKey: `${MONITOR_SYMBOL}:AUTO_SYMBOL_SWITCH_DISTANCE`,
        monitorSymbol: MONITOR_SYMBOL,
        data: {
          monitorSymbol: MONITOR_SYMBOL,
          monitorPrice: resolvedMonitorPrice,
          quotesMap,
          seatSnapshots: {
            long: {
              seatVersion: symbolRegistry.getSeatVersion(MONITOR_SYMBOL, 'LONG'),
              symbol: longSeatSnapshot.symbol ?? null,
            },
            short: {
              seatVersion: symbolRegistry.getSeatVersion(MONITOR_SYMBOL, 'SHORT'),
              symbol: shortSeatSnapshot.symbol ?? null,
            },
          },
        },
      });
    }
  }

  const previousSeatState = monitorContext.seatState;
  const previousLongSeatState = previousSeatState.long;
  const previousShortSeatState = previousSeatState.short;

  const longSeatState = symbolRegistry.getSeatState(MONITOR_SYMBOL, 'LONG');
  const shortSeatState = symbolRegistry.getSeatState(MONITOR_SYMBOL, 'SHORT');
  const longSeatVersion = symbolRegistry.getSeatVersion(MONITOR_SYMBOL, 'LONG');
  const shortSeatVersion = symbolRegistry.getSeatVersion(MONITOR_SYMBOL, 'SHORT');

  /**
   * 同步当前席位状态与版本到 MonitorContext，供异步处理器读取。
   */
  monitorContext.seatState = {
    long: longSeatState,
    short: shortSeatState,
  };
  monitorContext.seatVersion = {
    long: longSeatVersion,
    short: shortSeatVersion,
  };

  const longSeatReady = isSeatReady(longSeatState);
  const shortSeatReady = isSeatReady(shortSeatState);
  const LONG_SYMBOL = longSeatReady ? longSeatState.symbol : '';
  const SHORT_SYMBOL = shortSeatReady ? shortSeatState.symbol : '';

  // 2. 提取做多/做空标的行情
  const longQuote = longSeatReady ? (quotesMap.get(LONG_SYMBOL) ?? null) : null;
  const shortQuote = shortSeatReady ? (quotesMap.get(SHORT_SYMBOL) ?? null) : null;

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

  /**
   * 清空指定方向的待执行信号（延迟验证、买入、卖出）。
   */
  function clearQueuesForDirection(direction: 'LONG' | 'SHORT'): void {
    const result = clearQueuesForDirectionUtil({
      monitorSymbol: MONITOR_SYMBOL,
      direction,
      delayedSignalVerifier,
      buyTaskQueue,
      sellTaskQueue,
      monitorTaskQueue,
      releaseSignal: signalObjectPool.release,
    });
    const totalRemoved =
      result.removedDelayed +
      result.removedBuy +
      result.removedSell +
      result.removedMonitorTasks;
    if (totalRemoved > 0) {
      logger.info(
        `[自动换标] ${MONITOR_SYMBOL} ${direction} 清理待执行信号：延迟=${result.removedDelayed} 买入=${result.removedBuy} 卖出=${result.removedSell} 监控任务=${result.removedMonitorTasks}`,
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

  if (longSeatReady && longSeatState.symbol !== previousLongSeatState.symbol) {
    monitorTaskQueue.scheduleLatest({
      type: 'SEAT_REFRESH',
      dedupeKey: `${MONITOR_SYMBOL}:SEAT_REFRESH:LONG`,
      monitorSymbol: MONITOR_SYMBOL,
      data: {
        monitorSymbol: MONITOR_SYMBOL,
        direction: 'LONG',
        seatVersion: longSeatVersion,
        previousSymbol: previousLongSeatState.symbol ?? null,
        nextSymbol: longSeatState.symbol,
        quote: longQuote,
        symbolName: monitorContext.longSymbolName ?? null,
        quotesMap,
      },
    });
  }
  if (shortSeatReady && shortSeatState.symbol !== previousShortSeatState.symbol) {
    monitorTaskQueue.scheduleLatest({
      type: 'SEAT_REFRESH',
      dedupeKey: `${MONITOR_SYMBOL}:SEAT_REFRESH:SHORT`,
      monitorSymbol: MONITOR_SYMBOL,
      data: {
        monitorSymbol: MONITOR_SYMBOL,
        direction: 'SHORT',
        seatVersion: shortSeatVersion,
        previousSymbol: previousShortSeatState.symbol ?? null,
        nextSymbol: shortSeatState.symbol,
        quote: shortQuote,
        symbolName: monitorContext.shortSymbolName ?? null,
        quotesMap,
      },
    });
  }

  if (monitorPriceChanged && !autoSearchEnabled && resolvedMonitorPrice != null) {
    monitorTaskQueue.scheduleLatest({
      type: 'LIQUIDATION_DISTANCE_CHECK',
      dedupeKey: `${MONITOR_SYMBOL}:LIQUIDATION_DISTANCE_CHECK`,
      monitorSymbol: MONITOR_SYMBOL,
      data: {
        monitorSymbol: MONITOR_SYMBOL,
        monitorPrice: resolvedMonitorPrice,
        long: {
          seatVersion: longSeatVersion,
          symbol: longSeatState.symbol ?? null,
          quote: longQuote,
          symbolName: longQuote?.name ?? monitorContext.longSymbolName ?? null,
        },
        short: {
          seatVersion: shortSeatVersion,
          symbol: shortSeatState.symbol ?? null,
          quote: shortQuote,
          symbolName: shortQuote?.name ?? monitorContext.shortSymbolName ?? null,
        },
      },
    });
  }

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
    monitorTaskQueue.scheduleLatest({
      type: 'UNREALIZED_LOSS_CHECK',
      dedupeKey: `${MONITOR_SYMBOL}:UNREALIZED_LOSS_CHECK`,
      monitorSymbol: MONITOR_SYMBOL,
      data: {
        monitorSymbol: MONITOR_SYMBOL,
        long: {
          seatVersion: longSeatVersion,
          symbol: longSeatState.symbol ?? null,
          quote: longQuote,
        },
        short: {
          seatVersion: shortSeatVersion,
          symbol: shortSeatState.symbol ?? null,
          quote: shortQuote,
        },
      },
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
    /**
     * 补充信号的名称/价格/手数信息，便于日志与后续处理。
     */
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

    /**
     * 根据信号动作解析席位信息（标的、版本、行情）。
     */
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

    function prepareSignal(signal: Signal): boolean {
      if (!signal?.symbol || !signal?.action) {
        logger.warn(`[跳过信号] 无效的信号对象: ${JSON.stringify(signal)}`);
        signalObjectPool.release(signal);
        return false;
      }
      if (!VALID_SIGNAL_ACTIONS.has(signal.action)) {
        logger.warn(
          `[跳过信号] 未知的信号类型: ${signal.action}, 标的: ${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)}`,
        );
        signalObjectPool.release(signal);
        return false;
      }

      const seatInfo = resolveSeatForSignal(signal);
      if (!seatInfo) {
        logger.info(`[跳过信号] 席位不可用: ${formatSignalLog(signal)}`);
        signalObjectPool.release(signal);
        return false;
      }
      if (signal.symbol !== seatInfo.seatSymbol) {
        logger.info(`[跳过信号] 席位已切换: ${formatSignalLog(signal)}`);
        signalObjectPool.release(signal);
        return false;
      }
      if (seatInfo.isBuySignal && !seatInfo.quote) {
        logger.info(`[跳过信号] 行情未就绪: ${formatSignalLog(signal)}`);
        signalObjectPool.release(signal);
        return false;
      }

      signal.seatVersion = seatInfo.seatVersion;
      enrichSignal(signal);
      return true;
    }

    // 信号分流：立即信号 → TaskQueue/SellTaskQueue，延迟信号 → DelayedSignalVerifier
    // 处理立即信号
    for (const signal of immediateSignals) {
      if (!prepareSignal(signal)) {
        continue;
      }

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
      if (!prepareSignal(signal)) {
        continue;
      }

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
