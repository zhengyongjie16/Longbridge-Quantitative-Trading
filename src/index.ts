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
import { createOrderRecorder } from './core/orderRecorder/index.js';
import {
  positionObjectPool,
  signalObjectPool,
  kdjObjectPool,
  macdObjectPool,
} from './utils/objectPool/index.js';
import {
  normalizeHKSymbol,
  getSymbolName,
  isBuyAction,
  isSellAction,
  formatError,
  formatSignalLog,
  sleep,
} from './utils/helpers/index.js';
import { extractRSIPeriods } from './utils/helpers/signalConfigParser.js';
import { validateEmaPeriod } from './utils/helpers/indicatorHelpers.js';
import { batchGetQuotes } from './utils/helpers/quoteHelpers.js';
import {
  VALID_SIGNAL_ACTIONS,
  SIGNAL_TARGET_ACTIONS,
  TRADING,
} from './constants/index.js';
import { OrderSide } from 'longport';

// 导入新模块
import { isInContinuousHKSession } from './utils/helpers/tradingTime.js';
import { displayAccountAndPositions } from './utils/helpers/accountDisplay.js';
import { createPositionCache } from './utils/helpers/positionCache.js';
import { createMarketMonitor } from './core/marketMonitor/index.js';
import { createDoomsdayProtection } from './core/doomsdayProtection/index.js';
import { createUnrealizedLossMonitor } from './core/unrealizedLossMonitor/index.js';
import { createSignalVerificationManager } from './core/signalVerification/index.js';
import { createSignalProcessor } from './core/signalProcessor/index.js';
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
import type { MarketMonitor } from './core/marketMonitor/types.js';
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
}


// 性能优化：从验证配置中提取 EMA 周期（模块加载时执行一次）
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

// 性能优化：从信号配置中提取 RSI 周期（模块加载时执行一次）
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
 */
async function processMonitor(
  _monitorSymbol: string,
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
  },
): Promise<void> {
  const {
    monitorContext,
    marketDataClient,
    trader,
    globalState,
    marketMonitor,
    currentTime,
    canTradeNow,
  } = context;
  const { config, state, strategy, orderRecorder, signalVerificationManager, riskChecker, unrealizedLossMonitor } = monitorContext;

  const LONG_SYMBOL = config.longSymbol;
  const SHORT_SYMBOL = config.shortSymbol;
  const MONITOR_SYMBOL = config.monitorSymbol;

  // 使用缓存的标的名称（避免每次循环重复获取）
  const longSymbolName = monitorContext.longSymbolName;
  const shortSymbolName = monitorContext.shortSymbolName;
  const monitorSymbolName = monitorContext.monitorSymbolName;

  // 1. 获取行情
  const [longQuote, shortQuote, monitorQuote] = await Promise.all([
    marketDataClient.getLatestQuote(LONG_SYMBOL).catch(() => null),
    marketDataClient.getLatestQuote(SHORT_SYMBOL).catch(() => null),
    marketDataClient.getLatestQuote(MONITOR_SYMBOL).catch(() => null),
  ]);

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
    logger.warn(`未获取到监控标的 ${MONITOR_SYMBOL} K线数据`);
    return;
  }

  const rsiPeriods = extractRsiPeriodsWithDefault(config.signalConfig);
  const emaPeriods = extractEmaPeriods(config.verificationConfig);

  const monitorSnapshot = buildIndicatorSnapshot(
    MONITOR_SYMBOL,
    monitorCandles as CandleData[],
    rsiPeriods,
    emaPeriods,
  );

  // 3. 监控指标变化
  context.marketMonitor.monitorIndicatorChanges(
    monitorSnapshot,
    monitorQuote,
    MONITOR_SYMBOL,
    emaPeriods,
    rsiPeriods,
    state,
  );

  // 释放上一次快照中的 kdj 和 macd 对象（如果它们没有被 monitorValues 引用）
  releaseSnapshotObjects(state.lastMonitorSnapshot, state.monitorValues);
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

    // 6. 处理延迟验证（先添加新信号，再记录验证历史，确保新添加的信号也能被记录）
    signalVerificationManager.addDelayedSignals(delayedSignals, state);
    // 记录验证历史（在添加新信号后调用，确保新添加的信号也能被记录）
    signalVerificationManager.recordVerificationHistory(monitorSnapshot, state);
    const verifiedSignals = signalVerificationManager.verifyPendingSignals(
      state,
      longQuote,
      shortQuote,
    );

    const tradingSignals = [...immediateSignals, ...verifiedSignals];

    // 过滤并验证信号数组的有效性
    const validSignals = tradingSignals.filter((signal) => {
      if (!signal?.symbol || !signal?.action) {
        logger.warn(`[跳过信号] 无效的信号对象: ${JSON.stringify(signal)}`);
        return false;
      }
      if (!VALID_SIGNAL_ACTIONS.has(signal.action)) {
        logger.warn(
          `[跳过信号] 未知的信号类型: ${signal.action}, 标的: ${signal.symbol}`,
        );
        return false;
      }
      return true;
    });

    // 释放无效的信号对象
    const validSignalsSet = new Set(validSignals);
    const invalidSignals = tradingSignals.filter((s) => !validSignalsSet.has(s));
    if (invalidSignals.length > 0) {
      signalObjectPool.releaseAll(invalidSignals);
    }

    // 检测信号变化
    const currentSignalKey =
    validSignals.length > 0
      ? validSignals
        .map((s) => `${s.action}_${s.symbol}_${s.reason || ''}`)
        .join('|')
      : null;
    const lastSignalKey = state.signal;

    if (currentSignalKey !== lastSignalKey) {
      if (validSignals.length > 0) {
        validSignals.forEach((signal) => {
          logger.info(`[交易信号] ${formatSignalLog(signal)}`);
        });
      } else {
        logger.info(
          `[监控标的信号] ${monitorSymbolName}(${MONITOR_SYMBOL}) 无交易信号`,
        );
      }

      state.signal = currentSignalKey;
    }

    // 补充价格和lotSize信息
    for (const signal of validSignals) {
      const normalizedSigSymbol = signal.symbol;

      if (normalizedSigSymbol === LONG_SYMBOL && longQuote) {
        signal.price ??= longQuote.price;
        if (signal.lotSize == null && longQuote.lotSize != null) signal.lotSize = longQuote.lotSize;
        if (signal.symbolName == null && longQuote.name != null) signal.symbolName = longQuote.name;
      } else if (normalizedSigSymbol === SHORT_SYMBOL && shortQuote) {
        signal.price ??= shortQuote.price;
        if (signal.lotSize == null && shortQuote.lotSize != null) signal.lotSize = shortQuote.lotSize;
        if (signal.symbolName == null && shortQuote.name != null) signal.symbolName = shortQuote.name;
      }
    }

    // 8. 风险检查和信号处理
    // 注意：末日保护是全局性的，应该在runOnce中处理，不在processMonitor中处理
    const account = globalState.cachedAccount ?? null;
    const positions = globalState.cachedPositions ?? [];

    let finalSignals: Signal[] = [];

    // 正常交易信号处理：应用风险检查
    if (validSignals.length > 0 && canTradeNow) {
      const riskCheckContext = {
        trader,
        riskChecker,
        orderRecorder,
        longQuote,
        shortQuote,
        monitorQuote,
        monitorSnapshot,
        longSymbol: LONG_SYMBOL,
        shortSymbol: SHORT_SYMBOL,
        longSymbolName,
        shortSymbolName,
        account,
        positions,
        // 使用 globalState 引用，确保在 applyRiskChecks 中获取的新持仓数据能同步回全局状态
        lastState: globalState,
        currentTime,
        isHalfDay: context.isHalfDay,
        doomsdayProtection: context.doomsdayProtection,
        config,
      };

      finalSignals = await context.signalProcessor.applyRiskChecks(validSignals, riskCheckContext);

      // 释放在风险检查中被跳过的信号
      const skippedSignals = validSignals.filter(
        (sig) => !finalSignals.includes(sig),
      );
      if (skippedSignals.length > 0) {
        signalObjectPool.releaseAll(skippedSignals);
      }
    }

    // 只在有交易信号时显示执行信息
    if (finalSignals.length > 0) {
      for (const sig of finalSignals) {
        const normalizedSigSymbol = sig.symbol;
        const sigName = getSymbolName(
          sig.symbol,
          LONG_SYMBOL,
          SHORT_SYMBOL,
          longSymbolName,
          shortSymbolName,
        );

        const targetAction = SIGNAL_TARGET_ACTIONS[sig.action] || '未知';

        logger.info(
          `[交易指令] 将对 ${sigName}(${normalizedSigSymbol}) 执行${targetAction}操作 - ${sig.reason}`,
        );
      }
    } else if (validSignals.length > 0 && !canTradeNow) {
      logger.info('当前为竞价或非连续交易时段，交易信号已生成但暂不执行。');
      // 释放信号对象（因为不会执行）
      if (validSignals.length > 0) {
        signalObjectPool.releaseAll(validSignals);
      }
    }

    // 9. 执行交易
    if (finalSignals.length > 0) {
      logger.info(`[监控标的 ${monitorSymbolName}] 执行交易：共 ${finalSignals.length} 个交易信号`);

      // 对卖出信号进行成本价判断和卖出数量计算
      context.signalProcessor.processSellSignals(
        finalSignals,
        longPosition,
        shortPosition,
        longQuote,
        shortQuote,
        orderRecorder,
      );

      // 过滤掉被设置为HOLD的信号
      const signalsToExecute = finalSignals.filter(
        (sig) => sig.action !== 'HOLD',
      );

      if (signalsToExecute.length > 0) {
        await trader.executeSignals(signalsToExecute);

        // 交易执行后刷新持仓缓存，确保下次循环能获取最新持仓
        // 这对于买入后的卖出信号处理尤为重要
        const hasBuySignal = signalsToExecute.some((sig) => isBuyAction(sig.action));
        if (hasBuySignal) {
          try {
            const freshPositions = await trader.getStockPositions();
            if (Array.isArray(freshPositions)) {
              globalState.cachedPositions = freshPositions;
              // 同步更新持仓缓存（O(1) 查找优化）
              globalState.positionCache.update(freshPositions);
              logger.debug(`[持仓缓存] 买入执行后刷新持仓缓存，当前持仓数量: ${freshPositions.length}`);
            }
          } catch (err) {
            logger.warn('[持仓缓存] 买入执行后刷新持仓缓存失败', formatError(err));
          }
        }
      } else {
        logger.info('所有卖出信号因成本价判断被跳过，无交易执行');
      }

      // 交易后本地更新订单记录
      if (orderRecorder && signalsToExecute.length > 0) {
        for (const sig of signalsToExecute) {
          const quantity = Number(sig.quantity);
          const price = Number(sig.price);

          if (!Number.isFinite(quantity) || quantity <= 0) {
            continue;
          }
          if (!Number.isFinite(price) || price <= 0) {
            continue;
          }
          if (!isBuyAction(sig.action) && !isSellAction(sig.action)) {
            continue;
          }

          const isLongSymbol =
          sig.action === 'BUYCALL' ||
          sig.action === 'SELLCALL';
          const symbol = sig.symbol;

          if (isBuyAction(sig.action)) {
            orderRecorder.recordLocalBuy(symbol, price, quantity, isLongSymbol);
          } else if (isSellAction(sig.action)) {
            orderRecorder.recordLocalSell(symbol, price, quantity, isLongSymbol);
          }

          // 交易后刷新浮亏监控数据
          if ((config.maxUnrealizedLossPerSymbol ?? 0) > 0 && riskChecker) {
            try {
            // 获取对应的行情数据用于格式化显示
              const quoteForSymbol = isLongSymbol ? longQuote : shortQuote;
              await riskChecker.refreshUnrealizedLossData(
                orderRecorder,
                symbol,
                isLongSymbol,
                quoteForSymbol,
              );
            } catch (err) {
              logger.warn(
                `[浮亏监控] 交易后刷新浮亏数据失败: ${symbol}`,
                formatError(err),
              );
            }
          }
        }
      }

      // 释放所有信号对象回对象池
      if (signalsToExecute && signalsToExecute.length > 0) {
        signalObjectPool.releaseAll(signalsToExecute);
      }
      // 释放未执行的信号（finalSignals 中被过滤掉的 HOLD 信号）
      if (finalSignals && finalSignals.length > 0) {
        const heldSignals = finalSignals.filter(
          (sig) => sig.action === 'HOLD',
        );
        if (heldSignals.length > 0) {
          signalObjectPool.releaseAll(heldSignals);
        }
      }
    }

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
      displayAccountAndPositions,
    });

    if (clearanceResult.executed) {
      // 末日保护已执行清仓，跳过本次循环的监控标的处理
      return;
    }
  }

  // 并发处理所有监控标的
  const monitorTasks = Array.from(monitorContexts.entries()).map(
    ([monitorSymbol, monitorContext]) =>
      processMonitor(monitorSymbol, {
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
      }).catch((err: unknown) => {
        logger.error(`处理监控标的 ${monitorSymbol} 失败`, formatError(err));
      }),
  );

  await Promise.allSettled(monitorTasks);

  // 全局操作：订单监控（在所有监控标的处理完成后）
  const allTradingSymbols = new Set<string>();
  for (const monitorConfig of MULTI_MONITOR_TRADING_CONFIG.monitors) {
    if (monitorConfig.longSymbol) {
      allTradingSymbols.add(monitorConfig.longSymbol);
    }
    if (monitorConfig.shortSymbol) {
      allTradingSymbols.add(monitorConfig.shortSymbol);
    }
  }

  if (canTradeNow && allTradingSymbols.size > 0) {
    // 获取所有交易标的的行情用于订单监控
    const quotesMap = await batchGetQuotes(marketDataClient, allTradingSymbols);

    // 使用新的 Map 方式调用订单监控，支持所有标的
    await trader.monitorAndManageOrders(quotesMap).catch((err: unknown) => {
      logger.warn('订单监控失败', formatError(err));
    });
  }
}

/**
 * 创建监控标的上下文
 */
async function createMonitorContext(
  config: MonitorConfig,
  state: MonitorState,
  trader: Trader,
  marketDataClient: MarketDataClient,
): Promise<MonitorContext> {
  // 获取标的名称（只在初始化时执行一次）
  const [longQuote, shortQuote, monitorQuote] = await Promise.all([
    marketDataClient.getLatestQuote(config.longSymbol).catch(() => null),
    marketDataClient.getLatestQuote(config.shortSymbol).catch(() => null),
    marketDataClient.getLatestQuote(config.monitorSymbol).catch(() => null),
  ]);

  return {
    config,
    state,
    strategy: createHangSengMultiIndicatorStrategy({
      signalConfig: config.signalConfig,
      verificationConfig: config.verificationConfig,
    }),
    orderRecorder: createOrderRecorder({ trader }),
    signalVerificationManager: createSignalVerificationManager(config.verificationConfig),
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
    // 缓存标的名称（避免每次循环重复获取）
    longSymbolName: longQuote?.name ?? config.longSymbol,
    shortSymbolName: shortQuote?.name ?? config.shortSymbol,
    monitorSymbolName: monitorQuote?.name ?? config.monitorSymbol,
    // 缓存规范化后的标的代码（config中已经规范化，直接使用）
    normalizedLongSymbol: config.longSymbol,
    normalizedShortSymbol: config.shortSymbol,
    normalizedMonitorSymbol: config.monitorSymbol,
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
  };

  // 初始化监控标的上下文
  const monitorContexts: Map<string, MonitorContext> = new Map();
  for (const monitorConfig of MULTI_MONITOR_TRADING_CONFIG.monitors) {
    const monitorState = lastState.monitorStates.get(monitorConfig.monitorSymbol);
    if (!monitorState) {
      logger.warn(`监控标的状态不存在: ${monitorConfig.monitorSymbol}`);
      continue;
    }

    const context = await createMonitorContext(monitorConfig, monitorState, trader, marketDataClient);
    monitorContexts.set(monitorConfig.monitorSymbol, context);

    // 初始化每个监控标的牛熊证信息
    await context.riskChecker
      .initializeWarrantInfo(
        marketDataClient,
        monitorConfig.longSymbol,
        monitorConfig.shortSymbol,
      )
      .catch((err: unknown) => {
        logger.warn(
          `[牛熊证初始化失败] 监控标的 ${monitorConfig.monitorSymbol}`,
          formatError(err),
        );
      });
  }

  // 初始化新模块实例
  const marketMonitor = createMarketMonitor();
  const doomsdayProtection = createDoomsdayProtection();
  const signalProcessor = createSignalProcessor();

  // 程序启动时立即获取一次账户和持仓信息
  await displayAccountAndPositions(trader, marketDataClient, lastState);

  // 程序启动时刷新订单记录（为所有监控标的初始化订单记录）
  const allTradingSymbolsForInit = new Set<string>();
  for (const monitorConfig of MULTI_MONITOR_TRADING_CONFIG.monitors) {
    if (monitorConfig.longSymbol) {
      allTradingSymbolsForInit.add(monitorConfig.longSymbol);
    }
    if (monitorConfig.shortSymbol) {
      allTradingSymbolsForInit.add(monitorConfig.shortSymbol);
    }
  }

  // 获取所有交易标的的行情数据用于格式化显示
  const quoteMapForInit = new Map<string, Quote | null>();
  for (const symbol of allTradingSymbolsForInit) {
    try {
      const quote = await marketDataClient.getLatestQuote(symbol).catch(() => null);
      quoteMapForInit.set(symbol, quote);
    } catch {
      quoteMapForInit.set(symbol, null);
    }
  }

  // 为每个监控标的初始化订单记录
  for (const monitorContext of monitorContexts.values()) {
    const { config, orderRecorder } = monitorContext;
    if (config.longSymbol) {
      const quote = quoteMapForInit.get(config.longSymbol) ?? null;
      await orderRecorder
        .refreshOrders(config.longSymbol, true, quote)
        .catch((err: unknown) => {
          logger.warn(
            `[订单记录初始化失败] 监控标的 ${config.monitorSymbol} 做多标的 ${config.longSymbol}`,
            formatError(err),
          );
        });
    }
    if (config.shortSymbol) {
      const quote = quoteMapForInit.get(config.shortSymbol) ?? null;
      await orderRecorder
        .refreshOrders(config.shortSymbol, false, quote)
        .catch((err: unknown) => {
          logger.warn(
            `[订单记录初始化失败] 监控标的 ${config.monitorSymbol} 做空标的 ${config.shortSymbol}`,
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
        const quote = quoteMapForInit.get(config.longSymbol) ?? null;
        await riskChecker
          .refreshUnrealizedLossData(orderRecorder, config.longSymbol, true, quote)
          .catch((err: unknown) => {
            logger.warn(
              `[浮亏监控初始化失败] 监控标的 ${config.monitorSymbol} 做多标的 ${config.longSymbol}`,
              formatError(err),
            );
          });
      }
      if (config.shortSymbol) {
        const quote = quoteMapForInit.get(config.shortSymbol) ?? null;
        await riskChecker
          .refreshUnrealizedLossData(orderRecorder, config.shortSymbol, false, quote)
          .catch((err: unknown) => {
            logger.warn(
              `[浮亏监控初始化失败] 监控标的 ${config.monitorSymbol} 做空标的 ${config.shortSymbol}`,
              formatError(err),
            );
          });
      }
    }
  }

  // 程序启动时检查一次是否有买入的未成交订单（每个 orderRecorder 检查自己负责的标的）
  try {
    // 使用 Set 去重，避免同一标的被多次监控
    const pendingBuySymbolsSet = new Set<string>();

    for (const monitorContext of monitorContexts.values()) {
      const { config, orderRecorder } = monitorContext;
      const symbols = [config.longSymbol, config.shortSymbol]
        .filter(Boolean)
        .map((s) => normalizeHKSymbol(s));

      if (symbols.length > 0 && orderRecorder.hasCacheForSymbols(symbols)) {
        // 从缓存获取未成交订单，精确找出哪个标的有未成交买入订单
        const pendingOrders = orderRecorder.getPendingOrdersFromCache(symbols);
        for (const order of pendingOrders) {
          if (order.side === OrderSide.Buy) {
            const normalizedSymbol = normalizeHKSymbol(order.symbol);
            pendingBuySymbolsSet.add(normalizedSymbol);
          }
        }
      }
    }

    // 为每个有未成交买入订单的标的启用监控
    if (pendingBuySymbolsSet.size > 0) {
      for (const symbol of pendingBuySymbolsSet) {
        trader.enableBuyOrderMonitoring(symbol);
      }
      const symbolsList = Array.from(pendingBuySymbolsSet).join(', ');
      logger.info(`[订单监控] 程序启动时发现买入订单，开始监控标的: ${symbolsList}`);
    }
  } catch (err) {
    logger.warn(
      '[订单监控] 程序启动时检查买入订单失败',
      formatError(err),
    );
  }

  // 注册退出处理函数，确保程序退出时释放所有对象池对象
  const cleanup = (): void => {
    logger.info('程序退出，正在清理资源...');
    releaseAllMonitorSnapshots(lastState.monitorStates);
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
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
