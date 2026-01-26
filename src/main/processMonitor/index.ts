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
 * 1. 提取行情数据 → 2. 监控价格/浮亏变化 → 3. 获取K线/计算指标
 * → 4. 缓存指标快照 → 5. 获取持仓 → 6. 生成信号 → 7. 分流信号到队列/验证器
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
import { VALID_SIGNAL_ACTIONS, TRADING } from '../../constants/index.js';
import { getPositions } from './utils.js';

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
    trader,
    lastState,
    marketMonitor,
    indicatorCache,
    buyTaskQueue,
    sellTaskQueue,
  } = mainContext;
  const { canTradeNow, openProtectionActive } = runtimeFlags;
  // 使用各自监控标的独立的延迟信号验证器（每个监控标的使用各自的验证配置）
  const {
    config,
    state,
    strategy,
    orderRecorder,
    riskChecker,
    unrealizedLossMonitor,
    delayedSignalVerifier,
  } = monitorContext;

  const LONG_SYMBOL = config.longSymbol;
  const SHORT_SYMBOL = config.shortSymbol;
  const MONITOR_SYMBOL = config.monitorSymbol;

  // 1. 从预先获取的行情 Map 中提取当前监控标的需要的行情（无需单独 API 调用）
  const longQuote = quotesMap.get(LONG_SYMBOL) ?? null;
  const shortQuote = quotesMap.get(SHORT_SYMBOL) ?? null;
  const monitorQuote = quotesMap.get(MONITOR_SYMBOL) ?? null;

  // 更新 MonitorContext 中的行情缓存（供 TradeProcessor 使用）
  monitorContext.longQuote = longQuote;
  monitorContext.shortQuote = shortQuote;
  monitorContext.monitorQuote = monitorQuote;

  // 监控价格变化并显示
  const priceChanged = marketMonitor.monitorPriceChanges(
    longQuote,
    shortQuote,
    LONG_SYMBOL,
    SHORT_SYMBOL,
    state,
  );

  // 实时检查浮亏（仅在价格变化时检查）
  if (priceChanged) {
    await unrealizedLossMonitor.monitorUnrealizedLoss({
      longQuote,
      shortQuote,
      longSymbol: LONG_SYMBOL,
      shortSymbol: SHORT_SYMBOL,
      riskChecker,
      trader,
      orderRecorder,
    });
  }

  // 2. 获取K线和计算指标
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

  // 3. 监控指标变化
  marketMonitor.monitorIndicatorChanges(
    monitorSnapshot,
    monitorQuote,
    MONITOR_SYMBOL,
    emaPeriods,
    rsiPeriods,
    psyPeriods,
    state,
  );

  // 4. 将指标快照存入 IndicatorCache（供延迟验证器查询）
  indicatorCache.push(MONITOR_SYMBOL, monitorSnapshot);

  // 释放上一次快照中的 kdj 和 macd 对象（如果它们没有被 monitorValues 引用）
  // 注意：如果缓存命中，state.lastMonitorSnapshot 可能与 monitorSnapshot 是同一个对象
  // 此时不应释放，否则会导致缓存的 snapshot 中的 kdj/macd 对象被意外释放
  if (state.lastMonitorSnapshot !== monitorSnapshot) {
    releaseSnapshotObjects(state.lastMonitorSnapshot, state.monitorValues);
  }
  // 保存当前快照供下次循环使用
  state.lastMonitorSnapshot = monitorSnapshot;

  // 5. 获取持仓（使用 try-finally 确保释放）
  // 使用 PositionCache 进行 O(1) 查找
  const { longPosition, shortPosition } = getPositions(
    lastState.positionCache,
    LONG_SYMBOL,
    SHORT_SYMBOL,
  );

  try {
    if (openProtectionActive) {
      // 开盘保护期间仅保留行情/指标展示，跳过信号生成
      return;
    }

    // 5. 生成信号
    const { immediateSignals, delayedSignals } = strategy.generateCloseSignals(
      monitorSnapshot,
      LONG_SYMBOL,
      SHORT_SYMBOL,
      orderRecorder,
    );

    // 6. 为信号设置标的中文名称和价格信息（用于日志显示和后续处理）
    const enrichSignal = (signal: Signal): void => {
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
    };

    // 7. 信号分流：立即信号 → TaskQueue/SellTaskQueue，延迟信号 → DelayedSignalVerifier
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

    // 注意：旧的信号验证、风险检查和订单执行逻辑已移至 TradeProcessor
    // TradeProcessor 通过 lastState.positionCache 获取持仓数据
    // DelayedSignalVerifier 验证通过后会将信号推入 TradeTaskQueue
    // TradeProcessor 会消费 TradeTaskQueue 中的任务并执行完整的交易流程

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
