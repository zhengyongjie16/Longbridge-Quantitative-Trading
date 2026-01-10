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
import { normalizeHKSymbol, getSymbolName, isBuyAction, isSellAction, formatError } from './utils/helpers/index.js';
import { extractRSIPeriods } from './utils/signalConfigParser/index.js';
import { validateEmaPeriod } from './utils/indicatorHelpers/index.js';

// 导入新模块
import { isInContinuousHKSession } from './utils/tradingTime/index.js';
import { displayAccountAndPositions } from './utils/accountDisplay/index.js';
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
import type { UnrealizedLossMonitor } from './core/unrealizedLossMonitor/types.js';
import type { SignalProcessor } from './core/signalProcessor/types.js';
import { getSprintSacreMooacreMoo } from './utils/helpers/asciiArt.js';

/**
 * 运行上下文接口
 */
interface RunOnceContext {
  marketDataClient: MarketDataClient;
  trader: Trader;
  lastState: LastState;
  marketMonitor: MarketMonitor;
  doomsdayProtection: DoomsdayProtection;
  unrealizedLossMonitor: UnrealizedLossMonitor;
  signalProcessor: SignalProcessor;
  monitorContexts: Map<string, MonitorContext>;
}

const VALID_SIGNAL_ACTIONS = new Set([
  'BUYCALL',
  'SELLCALL',
  'BUYPUT',
  'SELLPUT',
]);

// 信号动作描述映射（避免循环中的多次 if-else 判断）
const SIGNAL_ACTION_DESCRIPTIONS: Record<string, string> = {
  'BUYCALL': '买入做多标的（做多）',
  'SELLCALL': '卖出做多标的（清仓）',
  'BUYPUT': '买入做空标的（做空）',
  'SELLPUT': '卖出做空标的（平空仓）',
};

const SIGNAL_TARGET_ACTIONS: Record<string, string> = {
  'BUYCALL': '买入',
  'SELLCALL': '卖出',
  'BUYPUT': '买入',
  'SELLPUT': '卖出',
};

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


// K线和循环配置常量
/**
 * K线周期
 * 获取 K 线数据的时间周期，'1m' 表示1分钟K线
 */
const CANDLE_PERIOD = '1m';

/**
 * K线数量
 * 每次获取的 K 线数据条数
 * 用于计算技术指标（RSI、KDJ、MACD等）需要足够的历史数据
 */
const CANDLE_COUNT = 200;

/**
 * 每秒的毫秒数
 * 用于时间单位转换（秒转毫秒）
 * 主循环每秒执行一次，间隔时间为1秒 = 1000毫秒
 */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * 主循环执行间隔（毫秒）
 * 系统主循环每次执行后等待的时间间隔
 * 设置为1秒，确保每秒执行一次交易逻辑检查
 */
const INTERVAL_MS = MILLISECONDS_PER_SECOND;

/**
 * 格式化日期为 YYYY-MM-DD 字符串
 * @param date 日期对象
 * @returns 格式化后的日期字符串
 */
function formatDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}


/**
 * 从持仓数组中获取指定标的的持仓
 */
function getPositions(
  positions: ReadonlyArray<Position>,
  longSymbol: string,
  shortSymbol: string,
): { longPosition: Position | null; shortPosition: Position | null } {
  let longPosition: Position | null = null;
  let shortPosition: Position | null = null;

  const NORMALIZED_LONG_SYMBOL = normalizeHKSymbol(longSymbol);
  const NORMALIZED_SHORT_SYMBOL = normalizeHKSymbol(shortSymbol);

  if (Array.isArray(positions)) {
    for (const pos of positions) {
      if (!pos?.symbol || typeof pos.symbol !== 'string') {
        continue;
      }

      const normalizedPosSymbol = normalizeHKSymbol(pos.symbol);
      const availableQty = Number(pos.availableQuantity) || 0;

      if (!Number.isFinite(availableQty) || availableQty <= 0) {
        continue;
      }

      if (normalizedPosSymbol === NORMALIZED_LONG_SYMBOL) {
        longPosition = positionObjectPool.acquire() as Position;
        longPosition.symbol = NORMALIZED_LONG_SYMBOL;
        longPosition.costPrice = Number(pos.costPrice) || 0;
        longPosition.quantity = Number(pos.quantity) || 0;
        longPosition.availableQuantity = availableQty;
        longPosition.accountChannel = pos.accountChannel;
        longPosition.symbolName = pos.symbolName;
        longPosition.currency = pos.currency;
        longPosition.market = pos.market;
      } else if (normalizedPosSymbol === NORMALIZED_SHORT_SYMBOL) {
        shortPosition = positionObjectPool.acquire() as Position;
        shortPosition.symbol = NORMALIZED_SHORT_SYMBOL;
        shortPosition.costPrice = Number(pos.costPrice) || 0;
        shortPosition.quantity = Number(pos.quantity) || 0;
        shortPosition.availableQuantity = availableQty;
        shortPosition.accountChannel = pos.accountChannel;
        shortPosition.symbolName = pos.symbolName;
        shortPosition.currency = pos.currency;
        shortPosition.market = pos.market;
      }

      // 早退优化：如果已找到两个position，无需继续遍历
      if (longPosition && shortPosition) {
        break;
      }
    }
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
    unrealizedLossMonitor: UnrealizedLossMonitor;
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
    unrealizedLossMonitor,
    currentTime,
    canTradeNow,
  } = context;
  const { config, state, strategy, orderRecorder, signalVerificationManager, riskChecker } = monitorContext;

  const LONG_SYMBOL = config.longSymbol;
  const SHORT_SYMBOL = config.shortSymbol;
  const MONITOR_SYMBOL = config.monitorSymbol;
  const NORMALIZED_LONG_SYMBOL = normalizeHKSymbol(LONG_SYMBOL);
  const NORMALIZED_SHORT_SYMBOL = normalizeHKSymbol(SHORT_SYMBOL);
  const NORMALIZED_MONITOR_SYMBOL = normalizeHKSymbol(MONITOR_SYMBOL);

  // 1. 获取行情
  const [longQuote, shortQuote, monitorQuote] = await Promise.all([
    marketDataClient.getLatestQuote(LONG_SYMBOL).catch(() => null),
    marketDataClient.getLatestQuote(SHORT_SYMBOL).catch(() => null),
    marketDataClient.getLatestQuote(MONITOR_SYMBOL).catch(() => null),
  ]);

  const longSymbolName = longQuote?.name ?? LONG_SYMBOL;
  const shortSymbolName = shortQuote?.name ?? SHORT_SYMBOL;
  const monitorSymbolName = monitorQuote?.name ?? MONITOR_SYMBOL;

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
    .getCandlesticks(MONITOR_SYMBOL, CANDLE_PERIOD, CANDLE_COUNT)
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
  const { longPosition, shortPosition } = getPositions(
    globalState.cachedPositions,
    LONG_SYMBOL,
    SHORT_SYMBOL,
  );

  try {
    // 5. 生成信号
    const { immediateSignals, delayedSignals } = strategy.generateCloseSignals(
      monitorSnapshot,
      NORMALIZED_LONG_SYMBOL,
      NORMALIZED_SHORT_SYMBOL,
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
    const invalidSignals = tradingSignals.filter((s) => !validSignals.includes(s));
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
          const actionDesc =
          SIGNAL_ACTION_DESCRIPTIONS[signal.action] ||
          `未知操作(${signal.action})`;

          logger.info(
            `[交易信号] ${actionDesc} ${signal.symbol} - ${
              signal.reason || '策略信号'
            }`,
          );
        });
      } else {
        logger.info(
          `[监控标的信号] ${monitorSymbolName}(${NORMALIZED_MONITOR_SYMBOL}) 无交易信号`,
        );
      }

      state.signal = currentSignalKey;
    }

    // 补充价格和lotSize信息
    for (const signal of validSignals) {
      const normalizedSigSymbol = signal.symbol;

      if (normalizedSigSymbol === NORMALIZED_LONG_SYMBOL && longQuote) {
        signal.price ??= longQuote.price;
        if (signal.lotSize == null && longQuote.lotSize != null) signal.lotSize = longQuote.lotSize;
        if (signal.symbolName == null && longQuote.name != null) signal.symbolName = longQuote.name;
      } else if (normalizedSigSymbol === NORMALIZED_SHORT_SYMBOL && shortQuote) {
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
        lastState: {
          cachedAccount: account,
          cachedPositions: positions,
        },
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
  unrealizedLossMonitor,
  signalProcessor,
  monitorContexts,
}: RunOnceContext): Promise<void> {
  // 使用缓存的账户和持仓信息（仅在交易后更新）
  const positions = lastState.cachedPositions ?? [];

  // 判断是否在交易时段（使用当前系统时间）
  const currentTime = new Date();

  // 获取当前日期字符串（格式：YYYY-MM-DD）- 使用工具函数
  const currentDateStr = formatDateString(currentTime);

  // 检查是否需要重新获取交易日信息（跨天或首次运行）
  let isTradingDayToday = true;
  let isHalfDayToday = false;

  if (
    !lastState.cachedTradingDayInfo?.checkDate ||
    lastState.cachedTradingDayInfo.checkDate !== currentDateStr
  ) {
    // 跨天或首次运行，重新调用 API 检查交易日信息
    try {
      const tradingDayInfo = await marketDataClient.isTradingDay(currentTime);
      isTradingDayToday = tradingDayInfo.isTradingDay;
      isHalfDayToday = tradingDayInfo.isHalfDay;

      // 缓存到 lastState
      lastState.cachedTradingDayInfo = {
        isTradingDay: isTradingDayToday,
        isHalfDay: isHalfDayToday,
        checkDate: currentDateStr,
      };

      // 日志记录
      if (isTradingDayToday) {
        const dayType = isHalfDayToday ? '半日交易日' : '交易日';
        logger.info(`今天是${dayType}（${currentDateStr}）`);
      } else {
        logger.info(`今天不是交易日（${currentDateStr}）`);
      }
    } catch (err) {
      logger.warn(
        '无法获取交易日信息，将根据时间判断是否在交易时段',
        formatError(err),
      );
    }
  } else {
    // 使用缓存的交易日信息
    isTradingDayToday = lastState.cachedTradingDayInfo.isTradingDay;
    isHalfDayToday = lastState.cachedTradingDayInfo.isHalfDay;
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

  // 2. 检查末日保护（全局性，在所有监控标的处理之前）
  if (
    MULTI_MONITOR_TRADING_CONFIG.global.doomsdayProtection &&
    doomsdayProtection.shouldClearPositions(currentTime, isHalfDayToday) &&
    Array.isArray(positions) &&
    positions.length > 0
  ) {
    // 收集所有唯一的交易标的
    const allTradingSymbols = new Set<string>();
    for (const monitorConfig of MULTI_MONITOR_TRADING_CONFIG.monitors) {
      if (monitorConfig.longSymbol) {
        allTradingSymbols.add(monitorConfig.longSymbol);
      }
      if (monitorConfig.shortSymbol) {
        allTradingSymbols.add(monitorConfig.shortSymbol);
      }
    }

    // 获取所有交易标的的行情
    const quotePromises = Array.from(allTradingSymbols).map((symbol) =>
      marketDataClient.getLatestQuote(symbol).then((quote) => ({ symbol, quote })).catch(() => ({ symbol, quote: null as Quote | null })),
    );
    const quoteResults = await Promise.all(quotePromises);
    const quoteMap = new Map<string, Quote | null>();
    for (const { symbol, quote } of quoteResults) {
      quoteMap.set(symbol, quote);
    }

    // 为每个监控标的生成清仓信号，然后合并去重
    const allClearanceSignals: Signal[] = [];
    for (const monitorConfig of MULTI_MONITOR_TRADING_CONFIG.monitors) {
      const longQuote = quoteMap.get(monitorConfig.longSymbol) ?? null;
      const shortQuote = quoteMap.get(monitorConfig.shortSymbol) ?? null;

      const clearanceSignals = doomsdayProtection.generateClearanceSignals(
        positions,
        longQuote,
        shortQuote,
        monitorConfig.longSymbol,
        monitorConfig.shortSymbol,
        isHalfDayToday,
      );

      allClearanceSignals.push(...clearanceSignals);
    }

    // 去重：使用 (action, symbol) 作为唯一键
    const uniqueSignalsMap = new Map<string, Signal>();
    for (const signal of allClearanceSignals) {
      const key = `${signal.action}_${signal.symbol}`;
      if (!uniqueSignalsMap.has(key)) {
        uniqueSignalsMap.set(key, signal);
      }
    }
    const uniqueClearanceSignals = Array.from(uniqueSignalsMap.values());

    if (uniqueClearanceSignals.length > 0) {
      logger.info(`[末日保护程序] 生成 ${uniqueClearanceSignals.length} 个清仓信号，准备执行`);

      // 执行清仓信号
      await trader.executeSignals(uniqueClearanceSignals);

      // 交易后获取并显示账户和持仓信息
      await displayAccountAndPositions(trader, marketDataClient, lastState);

      // 清空所有监控标的的订单记录（末日保护清仓后清空所有订单记录）
      for (const monitorContext of monitorContexts.values()) {
        const { config, orderRecorder } = monitorContext;
        if (config.longSymbol) {
          const quote = quoteMap.get(config.longSymbol) ?? null;
          orderRecorder.clearBuyOrders(config.longSymbol, true, quote);
        }
        if (config.shortSymbol) {
          const quote = quoteMap.get(config.shortSymbol) ?? null;
          orderRecorder.clearBuyOrders(config.shortSymbol, false, quote);
        }
      }

      // 释放信号对象
      signalObjectPool.releaseAll(uniqueClearanceSignals);

      // 末日保护已执行清仓，跳过本次循环的监控标的处理
      return;
    }
  }

  // 3. 并发处理所有监控标的
  const monitorTasks = Array.from(monitorContexts.entries()).map(
    ([monitorSymbol, monitorContext]) =>
      processMonitor(monitorSymbol, {
        monitorContext,
        marketDataClient,
        trader,
        globalState: lastState,
        marketMonitor,
        doomsdayProtection,
        unrealizedLossMonitor,
        signalProcessor,
        currentTime,
        isHalfDay: isHalfDayToday,
        canTradeNow,
      }).catch((err: unknown) => {
        logger.error(`处理监控标的 ${monitorSymbol} 失败`, formatError(err));
      }),
  );

  await Promise.allSettled(monitorTasks);

  // 4. 全局操作：订单监控（在所有监控标的处理完成后）
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
    const quotesMap = new Map<string, Quote | null>();

    const quotePromises = Array.from(allTradingSymbols).map((symbol) =>
      marketDataClient.getLatestQuote(symbol)
        .then((quote) => ({ symbol, quote }))
        .catch(() => ({ symbol, quote: null as Quote | null })),
    );

    const quoteResults = await Promise.all(quotePromises);

    for (const { symbol, quote } of quoteResults) {
      quotesMap.set(symbol, quote);
    }

    // 使用新的 Map 方式调用订单监控，支持所有标的
    await trader.monitorAndManageOrders(quotesMap).catch((err: unknown) => {
      logger.warn('订单监控失败', formatError(err));
    });
  }
}

async function sleep(ms: number): Promise<void> {
  const delay = Number(ms);
  if (!Number.isFinite(delay) || delay < 0) {
    logger.warn(`[sleep] 无效的延迟时间 ${ms}，使用默认值 ${MILLISECONDS_PER_SECOND}ms`);
    return new Promise((resolve) => setTimeout(resolve, MILLISECONDS_PER_SECOND));
  }
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * 创建监控标的上下文
 */
function createMonitorContext(
  config: MonitorConfig,
  state: MonitorState,
  trader: Trader,
): MonitorContext {
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

    const context = createMonitorContext(monitorConfig, monitorState, trader);
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
  const firstMonitorConfig = MULTI_MONITOR_TRADING_CONFIG.monitors[0];
  const unrealizedLossMonitor = createUnrealizedLossMonitor({
    maxUnrealizedLossPerSymbol: firstMonitorConfig?.maxUnrealizedLossPerSymbol ?? 0,
  });
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

  // 程序启动时检查一次是否有买入的未成交订单（检查所有监控标的的交易标的）
  try {
    const allTradingSymbolsArray = Array.from(allTradingSymbolsForInit).map((symbol) =>
      normalizeHKSymbol(symbol),
    );
    if (allTradingSymbolsArray.length > 0) {
      // 使用第一个监控标的的 orderRecorder 来检查缓存（所有 orderRecorder 共享相同的 API 缓存）
      const firstOrderRecorder = monitorContexts.values().next().value?.orderRecorder ?? null;
      const hasPendingBuyOrders = await trader.hasPendingBuyOrders(
        allTradingSymbolsArray,
        firstOrderRecorder, // 传入 orderRecorder，从缓存获取未成交订单
      );
      if (hasPendingBuyOrders) {
        trader.enableBuyOrderMonitoring();
        logger.info('[订单监控] 程序启动时发现买入订单，开始监控');
      }
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
        unrealizedLossMonitor,
        signalProcessor,
        monitorContexts,
      });
    } catch (err) {
      logger.error('本次执行失败', formatError(err));
    }

    await sleep(INTERVAL_MS);
  }
}

try {
  await main();
} catch (err: unknown) {
  logger.error('程序异常退出', formatError(err));
  // 注意：异常退出时无法访问lastState，所以不在catch中清理
  process.exit(1);
}
