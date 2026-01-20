/**
 * LongBridge 港股自动化量化交易系统 - 主入口模块
 *
 * 系统概述：
 * - 监控恒生指数等目标资产的技术指标（RSI、KDJ、MACD、MFI）
 * - 根据指标信号在牛熊证上执行双向交易（做多/做空）
 * - 采用多指标组合策略，开仓信号延迟验证60秒，平仓信号立即执行
 *
 * 核心流程：
 * 1. 初始化所有模块实例（MarketMonitor、DoomsdayProtection、UnrealizedLossMonitor等）
 * 2. 主循环 runOnce() 每秒执行一次，协调各模块
 * 3. 获取行情数据和技术指标
 * 4. 生成和验证交易信号
 * 5. 执行风险检查和订单交易
 *
 * 相关模块：
 * - strategy.ts：信号生成
 * - signalVerification.ts：延迟信号验证
 * - signalProcessor.ts：信号处理和风险检查
 * - trader.ts：订单执行
 */

import { createConfig } from './config/config.index.js';
import { createHangSengMultiIndicatorStrategy } from './core/strategy/index.js';
import { createTrader } from './core/trader/index.js';
import { buildIndicatorSnapshot } from './services/indicators/index.js';
import { createRiskChecker } from './core/risk/index.js';
import { MULTI_MONITOR_TRADING_CONFIG } from './config/config.trading.js';
import { logger } from './utils/logger/index.js';
import { validateAllConfig } from './config/config.validator.js';
import {
  positionObjectPool,
  signalObjectPool,
  kdjObjectPool,
  macdObjectPool,
} from './utils/objectPool/index.js';
import {
  formatError,
  formatSignalLog,
  formatSymbolDisplay,
  sleep,
} from './utils/helpers/index.js';
import { extractRSIPeriods } from './utils/helpers/signalConfigParser.js';
import { validateEmaPeriod } from './utils/helpers/indicatorHelpers.js';
import { collectAllQuoteSymbols } from './utils/helpers/quoteHelpers.js';
import {
  VALID_SIGNAL_ACTIONS,
  TRADING,
} from './constants/index.js';

// 导入新模块
import { isInContinuousHKSession } from './utils/helpers/tradingTime.js';
import { displayAccountAndPositions } from './utils/helpers/accountDisplay.js';
import { createPositionCache } from './utils/helpers/positionCache.js';
import { createMarketMonitor } from './services/marketMonitor/index.js';
import { createDoomsdayProtection } from './core/doomsdayProtection/index.js';
import { createUnrealizedLossMonitor } from './core/unrealizedLossMonitor/index.js';
import { createSignalProcessor } from './core/signalProcessor/index.js';

// 导入重构后的新架构模块
import { createIndicatorCache, type IndicatorCache } from './program/indicatorCache/index.js';
import { createTradeTaskQueue, type TradeTaskQueue } from './program/tradeTaskQueue/index.js';
import { createDelayedSignalVerifier } from './program/delayedSignalVerifier/index.js';
import { createTradeProcessor, type TradeProcessor } from './program/tradeProcessor/index.js';
import type {
  CandleData,
  Signal,
  Position,
  Quote,
  VerificationConfig,
  SignalConfigSet,
  LastState,
  MonitorState,
  MonitorConfig,
  MonitorContext,
  ValidateAllConfigResult,
  MarketDataClient,
  Trader,
  IndicatorSnapshot,
} from './types/index.js';
import type { MarketMonitor } from './services/marketMonitor/types.js';
import type { DoomsdayProtection } from './core/doomsdayProtection/types.js';
import type { SignalProcessor } from './core/signalProcessor/types.js';
import { getSprintSacreMooacreMoo } from './utils/asciiArt/sacreMooacre.js';

/**
 * 运行上下文接口
 */
interface RunOnceContext {
  marketDataClient: MarketDataClient;
  trader: Trader;
  lastState: LastState;
  marketMonitor: MarketMonitor;
  doomsdayProtection: DoomsdayProtection;
  signalProcessor: SignalProcessor;
  monitorContexts: Map<string, MonitorContext>;
  // 新架构模块
  indicatorCache: IndicatorCache;
  tradeTaskQueue: TradeTaskQueue;
  tradeProcessor: TradeProcessor;
}


// 从验证配置中提取 EMA 周期（模块加载时执行一次）
function extractEmaPeriods(verificationConfig: VerificationConfig | null | undefined): number[] {
  const emaPeriods: number[] = [];

  if (verificationConfig) {
    // 从买入和卖出配置中提取 EMA 周期
    const allIndicators = [
      ...(verificationConfig.buy.indicators || []),
      ...(verificationConfig.sell.indicators || []),
    ];

    for (const indicator of allIndicators) {
      if (indicator.startsWith('EMA:')) {
        const periodStr = indicator.substring(4);
        const period = Number.parseInt(periodStr, 10);

        if (validateEmaPeriod(period) && !emaPeriods.includes(period)) {
          emaPeriods.push(period);
        }
      }
    }
  }

  // 如果没有配置任何 EMA 周期，使用默认值 7
  if (emaPeriods.length === 0) {
    emaPeriods.push(7);
  }

  return emaPeriods;
}

// 从信号配置中提取 RSI 周期（模块加载时执行一次）
function extractRsiPeriodsWithDefault(signalConfig: SignalConfigSet | null): number[] {
  const rsiPeriods = extractRSIPeriods(signalConfig);

  // 如果没有配置任何 RSI 周期，使用默认值 6
  if (rsiPeriods.length === 0) {
    rsiPeriods.push(6);
  }

  return rsiPeriods;
}

/**
 * 创建监控标的状态
 */
function createMonitorState(config: MonitorConfig): MonitorState {
  return {
    monitorSymbol: config.monitorSymbol,
    longSymbol: config.longSymbol,
    shortSymbol: config.shortSymbol,
    longPrice: null,
    shortPrice: null,
    signal: null,
    pendingDelayedSignals: [],
    monitorValues: null,
    lastMonitorSnapshot: null,
  };
}

/**
 * 释放快照中的 KDJ 和 MACD 对象（如果它们没有被 monitorValues 引用）
 * @param snapshot 要释放的快照
 * @param monitorValues 监控值对象，用于检查引用
 */
function releaseSnapshotObjects(
  snapshot: IndicatorSnapshot | null,
  monitorValues: MonitorState['monitorValues'],
): void {
  if (!snapshot) {
    return;
  }

  // 释放 KDJ 对象（如果它没有被 monitorValues 引用）
  if (snapshot.kdj && monitorValues?.kdj !== snapshot.kdj) {
    kdjObjectPool.release(snapshot.kdj);
  }

  // 释放 MACD 对象（如果它没有被 monitorValues 引用）
  if (snapshot.macd && monitorValues?.macd !== snapshot.macd) {
    macdObjectPool.release(snapshot.macd);
  }
}

/**
 * 释放所有监控标的的最后一个快照对象
 * @param monitorStates 监控状态Map
 */
function releaseAllMonitorSnapshots(monitorStates: Map<string, MonitorState>): void {
  for (const monitorState of monitorStates.values()) {
    releaseSnapshotObjects(monitorState.lastMonitorSnapshot, monitorState.monitorValues);
    monitorState.lastMonitorSnapshot = null;
  }
}

/**
 * 从持仓缓存中获取指定标的的持仓
 * 使用 PositionCache 提供 O(1) 查找性能
 *
 * @param positionCache 持仓缓存
 * @param longSymbol 做多标的代码（已规范化）
 * @param shortSymbol 做空标的代码（已规范化）
 */
function getPositions(
  positionCache: import('./types/index.js').PositionCache,
  longSymbol: string,
  shortSymbol: string,
): { longPosition: Position | null; shortPosition: Position | null } {
  // O(1) 查找
  const longPos = positionCache.get(longSymbol);
  const shortPos = positionCache.get(shortSymbol);

  let longPosition: Position | null = null;
  let shortPosition: Position | null = null;

  // 创建持仓对象（复用对象池）
  if (longPos) {
    longPosition = positionObjectPool.acquire() as Position;
    longPosition.symbol = longSymbol;
    longPosition.costPrice = Number(longPos.costPrice) || 0;
    longPosition.quantity = Number(longPos.quantity) || 0;
    longPosition.availableQuantity = Number(longPos.availableQuantity) || 0;
    longPosition.accountChannel = longPos.accountChannel;
    longPosition.symbolName = longPos.symbolName;
    longPosition.currency = longPos.currency;
    longPosition.market = longPos.market;
  }

  if (shortPos) {
    shortPosition = positionObjectPool.acquire() as Position;
    shortPosition.symbol = shortSymbol;
    shortPosition.costPrice = Number(shortPos.costPrice) || 0;
    shortPosition.quantity = Number(shortPos.quantity) || 0;
    shortPosition.availableQuantity = Number(shortPos.availableQuantity) || 0;
    shortPosition.accountChannel = shortPos.accountChannel;
    shortPosition.symbolName = shortPos.symbolName;
    shortPosition.currency = shortPos.currency;
    shortPosition.market = shortPos.market;
  }

  return { longPosition, shortPosition };
}

/**
 * 处理单个监控标的
 *
 * @param context 处理上下文，包含所有必要的依赖和状态
 * @param quotesMap 预先批量获取的行情数据 Map（提升性能，避免每个监控标的单独获取行情）
 */
async function processMonitor(
  context: {
    monitorContext: MonitorContext;
    marketDataClient: MarketDataClient;
    trader: Trader;
    globalState: LastState;
    marketMonitor: MarketMonitor;
    doomsdayProtection: DoomsdayProtection;
    signalProcessor: SignalProcessor;
    currentTime: Date;
    isHalfDay: boolean;
    canTradeNow: boolean;
    // 新架构模块
    indicatorCache: IndicatorCache;
    tradeTaskQueue: TradeTaskQueue;
  },
  quotesMap: ReadonlyMap<string, Quote | null>,
): Promise<void> {
  const {
    monitorContext,
    marketDataClient,
    trader,
    globalState,
    marketMonitor,
    canTradeNow,
    indicatorCache,
    tradeTaskQueue,
  } = context;
  // 使用各自监控标的独立的延迟信号验证器（每个监控标的使用各自的验证配置）
  const { config, state, strategy, orderRecorder, riskChecker, unrealizedLossMonitor, delayedSignalVerifier } = monitorContext;

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
    await unrealizedLossMonitor.monitorUnrealizedLoss(
      longQuote,
      shortQuote,
      LONG_SYMBOL,
      SHORT_SYMBOL,
      riskChecker,
      trader,
      orderRecorder,
    );
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
  const rsiPeriods = context.monitorContext.rsiPeriods;
  const emaPeriods = context.monitorContext.emaPeriods;

  const monitorSnapshot = buildIndicatorSnapshot(
    MONITOR_SYMBOL,
    monitorCandles as CandleData[],
    rsiPeriods,
    emaPeriods,
  );

  // 如果指标快照为 null，提前返回
  if (!monitorSnapshot) {
    logger.warn(`[${formatSymbolDisplay(MONITOR_SYMBOL, monitorContext.monitorSymbolName)}] 无法构建指标快照，跳过本次处理`);
    return;
  }

  // 3. 监控指标变化
  context.marketMonitor.monitorIndicatorChanges(
    monitorSnapshot,
    monitorQuote,
    MONITOR_SYMBOL,
    emaPeriods,
    rsiPeriods,
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

  // 4. 获取持仓（使用 try-finally 确保释放）
  // 使用 PositionCache 进行 O(1) 查找
  const { longPosition, shortPosition } = getPositions(
    globalState.positionCache,
    LONG_SYMBOL,
    SHORT_SYMBOL,
  );

  try {
    // 5. 生成信号
    const { immediateSignals, delayedSignals } = strategy.generateCloseSignals(
      monitorSnapshot,
      LONG_SYMBOL,
      SHORT_SYMBOL,
      orderRecorder,
    );

    // 6. 为信号设置标的中文名称和价格信息（用于日志显示和后续处理）
    const enrichSignal = (signal: Signal): void => {
      const normalizedSigSymbol = signal.symbol;
      if (normalizedSigSymbol === LONG_SYMBOL && longQuote) {
        if (signal.symbolName == null && longQuote.name != null) signal.symbolName = longQuote.name;
        signal.price ??= longQuote.price;
        if (signal.lotSize == null && longQuote.lotSize != null) signal.lotSize = longQuote.lotSize;
      } else if (normalizedSigSymbol === SHORT_SYMBOL && shortQuote) {
        if (signal.symbolName == null && shortQuote.name != null) signal.symbolName = shortQuote.name;
        signal.price ??= shortQuote.price;
        if (signal.lotSize == null && shortQuote.lotSize != null) signal.lotSize = shortQuote.lotSize;
      }
    };

    // 7. 信号分流：立即信号 → TaskQueue，延迟信号 → DelayedSignalVerifier
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
        tradeTaskQueue.push({
          type: 'IMMEDIATE_SIGNAL',
          data: signal,
          monitorSymbol: MONITOR_SYMBOL,
        });
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

/**
 * 主程序循环：
 * 1. 从环境变量读取 LongPort 配置
 * 2. 拉取监控标的的 K 线数据
 * 3. 计算技术指标，并生成策略信号
 * 4. 根据监控标的的信号，对做多/做空标的执行交易
 */
async function runOnce({
  marketDataClient,
  trader,
  lastState,
  marketMonitor,
  doomsdayProtection,
  signalProcessor,
  monitorContexts,
  indicatorCache,
  tradeTaskQueue,
  // TradeProcessor 是自动运行的（通过 start()），不需要在 runOnce 中显式调用
  tradeProcessor: _tradeProcessor,
}: RunOnceContext): Promise<void> {
  // 使用缓存的账户和持仓信息（仅在交易后更新）
  const positions = lastState.cachedPositions ?? [];

  // 判断是否在交易时段（使用当前系统时间）
  const currentTime = new Date();

  // 首次运行时获取交易日信息
  let isTradingDayToday = true;
  let isHalfDayToday = false;

  if (lastState.cachedTradingDayInfo) {
    // 使用缓存的交易日信息
    isTradingDayToday = lastState.cachedTradingDayInfo.isTradingDay;
    isHalfDayToday = lastState.cachedTradingDayInfo.isHalfDay;
  } else {
    // 首次运行，调用 API 检查交易日信息
    try {
      const tradingDayInfo = await marketDataClient.isTradingDay(currentTime);
      isTradingDayToday = tradingDayInfo.isTradingDay;
      isHalfDayToday = tradingDayInfo.isHalfDay;

      // 缓存到 lastState
      lastState.cachedTradingDayInfo = {
        isTradingDay: isTradingDayToday,
        isHalfDay: isHalfDayToday,
      };

      // 日志记录
      if (isTradingDayToday) {
        const dayType = isHalfDayToday ? '半日交易日' : '交易日';
        logger.info(`今天是${dayType}`);
      } else {
        logger.info('今天不是交易日');
      }
    } catch (err) {
      logger.warn(
        '无法获取交易日信息，将根据时间判断是否在交易时段',
        formatError(err),
      );
    }
  }

  // 如果不是交易日，提前返回
  if (!isTradingDayToday) {
    if (lastState.canTrade !== false) {
      logger.info('今天不是交易日，暂停实时监控。');
      lastState.canTrade = false;
    }
    return;
  }

  // 如果是交易日，再检查是否在交易时段
  const canTradeNow =
    isTradingDayToday && isInContinuousHKSession(currentTime, isHalfDayToday);

  // 检测交易时段变化
  if (lastState.canTrade !== canTradeNow) {
    if (canTradeNow) {
      const sessionType = isHalfDayToday ? '（半日交易）' : '';
      logger.info(`进入连续交易时段${sessionType}，开始正常交易。`);
    } else if (isTradingDayToday) {
      logger.info('当前为竞价或非连续交易时段，暂停实时监控。');

      // 收盘时清理所有待验证的信号
      // 原因：收盘后 IndicatorCache 不再更新，待验证信号无法获取到 T0+5s/T0+10s 的数据
      // 会导致大量"缺少时间点数据"的验证失败日志
      let totalCancelled = 0;
      for (const [monitorSymbol, monitorContext] of monitorContexts) {
        const pendingCount = monitorContext.delayedSignalVerifier.getPendingCount();
        if (pendingCount > 0) {
          monitorContext.delayedSignalVerifier.cancelAllForSymbol(monitorSymbol);
          totalCancelled += pendingCount;
        }
      }
      if (totalCancelled > 0) {
        logger.info(`[交易时段结束] 已清理 ${totalCancelled} 个待验证信号`);
      }
    }
    lastState.canTrade = canTradeNow;
    lastState.isHalfDay = isHalfDayToday;
  }

  // 如果不在交易时段，跳过所有实时监控逻辑
  if (!canTradeNow) {
    return;
  }

  // 末日保护检查（全局性，在所有监控标的处理之前）
  if (MULTI_MONITOR_TRADING_CONFIG.global.doomsdayProtection) {
    // 收盘前15分钟：撤销所有未成交的买入订单
    const cancelResult = await doomsdayProtection.cancelPendingBuyOrders({
      currentTime,
      isHalfDay: isHalfDayToday,
      monitorConfigs: MULTI_MONITOR_TRADING_CONFIG.monitors,
      trader,
    });

    if (cancelResult.executed && cancelResult.cancelledCount > 0) {
      logger.info(`[末日保护程序] 收盘前15分钟撤单完成，共撤销 ${cancelResult.cancelledCount} 个买入订单`);
    }

    // 收盘前5分钟：自动清仓所有持仓
    const clearanceResult = await doomsdayProtection.executeClearance({
      currentTime,
      isHalfDay: isHalfDayToday,
      positions,
      monitorConfigs: MULTI_MONITOR_TRADING_CONFIG.monitors,
      monitorContexts,
      trader,
      marketDataClient,
      lastState,
    });

    if (clearanceResult.executed) {
      // 末日保护已执行清仓，跳过本次循环的监控标的处理
      return;
    }
  }

  // 收集所有需要获取行情的标的，一次性批量获取（减少 API 调用次数）
  // getQuotes 接口已支持 Iterable，无需 Array.from() 转换
  const allQuoteSymbols = collectAllQuoteSymbols(MULTI_MONITOR_TRADING_CONFIG.monitors);
  const quotesMap = await marketDataClient.getQuotes(allQuoteSymbols);

  // 并发处理所有监控标的（使用预先获取的行情数据）
  // 使用 for...of 直接迭代 Map，避免 Array.from() 创建中间数组
  const monitorTasks: Promise<void>[] = [];
  for (const [monitorSymbol, monitorContext] of monitorContexts) {
    monitorTasks.push(
      processMonitor({
        monitorContext,
        marketDataClient,
        trader,
        globalState: lastState,
        marketMonitor,
        doomsdayProtection,
        signalProcessor,
        currentTime,
        isHalfDay: isHalfDayToday,
        canTradeNow,
        // 新架构模块
        indicatorCache,
        tradeTaskQueue,
      }, quotesMap).catch((err: unknown) => {
        logger.error(`处理监控标的 ${formatSymbolDisplay(monitorSymbol, monitorContext.monitorSymbolName)} 失败`, formatError(err));
      }),
    );
  }

  await Promise.allSettled(monitorTasks);

  // 全局操作：订单监控（在所有监控标的处理完成后）
  // 使用预先缓存的 allTradingSymbols（静态配置，启动时计算一次）
  if (canTradeNow && lastState.allTradingSymbols.size > 0) {
    // 复用前面批量获取的行情数据进行订单监控（quotesMap 已包含所有交易标的的行情）
    await trader.monitorAndManageOrders(quotesMap).catch((err: unknown) => {
      logger.warn('订单监控失败', formatError(err));
    });

    // 订单成交后刷新缓存数据（由 WebSocket 推送触发，在此处统一处理）
    // 相比订单提交后立即刷新，此时本地订单记录已经更新，数据更准确
    // 注意：刷新后的缓存仅用于日志显示，不用于风险检查
    // 买入检查时会从API获取最新数据，确保风险检查使用最新账户和持仓信息
    const pendingRefreshSymbols = trader.getAndClearPendingRefreshSymbols();
    if (pendingRefreshSymbols.length > 0) {
      // 检查是否需要刷新账户和持仓
      const needRefreshAccount = pendingRefreshSymbols.some((r) => r.refreshAccount);
      const needRefreshPositions = pendingRefreshSymbols.some((r) => r.refreshPositions);

      // 刷新账户和持仓缓存（仅用于日志显示）
      if (needRefreshAccount || needRefreshPositions) {
        try {
          const [freshAccount, freshPositions] = await Promise.all([
            needRefreshAccount ? trader.getAccountSnapshot() : Promise.resolve(null),
            needRefreshPositions ? trader.getStockPositions() : Promise.resolve(null),
          ]);

          if (freshAccount !== null) {
            lastState.cachedAccount = freshAccount;
            logger.debug('[缓存刷新] 订单成交后刷新账户缓存');
          }

          if (Array.isArray(freshPositions)) {
            lastState.cachedPositions = freshPositions;
            lastState.positionCache.update(freshPositions);
            logger.debug('[缓存刷新] 订单成交后刷新持仓缓存');
          }
        } catch (err) {
          logger.warn('[缓存刷新] 订单成交后刷新缓存失败', formatError(err));
        }
      }

      // 刷新浮亏数据
      for (const { symbol, isLongSymbol } of pendingRefreshSymbols) {
        // 查找对应的监控上下文
        // 使用 for...of + break 替代 Array.from().find()，避免创建中间数组
        let monitorContext: MonitorContext | undefined;
        for (const ctx of monitorContexts.values()) {
          if (ctx.config.longSymbol === symbol || ctx.config.shortSymbol === symbol) {
            monitorContext = ctx;
            break;
          }
        }

        if (monitorContext && (monitorContext.config.maxUnrealizedLossPerSymbol ?? 0) > 0) {
          const quote = quotesMap.get(symbol) ?? null;
          const symbolName = isLongSymbol ? monitorContext.longSymbolName : monitorContext.shortSymbolName;
          await monitorContext.riskChecker
            .refreshUnrealizedLossData(monitorContext.orderRecorder, symbol, isLongSymbol, quote)
            .catch((err: unknown) => {
              logger.warn(`[浮亏监控] 订单成交后刷新浮亏数据失败: ${formatSymbolDisplay(symbol, symbolName)}`, formatError(err));
            });
        }
      }

      // 订单成交后显示账户和持仓信息（此时缓存已刷新，直接使用缓存）
      await displayAccountAndPositions(trader, marketDataClient, lastState);
    }
  }
}

/**
 * 创建监控标的上下文
 *
 * @param config 监控配置
 * @param state 监控状态
 * @param trader 交易器
 * @param quotesMap 预先批量获取的行情数据 Map（用于获取标的名称，减少 API 调用）
 * @param indicatorCache 指标缓存（全局共享，供延迟验证器查询）
 */
function createMonitorContext(
  config: MonitorConfig,
  state: MonitorState,
  trader: Trader,
  quotesMap: ReadonlyMap<string, Quote | null>,
  indicatorCache: IndicatorCache,
): MonitorContext {
  // 从预先获取的行情 Map 中提取标的名称（无需单独 API 调用）
  const longQuote = quotesMap.get(config.longSymbol) ?? null;
  const shortQuote = quotesMap.get(config.shortSymbol) ?? null;
  const monitorQuote = quotesMap.get(config.monitorSymbol) ?? null;

  return {
    config,
    state,
    strategy: createHangSengMultiIndicatorStrategy({
      signalConfig: config.signalConfig,
      verificationConfig: config.verificationConfig,
    }),
    // 使用 trader 内部创建的共享 orderRecorder 实例
    // 订单记录更新已移至 orderMonitor，成交时自动更新
    orderRecorder: trader._orderRecorder,
    riskChecker: createRiskChecker({
      options: {
        maxDailyLoss: config.maxDailyLoss,
        maxPositionNotional: config.maxPositionNotional,
        maxUnrealizedLossPerSymbol: config.maxUnrealizedLossPerSymbol,
      },
    }),
    // 每个监控标的独立的浮亏监控器（使用各自的 maxUnrealizedLossPerSymbol 配置）
    unrealizedLossMonitor: createUnrealizedLossMonitor({
      maxUnrealizedLossPerSymbol: config.maxUnrealizedLossPerSymbol ?? 0,
    }),
    // 每个监控标的独立的延迟信号验证器（使用各自的验证配置）
    delayedSignalVerifier: createDelayedSignalVerifier({
      indicatorCache,
      verificationConfig: config.verificationConfig,
    }),
    // 缓存标的名称（避免每次循环重复获取）
    longSymbolName: longQuote?.name ?? config.longSymbol,
    shortSymbolName: shortQuote?.name ?? config.shortSymbol,
    monitorSymbolName: monitorQuote?.name ?? config.monitorSymbol,
    // 缓存规范化后的标的代码（config中已经规范化，直接使用）
    normalizedLongSymbol: config.longSymbol,
    normalizedShortSymbol: config.shortSymbol,
    normalizedMonitorSymbol: config.monitorSymbol,
    // 缓存指标周期配置（避免每次循环重复提取）
    rsiPeriods: extractRsiPeriodsWithDefault(config.signalConfig),
    emaPeriods: extractEmaPeriods(config.verificationConfig),
    // 缓存的行情数据（主循环每秒更新，供 TradeProcessor 使用）
    longQuote,
    shortQuote,
    monitorQuote,
    // 注意：持仓数据通过 lastState.positionCache 获取，不在 MonitorContext 中缓存
  };
}

async function main(): Promise<void> {
  // 牛牛登场
  getSprintSacreMooacreMoo();
  // 首先验证配置，并获取标的的中文名称
  let symbolNames: ValidateAllConfigResult;
  try {
    symbolNames = await validateAllConfig();
  } catch (err) {
    if ((err as { name?: string }).name === 'ConfigValidationError') {
      logger.error('程序启动失败：配置验证未通过');
      process.exit(1);
    } else {
      logger.error('配置验证过程中发生错误', err);
      process.exit(1);
    }
  }

  const config = createConfig();

  // 使用配置验证返回的标的名称和行情客户端实例
  const { marketDataClient } = symbolNames;
  const trader = await createTrader({ config });

  logger.info('程序开始运行，在交易时段将进行实时监控和交易（按 Ctrl+C 退出）');

  // 预先计算所有交易标的集合（静态配置，只计算一次）
  const allTradingSymbols = new Set<string>();
  for (const monitorConfig of MULTI_MONITOR_TRADING_CONFIG.monitors) {
    if (monitorConfig.longSymbol) {
      allTradingSymbols.add(monitorConfig.longSymbol);
    }
    if (monitorConfig.shortSymbol) {
      allTradingSymbols.add(monitorConfig.shortSymbol);
    }
  }

  // 记录上一次的数据状态
  const lastState: LastState = {
    canTrade: null,
    isHalfDay: null,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: createPositionCache(), // 初始化持仓缓存（O(1) 查找）
    cachedTradingDayInfo: null, // 缓存的交易日信息 { isTradingDay, isHalfDay, checkDate }
    monitorStates: new Map(
      MULTI_MONITOR_TRADING_CONFIG.monitors.map((config) => [
        config.monitorSymbol,
        createMonitorState(config),
      ]),
    ),
    allTradingSymbols, // 缓存所有交易标的集合
  };

  // 初始化新模块实例
  const marketMonitor = createMarketMonitor();
  const doomsdayProtection = createDoomsdayProtection();
  const signalProcessor = createSignalProcessor();

  // 初始化新架构模块
  // 计算 IndicatorCache 的容量：max(buyDelay, sellDelay) + 15 + 10
  // 注意：IndicatorCache 需要在 monitorContexts 创建之前初始化，因为每个 MonitorContext 中的
  // DelayedSignalVerifier 需要引用 IndicatorCache
  const maxDelaySeconds = Math.max(
    ...MULTI_MONITOR_TRADING_CONFIG.monitors.map((m) =>
      Math.max(m.verificationConfig.buy.delaySeconds, m.verificationConfig.sell.delaySeconds),
    ),
  );
  const indicatorCacheMaxEntries = maxDelaySeconds + 15 + 10;
  const indicatorCache = createIndicatorCache({ maxEntries: indicatorCacheMaxEntries });
  const tradeTaskQueue = createTradeTaskQueue();

  // 初始化监控标的上下文
  // 首先批量获取所有标的行情（用于获取标的名称，减少 API 调用次数）
  const allInitSymbols = collectAllQuoteSymbols(MULTI_MONITOR_TRADING_CONFIG.monitors);
  // getQuotes 接口已支持 Iterable，无需 Array.from() 转换
  const initQuotesMap = await marketDataClient.getQuotes(allInitSymbols);

  const monitorContexts: Map<string, MonitorContext> = new Map();
  for (const monitorConfig of MULTI_MONITOR_TRADING_CONFIG.monitors) {
    const monitorState = lastState.monitorStates.get(monitorConfig.monitorSymbol);
    // 获取监控标的名称（用于日志显示）
    const monitorQuote = initQuotesMap.get(monitorConfig.monitorSymbol) ?? null;
    const monitorSymbolName = monitorQuote?.name ?? null;
    if (!monitorState) {
      logger.warn(`监控标的状态不存在: ${formatSymbolDisplay(monitorConfig.monitorSymbol, monitorSymbolName)}`);
      continue;
    }

    // 使用预先获取的行情数据创建上下文（无需单独 API 调用）
    // 每个监控标的创建独立的 DelayedSignalVerifier（使用各自的验证配置）
    const context = createMonitorContext(monitorConfig, monitorState, trader, initQuotesMap, indicatorCache);
    monitorContexts.set(monitorConfig.monitorSymbol, context);

    // 初始化每个监控标的牛熊证信息
    await context.riskChecker
      .initializeWarrantInfo(
        marketDataClient,
        monitorConfig.longSymbol,
        monitorConfig.shortSymbol,
        context.longSymbolName,
        context.shortSymbolName,
      )
      .catch((err: unknown) => {
        logger.warn(
          `[牛熊证初始化失败] 监控标的 ${formatSymbolDisplay(monitorConfig.monitorSymbol, monitorSymbolName)}`,
          formatError(err),
        );
      });
  }

  // 程序启动时立即获取一次账户和持仓信息
  await displayAccountAndPositions(trader, marketDataClient, lastState);

  // 验证账户信息获取成功（程序启动必须获取到账户信息）
  if (!lastState.cachedAccount) {
    logger.error('程序启动失败：无法获取账户信息');
    process.exit(1);
  }

  // 验证持仓信息获取成功（空数组是有效的，表示无持仓）
  if (!Array.isArray(lastState.cachedPositions)) {
    logger.error('程序启动失败：无法获取持仓信息');
    process.exit(1);
  }

  logger.info('账户和持仓信息获取成功，程序初始化完成');

  // 程序启动时刷新订单记录（为所有监控标的初始化订单记录）
  // 复用之前批量获取的行情数据（initQuotesMap 已包含所有交易标的的行情）
  // 为每个监控标的初始化订单记录
  for (const monitorContext of monitorContexts.values()) {
    const { config, orderRecorder } = monitorContext;
    if (config.longSymbol) {
      const quote = initQuotesMap.get(config.longSymbol) ?? null;
      await orderRecorder
        .refreshOrders(config.longSymbol, true, quote)
        .catch((err: unknown) => {
          logger.warn(
            `[订单记录初始化失败] 监控标的 ${formatSymbolDisplay(config.monitorSymbol, monitorContext.monitorSymbolName)} 做多标的 ${formatSymbolDisplay(config.longSymbol, monitorContext.longSymbolName)}`,
            formatError(err),
          );
        });
    }
    if (config.shortSymbol) {
      const quote = initQuotesMap.get(config.shortSymbol) ?? null;
      await orderRecorder
        .refreshOrders(config.shortSymbol, false, quote)
        .catch((err: unknown) => {
          logger.warn(
            `[订单记录初始化失败] 监控标的 ${formatSymbolDisplay(config.monitorSymbol, monitorContext.monitorSymbolName)} 做空标的 ${formatSymbolDisplay(config.shortSymbol, monitorContext.shortSymbolName)}`,
            formatError(err),
          );
        });
    }
  }

  // 程序启动时初始化浮亏监控数据（为所有监控标的初始化）
  for (const monitorContext of monitorContexts.values()) {
    const { config, riskChecker, orderRecorder } = monitorContext;
    if ((config.maxUnrealizedLossPerSymbol ?? 0) > 0) {
      if (config.longSymbol) {
        const quote = initQuotesMap.get(config.longSymbol) ?? null;
        await riskChecker
          .refreshUnrealizedLossData(orderRecorder, config.longSymbol, true, quote)
          .catch((err: unknown) => {
            logger.warn(
              `[浮亏监控初始化失败] 监控标的 ${formatSymbolDisplay(config.monitorSymbol, monitorContext.monitorSymbolName)} 做多标的 ${formatSymbolDisplay(config.longSymbol, monitorContext.longSymbolName)}`,
              formatError(err),
            );
          });
      }
      if (config.shortSymbol) {
        const quote = initQuotesMap.get(config.shortSymbol) ?? null;
        await riskChecker
          .refreshUnrealizedLossData(orderRecorder, config.shortSymbol, false, quote)
          .catch((err: unknown) => {
            logger.warn(
              `[浮亏监控初始化失败] 监控标的 ${formatSymbolDisplay(config.monitorSymbol, monitorContext.monitorSymbolName)} 做空标的 ${formatSymbolDisplay(config.shortSymbol, monitorContext.shortSymbolName)}`,
              formatError(err),
            );
          });
      }
    }
  }

  // 注意：程序启动时的订单追踪恢复已在 createTrader 中完成
  // orderMonitor.recoverTrackedOrders() 会自动查询并恢复所有未完成订单的追踪

  // 为每个监控标的的 DelayedSignalVerifier 注册回调
  // 验证通过后将信号推入 TradeTaskQueue
  for (const [monitorSymbol, monitorContext] of monitorContexts) {
    const { delayedSignalVerifier } = monitorContext;

    delayedSignalVerifier.onVerified((signal, signalMonitorSymbol) => {
      logger.info(`[延迟验证通过] 信号推入任务队列: ${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)} ${signal.action}`);
      tradeTaskQueue.push({
        type: 'VERIFIED_SIGNAL',
        data: signal,
        monitorSymbol: signalMonitorSymbol,
      });
    });

    delayedSignalVerifier.onRejected((signal, _signalMonitorSymbol, reason) => {
      logger.info(`[延迟验证失败] ${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)} ${signal.action}: ${reason}`);
      // 验证失败的信号由 DelayedSignalVerifier 内部释放，无需在此处理
    });

    logger.debug(`[DelayedSignalVerifier] 监控标的 ${formatSymbolDisplay(monitorSymbol, monitorContext.monitorSymbolName)} 的验证器已初始化`);
  }

  // 创建 TradeProcessor
  const tradeProcessor = createTradeProcessor({
    taskQueue: tradeTaskQueue,
    getMonitorContext: (monitorSymbol: string) => monitorContexts.get(monitorSymbol),
    signalProcessor,
    trader,
    doomsdayProtection,
    getLastState: () => lastState,
    getIsHalfDay: () => lastState.isHalfDay ?? false,
  });

  // 启动 TradeProcessor
  tradeProcessor.start();
  logger.info('[TradeProcessor] 交易处理器已启动');

  // 注册退出处理函数，确保程序退出时释放所有对象池对象
  const cleanup = (): void => {
    logger.info('程序退出，正在清理资源...');
    // 停止 TradeProcessor
    tradeProcessor.stop();
    // 销毁所有监控标的的 DelayedSignalVerifier
    for (const monitorContext of monitorContexts.values()) {
      monitorContext.delayedSignalVerifier.destroy();
    }
    // 清理 IndicatorCache
    indicatorCache.clearAll();
    // 释放快照对象
    releaseAllMonitorSnapshots(lastState.monitorStates);
  };

  process.once('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  // 无限循环监控
  while (true) {
    try {
      await runOnce({
        marketDataClient,
        trader,
        lastState,
        marketMonitor,
        doomsdayProtection,
        signalProcessor,
        monitorContexts,
        // 新架构模块
        indicatorCache,
        tradeTaskQueue,
        tradeProcessor,
      });
    } catch (err) {
      logger.error('本次执行失败', formatError(err));
    }

    await sleep(TRADING.INTERVAL_MS);
  }
}

try {
  await main();
} catch (err: unknown) {
  logger.error('程序异常退出', formatError(err));
  // 注意：异常退出时无法访问lastState，所以不在catch中清理
  process.exit(1);
}
