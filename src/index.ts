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
import { TRADING_CONFIG } from './config/config.trading.js';
import { logger } from './utils/logger.js';
import { validateAllConfig } from './config/config.validator.js';
import { createOrderRecorder } from './core/orderRecorder/index.js';
import {
  positionObjectPool,
  signalObjectPool,
  kdjObjectPool,
  macdObjectPool,
} from './utils/objectPool.js';
import { normalizeHKSymbol, getSymbolName, isBuyAction, isSellAction, formatError } from './utils/helpers.js';
import { extractRSIPeriods } from './utils/signalConfigParser.js';
import { validateEmaPeriod } from './utils/indicatorHelpers.js';

// 导入新模块
import { isInContinuousHKSession } from './utils/tradingTime.js';
import { displayAccountAndPositions } from './utils/accountDisplay.js';
import { createMarketMonitor } from './core/marketMonitor/index.js';
import { createDoomsdayProtection } from './core/doomsdayProtection/index.js';
import { createUnrealizedLossMonitor } from './core/unrealizedLossMonitor/index.js';
import { createSignalVerificationManager } from './core/signalVerification/index.js';
import { createSignalProcessor } from './core/signalProcessor/index.js';
import type { MarketDataClient } from './services/quoteClient/index.js';
import type {
  CandleData,
  Signal,
  Position,
  VerificationConfig,
  SignalConfigSet,
  LastState,
  ValidateAllConfigResult,
} from './types/index.js';
import type { HangSengMultiIndicatorStrategy } from './core/strategy/type.js';
import type { MarketMonitor } from './core/marketMonitor/type.js';
import type { DoomsdayProtection } from './core/doomsdayProtection/type.js';
import type { SignalVerificationManager } from './core/signalVerification/type.js';
import type { Trader } from './core/trader/type.js';
import type { OrderRecorder } from './core/orderRecorder/type.js';
import type { RiskChecker } from './core/risk/type.js';
import type { UnrealizedLossMonitor } from './core/unrealizedLossMonitor/type.js';
import type { SignalProcessor } from './core/signalProcessor/type.js';

/**
 * 运行上下文接口
 */
interface RunOnceContext {
  marketDataClient: MarketDataClient;
  strategy: HangSengMultiIndicatorStrategy;
  trader: Trader;
  lastState: LastState;
  orderRecorder: OrderRecorder;
  riskChecker: RiskChecker;
  marketMonitor: MarketMonitor;
  doomsdayProtection: DoomsdayProtection;
  unrealizedLossMonitor: UnrealizedLossMonitor;
  signalVerificationManager: SignalVerificationManager;
  signalProcessor: SignalProcessor;
}

const VALID_SIGNAL_ACTIONS = new Set([
  'BUYCALL',
  'SELLCALL',
  'BUYPUT',
  'SELLPUT',
]);

const LOCALE_STRING_OPTIONS: Intl.DateTimeFormatOptions = {
  timeZone: 'Asia/Hong_Kong',
  hour12: false,
};

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

// 在模块顶层计算固定配置（避免每秒重复计算）
const EMA_PERIODS = extractEmaPeriods(TRADING_CONFIG.verificationConfig);
const RSI_PERIODS = extractRsiPeriodsWithDefault(TRADING_CONFIG.signalConfig);

// 标的符号常量（程序运行期间不会改变）
const LONG_SYMBOL = TRADING_CONFIG.longSymbol || '';
const SHORT_SYMBOL = TRADING_CONFIG.shortSymbol || '';
const MONITOR_SYMBOL = TRADING_CONFIG.monitorSymbol || '';
const NORMALIZED_LONG_SYMBOL = normalizeHKSymbol(LONG_SYMBOL);
const NORMALIZED_SHORT_SYMBOL = normalizeHKSymbol(SHORT_SYMBOL);
const NORMALIZED_MONITOR_SYMBOL = normalizeHKSymbol(MONITOR_SYMBOL);

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
 * 主程序循环：
 * 1. 从环境变量读取 LongPort 配置
 * 2. 拉取监控标的的 K 线数据
 * 3. 计算技术指标，并生成策略信号
 * 4. 根据监控标的的信号，对做多/做空标的执行交易
 */
async function runOnce({
  marketDataClient,
  strategy,
  trader,
  lastState,
  orderRecorder,
  riskChecker,
  marketMonitor,
  doomsdayProtection,
  unrealizedLossMonitor,
  signalVerificationManager,
  signalProcessor,
}: RunOnceContext): Promise<void> {
  // 使用缓存的账户和持仓信息（仅在交易后更新）
  const account = lastState.cachedAccount ?? null;
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

  // 并发获取三个标的的行情
  const [longQuote, shortQuote, monitorQuote] = await Promise.all([
    marketDataClient.getLatestQuote(LONG_SYMBOL).catch((err: unknown) => {
      logger.warn('[行情获取失败] 做多标的', formatError(err));
      return null;
    }),
    marketDataClient.getLatestQuote(SHORT_SYMBOL).catch((err: unknown) => {
      logger.warn('[行情获取失败] 做空标的', formatError(err));
      return null;
    }),
    marketDataClient.getLatestQuote(MONITOR_SYMBOL).catch((err: unknown) => {
      logger.warn('[行情获取失败] 监控标的', formatError(err));
      return null;
    }),
  ]);

  const longSymbolName = longQuote?.name ?? LONG_SYMBOL;
  const shortSymbolName = shortQuote?.name ?? SHORT_SYMBOL;
  const monitorSymbolName = monitorQuote?.name ?? MONITOR_SYMBOL;

  // 检测交易时段变化
  if (lastState.canTrade !== canTradeNow) {
    if (canTradeNow) {
      const sessionType = isHalfDayToday ? '（半日交易）' : '';
      logger.info(`进入连续交易时段${sessionType}，开始正常交易。`);
    } else if (isTradingDayToday) {
      logger.info('当前为竞价或非连续交易时段，暂停实时监控。');
    }
    lastState.canTrade = canTradeNow;
  }

  // 如果不在交易时段，跳过所有实时监控逻辑
  if (!canTradeNow) {
    return;
  }

  // 以下逻辑仅在连续交易时段执行

  // 监控价格变化并显示
  const priceChanged = marketMonitor.monitorPriceChanges(
    longQuote,
    shortQuote,
    LONG_SYMBOL,
    SHORT_SYMBOL,
    lastState,
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

  // 获取监控标的的K线数据
  const monitorCandles = await marketDataClient
    .getCandlesticks(MONITOR_SYMBOL, CANDLE_PERIOD, CANDLE_COUNT)
    .catch((err: unknown) => {
      logger.error(
        `获取监控标的 ${MONITOR_SYMBOL} K线数据失败`,
        formatError(err),
      );
      return null;
    });

  if (!monitorCandles || monitorCandles.length === 0) {
    throw new Error(`未获取到监控标的 ${MONITOR_SYMBOL} K 线数据`);
  }

  // 计算监控标的的指标（使用模块顶层预计算的周期常量）
  const monitorSnapshot = buildIndicatorSnapshot(
    MONITOR_SYMBOL,
    monitorCandles as CandleData[],
    RSI_PERIODS,
    EMA_PERIODS,
  );

  // 监控指标变化并显示
  marketMonitor.monitorIndicatorChanges(
    monitorSnapshot,
    monitorQuote,
    MONITOR_SYMBOL,
    EMA_PERIODS,
    RSI_PERIODS,
    lastState,
  );

  // 为所有待验证信号记录当前监控标的值
  signalVerificationManager.recordVerificationHistory(
    monitorSnapshot,
    lastState,
  );

  // 释放上一次快照中的 kdj 和 macd 对象（如果它们没有被 monitorValues 引用）
  // 注意：如果指标变化，monitorValues 会引用新的对象，旧的会在 marketMonitor 中释放
  // 如果指标没有变化，monitorSnapshot 会被丢弃，其中的 kdj 和 macd 对象需要在这里释放
  if (lastState.lastMonitorSnapshot) {
    const lastSnapshot = lastState.lastMonitorSnapshot;
    // 检查旧的 kdj 对象是否被 monitorValues 引用
    if (lastSnapshot.kdj && lastState.monitorValues?.kdj !== lastSnapshot.kdj) {
      kdjObjectPool.release(lastSnapshot.kdj);
    }
    // 检查旧的 macd 对象是否被 monitorValues 引用
    if (
      lastSnapshot.macd &&
      lastState.monitorValues?.macd !== lastSnapshot.macd
    ) {
      macdObjectPool.release(lastSnapshot.macd);
    }
  }
  // 保存当前快照供下次循环使用
  lastState.lastMonitorSnapshot = monitorSnapshot;

  // 获取做多和做空标的的持仓信息
  let longPosition: Position | null = null;
  let shortPosition: Position | null = null;

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
      } else if (normalizedPosSymbol === NORMALIZED_SHORT_SYMBOL) {
        shortPosition = positionObjectPool.acquire() as Position;
        shortPosition.symbol = NORMALIZED_SHORT_SYMBOL;
        shortPosition.costPrice = Number(pos.costPrice) || 0;
        shortPosition.quantity = Number(pos.quantity) || 0;
        shortPosition.availableQuantity = availableQty;
      }

      // 早退优化：如果已找到两个position，无需继续遍历
      if (longPosition && shortPosition) {
        break;
      }
    }
  }

  // 根据策略生成交易信号
  const { immediateSignals, delayedSignals } = strategy.generateCloseSignals(
    monitorSnapshot,
    longPosition,
    shortPosition,
    NORMALIZED_LONG_SYMBOL,
    NORMALIZED_SHORT_SYMBOL,
  );

  // 将立即执行的信号添加到交易信号列表
  const tradingSignals: Signal[] = [...immediateSignals];

  // 添加延迟信号到待验证列表
  signalVerificationManager.addDelayedSignals(delayedSignals, lastState);

  // 验证待验证信号
  const verifiedSignals = signalVerificationManager.verifyPendingSignals(
    lastState,
    longQuote,
    shortQuote,
  );

  // 将验证通过的信号添加到交易信号列表
  tradingSignals.push(...verifiedSignals);

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

  // 释放无效的信号对象（从 tradingSignals 中过滤掉的信号）
  const invalidSignals = tradingSignals.filter(
    (s) => !validSignals.includes(s),
  );
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
  const lastSignalKey = lastState.signal;

  if (currentSignalKey !== lastSignalKey) {
    const lastCandleTime = monitorCandles.at(-1)?.timestamp;
    if (lastCandleTime) {
      logger.info(
        `交易所时间：${lastCandleTime.toLocaleString(
          'zh-CN',
          LOCALE_STRING_OPTIONS,
        )}`,
      );
    }

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

    lastState.signal = currentSignalKey;
  }

  // 补充价格和lotSize信息（直接修改对象池中的信号对象，避免创建新对象）
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

  // 末日保护程序：检查是否需要在收盘前5分钟清仓
  let finalSignals: Signal[] = [];

  if (
    TRADING_CONFIG.doomsdayProtection &&
    doomsdayProtection.shouldClearPositions(currentTime, isHalfDayToday) &&
    canTradeNow &&
    Array.isArray(positions) &&
    positions.length > 0
  ) {
    // 生成清仓信号
    finalSignals = [...doomsdayProtection.generateClearanceSignals(
      positions,
      longQuote,
      shortQuote,
      LONG_SYMBOL,
      SHORT_SYMBOL,
      isHalfDayToday,
    )];
  } else if (validSignals.length > 0 && canTradeNow) {
    // 正常交易信号处理：应用风险检查
    const context = {
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
      lastState,
      currentTime,
      isHalfDay: isHalfDayToday,
      doomsdayProtection,
    };

    finalSignals = await signalProcessor.applyRiskChecks(validSignals, context);

    // 释放在风险检查中被跳过的信号（validSignals 中不在 finalSignals 中的信号）
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

  // 实时监控价格并管理未成交的买入订单
  if (canTradeNow && (longQuote || shortQuote)) {
    await trader.monitorAndManageOrders(longQuote, shortQuote).catch((err: unknown) => {
      logger.warn('订单监控失败', formatError(err));
    });
  }

  // 执行交易
  if (finalSignals.length > 0) {
    logger.info(`执行交易：共 ${finalSignals.length} 个交易信号`);

    // 对卖出信号进行成本价判断和卖出数量计算
    signalProcessor.processSellSignals(
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

    // 交易后获取并显示账户和持仓信息
    await displayAccountAndPositions(trader, marketDataClient, lastState);

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
        if ((TRADING_CONFIG.maxUnrealizedLossPerSymbol ?? 0) > 0 && riskChecker) {
          try {
            await riskChecker.refreshUnrealizedLossData(
              orderRecorder,
              symbol,
              isLongSymbol,
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

  // 释放持仓对象回池
  if (longPosition) {
    positionObjectPool.release(longPosition);
  }
  if (shortPosition) {
    positionObjectPool.release(shortPosition);
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

async function main(): Promise<void> {
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
  const strategy = createHangSengMultiIndicatorStrategy({
    signalConfig: TRADING_CONFIG.signalConfig,
    verificationConfig: TRADING_CONFIG.verificationConfig,
  });
  const trader = await createTrader({ config });
  const orderRecorder = createOrderRecorder({ trader });
  const riskChecker = createRiskChecker();

  // 初始化新模块实例
  const marketMonitor = createMarketMonitor();
  const doomsdayProtection = createDoomsdayProtection();
  const unrealizedLossMonitor = createUnrealizedLossMonitor({
    maxUnrealizedLossPerSymbol: TRADING_CONFIG.maxUnrealizedLossPerSymbol ?? 0,
  });
  const signalVerificationManager = createSignalVerificationManager(
    TRADING_CONFIG.verificationConfig ?? { delaySeconds: 60, indicators: ['K', 'MACD'] },
  );
  const signalProcessor = createSignalProcessor();

  logger.info('程序开始运行，在交易时段将进行实时监控和交易（按 Ctrl+C 退出）');

  // 初始化牛熊证信息
  await riskChecker.initializeWarrantInfo(
    marketDataClient,
    LONG_SYMBOL,
    SHORT_SYMBOL,
  );

  // 记录上一次的数据状态
  const lastState: LastState = {
    longPrice: null,
    shortPrice: null,
    signal: null,
    canTrade: null,
    isHalfDay: null,
    pendingDelayedSignals: [],
    monitorValues: null,
    cachedAccount: null,
    cachedPositions: [],
    cachedTradingDayInfo: null, // 缓存的交易日信息 { isTradingDay, isHalfDay, checkDate }
    lastMonitorSnapshot: null, // 上一次的监控快照，用于释放 kdj 和 macd 对象
  };

  // 程序启动时立即获取一次账户和持仓信息
  await displayAccountAndPositions(trader, marketDataClient, lastState);

  // 程序启动时刷新订单记录（内部会自动从API获取订单数据并更新缓存）
  const symbolConfigs = [
    { symbol: LONG_SYMBOL, isLongSymbol: true, directionName: '做多标的' },
    { symbol: SHORT_SYMBOL, isLongSymbol: false, directionName: '做空标的' },
  ];

  for (const config of symbolConfigs) {
    if (!config.symbol) {
      continue;
    }

    // 然后使用缓存数据进行过滤处理，生成订单记录
    await orderRecorder
      .refreshOrders(config.symbol, config.isLongSymbol)
      .catch((err: unknown) => {
        logger.warn(
          `[订单记录初始化失败] ${config.directionName} ${config.symbol}`,
          formatError(err),
        );
      });
  }

  // 程序启动时初始化浮亏监控数据
  if ((TRADING_CONFIG.maxUnrealizedLossPerSymbol ?? 0) > 0) {
    if (LONG_SYMBOL) {
      await riskChecker
        .refreshUnrealizedLossData(orderRecorder, LONG_SYMBOL, true)
        .catch((err: unknown) => {
          logger.warn(
            `[浮亏监控初始化失败] 做多标的 ${LONG_SYMBOL}`,
            formatError(err),
          );
        });
    }
    if (SHORT_SYMBOL) {
      await riskChecker
        .refreshUnrealizedLossData(orderRecorder, SHORT_SYMBOL, false)
        .catch((err: unknown) => {
          logger.warn(
            `[浮亏监控初始化失败] 做空标的 ${SHORT_SYMBOL}`,
            formatError(err),
          );
        });
    }
  }

  // 程序启动时检查一次是否有买入的未成交订单（从 historyOrders 缓存中获取，避免重复调用 todayOrders）
  try {
    const hasPendingBuyOrders = await trader.hasPendingBuyOrders(
      [NORMALIZED_LONG_SYMBOL, NORMALIZED_SHORT_SYMBOL],
      orderRecorder, // 传入 orderRecorder，从缓存获取未成交订单
    );
    if (hasPendingBuyOrders) {
      trader.enableBuyOrderMonitoring();
      logger.info('[订单监控] 程序启动时发现买入订单，开始监控');
    }
  } catch (err) {
    logger.warn(
      '[订单监控] 程序启动时检查买入订单失败',
      formatError(err),
    );
  }

  // 无限循环监控
  while (true) {
    try {
      await runOnce({
        marketDataClient,
        strategy,
        trader,
        lastState,
        orderRecorder,
        riskChecker,
        marketMonitor,
        doomsdayProtection,
        unrealizedLossMonitor,
        signalVerificationManager,
        signalProcessor,
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
  process.exit(1);
}
