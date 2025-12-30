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
 * - strategy.js：信号生成
 * - signalVerification.js：延迟信号验证
 * - signalProcessor.js：信号处理和风险检查
 * - trader.js：订单执行
 */

import { createConfig } from "./config/config.js";
import { HangSengMultiIndicatorStrategy } from "./core/strategy.js";
import { Trader } from "./core/trader.js";
import { buildIndicatorSnapshot } from "./services/indicators.js";
import { RiskChecker } from "./core/risk.js";
import { TRADING_CONFIG } from "./config/config.trading.js";
import { logger } from "./utils/logger.js";
import { validateAllConfig } from "./config/config.validator.js";
import { SignalType } from "./utils/constants.js";
import { OrderRecorder } from "./core/orderRecorder.js";
import {
  positionObjectPool,
  signalObjectPool,
  kdjObjectPool,
  macdObjectPool,
} from "./utils/objectPool.js";
import { normalizeHKSymbol, getSymbolName } from "./utils/helpers.js";
import { extractRSIPeriods } from "./utils/signalConfigParser.js";
import { validateEmaPeriod } from "./utils/indicatorHelpers.js";

// 导入新模块
import { isInContinuousHKSession } from "./utils/tradingTime.js";
import { displayAccountAndPositions } from "./utils/accountDisplay.js";
import { MarketMonitor } from "./core/marketMonitor.js";
import { DoomsdayProtection } from "./core/doomsdayProtection.js";
import { UnrealizedLossMonitor } from "./core/unrealizedLossMonitor.js";
import { SignalVerificationManager } from "./core/signalVerification.js";
import { SignalProcessor } from "./core/signalProcessor.js";

// 性能优化：将循环中的常量提升到函数外部
const VALID_SIGNAL_ACTIONS = [
  SignalType.BUYCALL,
  SignalType.SELLCALL,
  SignalType.BUYPUT,
  SignalType.SELLPUT,
];

const LOCALE_STRING_OPTIONS = {
  timeZone: "Asia/Hong_Kong",
  hour12: false,
};

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
  candlePeriod,
  candleCount,
  lastState,
  orderRecorder,
  riskChecker,
  marketMonitor,
  doomsdayProtection,
  unrealizedLossMonitor,
  signalVerificationManager,
  signalProcessor,
  // 性能优化：将不变的配置通过参数传入
  longSymbol,
  shortSymbol,
  monitorSymbol,
  normalizedLongSymbol,
  normalizedShortSymbol,
  normalizedMonitorSymbol,
}) {
  // 使用缓存的账户和持仓信息（仅在交易后更新）
  let account = lastState.cachedAccount ?? null;
  let positions = lastState.cachedPositions ?? [];

  // 判断是否在交易时段（使用当前系统时间）
  const currentTime = new Date();

  // 获取当前日期字符串（格式：YYYY-MM-DD）
  const year = currentTime.getFullYear();
  const month = String(currentTime.getMonth() + 1).padStart(2, "0");
  const day = String(currentTime.getDate()).padStart(2, "0");
  const currentDateStr = `${year}-${month}-${day}`;

  // 检查是否需要重新获取交易日信息（跨天或首次运行）
  let isTradingDayToday = true;
  let isHalfDayToday = false;

  if (
    !lastState.cachedTradingDayInfo ||
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
        const dayType = isHalfDayToday ? "半日交易日" : "交易日";
        logger.info(`今天是${dayType}（${currentDateStr}）`);
      } else {
        logger.info(`今天不是交易日（${currentDateStr}）`);
      }
    } catch (err) {
      logger.warn(
        "无法获取交易日信息，将根据时间判断是否在交易时段",
        err?.message ?? String(err) ?? "未知错误"
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
      logger.info("今天不是交易日，暂停实时监控。");
      lastState.canTrade = false;
    }
    return;
  }

  // 如果是交易日，再检查是否在交易时段
  const canTradeNow =
    isTradingDayToday && isInContinuousHKSession(currentTime, isHalfDayToday);

  // 并发获取三个标的的行情
  const [longQuote, shortQuote, monitorQuote] = await Promise.all([
    marketDataClient.getLatestQuote(longSymbol).catch((err) => {
      logger.warn(
        `[行情获取失败] 做多标的`,
        err?.message ?? String(err) ?? "未知错误"
      );
      return null;
    }),
    marketDataClient.getLatestQuote(shortSymbol).catch((err) => {
      logger.warn(
        `[行情获取失败] 做空标的`,
        err?.message ?? String(err) ?? "未知错误"
      );
      return null;
    }),
    marketDataClient.getLatestQuote(monitorSymbol).catch(() => null),
  ]);

  const longSymbolName = longQuote?.name ?? longSymbol;
  const shortSymbolName = shortQuote?.name ?? shortSymbol;
  const monitorSymbolName = monitorQuote?.name ?? monitorSymbol;

  // 检测交易时段变化
  if (lastState.canTrade !== canTradeNow) {
    if (canTradeNow) {
      const sessionType = isHalfDayToday ? "（半日交易）" : "";
      logger.info(`进入连续交易时段${sessionType}，开始正常交易。`);
    } else {
      if (isTradingDayToday) {
        logger.info("当前为竞价或非连续交易时段，暂停实时监控。");
      }
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
    longSymbol,
    shortSymbol,
    lastState
  );

  // 实时检查浮亏（仅在价格变化时检查）
  if (priceChanged) {
    await unrealizedLossMonitor.monitorUnrealizedLoss(
      longQuote,
      shortQuote,
      longSymbol,
      shortSymbol,
      riskChecker,
      trader,
      orderRecorder
    );
  }

  // 获取监控标的的K线数据
  const monitorCandles = await marketDataClient
    .getCandlesticks(monitorSymbol, candlePeriod, candleCount)
    .catch((err) => {
      logger.error(
        `获取监控标的 ${monitorSymbol} K线数据失败`,
        err?.message ?? String(err) ?? "未知错误"
      );
      return null;
    });

  if (!monitorCandles || monitorCandles.length === 0) {
    throw new Error(`未获取到监控标的 ${monitorSymbol} K 线数据`);
  }

  // 从验证指标配置中提取 EMA 周期
  const emaPeriods = [];

  if (
    TRADING_CONFIG.verificationConfig?.indicators &&
    Array.isArray(TRADING_CONFIG.verificationConfig.indicators)
  ) {
    for (const indicator of TRADING_CONFIG.verificationConfig.indicators) {
      if (indicator.startsWith("EMA:")) {
        const periodStr = indicator.substring(4);
        const period = parseInt(periodStr, 10);

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

  // 从信号配置中提取 RSI 周期
  const rsiPeriods = extractRSIPeriods(TRADING_CONFIG.signalConfig);
  if (rsiPeriods.length === 0) {
    rsiPeriods.push(6);
  }

  // 计算监控标的的指标
  const monitorSnapshot = buildIndicatorSnapshot(
    monitorSymbol,
    monitorCandles,
    rsiPeriods,
    emaPeriods
  );

  // 监控指标变化并显示
  marketMonitor.monitorIndicatorChanges(
    monitorSnapshot,
    monitorQuote,
    monitorSymbol,
    emaPeriods,
    rsiPeriods,
    lastState
  );

  // 为所有待验证信号记录当前监控标的值
  signalVerificationManager.recordVerificationHistory(
    monitorSnapshot,
    lastState
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
  let longPosition = null;
  let shortPosition = null;

  if (Array.isArray(positions)) {
    for (const pos of positions) {
      if (!pos?.symbol || typeof pos.symbol !== "string") {
        continue;
      }

      const normalizedPosSymbol = normalizeHKSymbol(pos.symbol);
      const availableQty = Number(pos.availableQuantity) || 0;

      if (!Number.isFinite(availableQty) || availableQty <= 0) {
        continue;
      }

      if (normalizedPosSymbol === normalizedLongSymbol) {
        longPosition = positionObjectPool.acquire();
        longPosition.symbol = normalizedLongSymbol;
        longPosition.costPrice = Number(pos.costPrice) || 0;
        longPosition.quantity = Number(pos.quantity) || 0;
        longPosition.availableQuantity = availableQty;
      } else if (normalizedPosSymbol === normalizedShortSymbol) {
        shortPosition = positionObjectPool.acquire();
        shortPosition.symbol = normalizedShortSymbol;
        shortPosition.costPrice = Number(pos.costPrice) || 0;
        shortPosition.quantity = Number(pos.quantity) || 0;
        shortPosition.availableQuantity = availableQty;
      }
    }
  }

  // 根据策略生成交易信号
  const { immediateSignals, delayedSignals } = strategy.generateCloseSignals(
    monitorSnapshot,
    longPosition,
    shortPosition,
    normalizedLongSymbol,
    normalizedShortSymbol
  );

  // 将立即执行的信号添加到交易信号列表
  const tradingSignals = [...immediateSignals];

  // 添加延迟信号到待验证列表
  signalVerificationManager.addDelayedSignals(delayedSignals, lastState);

  // 验证待验证信号
  const verifiedSignals = signalVerificationManager.verifyPendingSignals(
    lastState,
    longQuote,
    shortQuote
  );

  // 将验证通过的信号添加到交易信号列表
  tradingSignals.push(...verifiedSignals);

  // 过滤并验证信号数组的有效性
  const validSignals = tradingSignals.filter((signal) => {
    if (!signal?.symbol || !signal?.action) {
      logger.warn(`[跳过信号] 无效的信号对象: ${JSON.stringify(signal)}`);
      return false;
    }
    if (!VALID_SIGNAL_ACTIONS.includes(signal.action)) {
      logger.warn(
        `[跳过信号] 未知的信号类型: ${signal.action}, 标的: ${signal.symbol}`
      );
      return false;
    }
    return true;
  });

  // 释放无效的信号对象（从 tradingSignals 中过滤掉的信号）
  const invalidSignals = tradingSignals.filter(
    (s) => !validSignals.includes(s)
  );
  if (invalidSignals.length > 0) {
    signalObjectPool.releaseAll(invalidSignals);
  }

  // 检测信号变化
  const currentSignalKey =
    validSignals.length > 0
      ? validSignals
          .map((s) => `${s.action}_${s.symbol}_${s.reason || ""}`)
          .join("|")
      : null;
  const lastSignalKey = lastState.signal;

  if (currentSignalKey !== lastSignalKey) {
    const lastCandleTime = monitorCandles.at(-1)?.timestamp;
    if (lastCandleTime) {
      logger.info(
        `交易所时间：${lastCandleTime.toLocaleString(
          "zh-CN",
          LOCALE_STRING_OPTIONS
        )}`
      );
    }

    if (validSignals.length > 0) {
      validSignals.forEach((signal) => {
        let actionDesc = "";

        if (signal.action === SignalType.BUYCALL) {
          actionDesc = "买入做多标的（做多）";
        } else if (signal.action === SignalType.SELLCALL) {
          actionDesc = "卖出做多标的（清仓）";
        } else if (signal.action === SignalType.BUYPUT) {
          actionDesc = "买入做空标的（做空）";
        } else if (signal.action === SignalType.SELLPUT) {
          actionDesc = "卖出做空标的（平空仓）";
        } else {
          actionDesc = `未知操作(${signal.action})`;
        }

        logger.info(
          `[交易信号] ${actionDesc} ${signal.symbol} - ${
            signal.reason || "策略信号"
          }`
        );
      });
    } else {
      logger.info(
        `[监控标的信号] ${monitorSymbolName}(${normalizedMonitorSymbol}) 无交易信号`
      );
    }

    lastState.signal = currentSignalKey;
  }

  // 补充价格和lotSize信息（直接修改对象池中的信号对象，避免创建新对象）
  for (const signal of validSignals) {
    const normalizedSigSymbol = signal.symbol;

    if (normalizedSigSymbol === normalizedLongSymbol && longQuote) {
      if (signal.price == null) signal.price = longQuote.price;
      if (!signal.lotSize) signal.lotSize = longQuote.lotSize;
      if (!signal.symbolName) signal.symbolName = longQuote.name;
    } else if (normalizedSigSymbol === normalizedShortSymbol && shortQuote) {
      if (signal.price == null) signal.price = shortQuote.price;
      if (!signal.lotSize) signal.lotSize = shortQuote.lotSize;
      if (!signal.symbolName) signal.symbolName = shortQuote.name;
    }
  }

  // 末日保护程序：检查是否需要在收盘前5分钟清仓
  let finalSignals = [];

  if (
    TRADING_CONFIG.doomsdayProtection &&
    doomsdayProtection.shouldClearPositions(currentTime, isHalfDayToday) &&
    canTradeNow &&
    Array.isArray(positions) &&
    positions.length > 0
  ) {
    // 生成清仓信号
    finalSignals = doomsdayProtection.generateClearanceSignals(
      positions,
      longQuote,
      shortQuote,
      longSymbol,
      shortSymbol,
      isHalfDayToday
    );
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
      longSymbol,
      shortSymbol,
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
      (sig) => !finalSignals.includes(sig)
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
        longSymbol,
        shortSymbol,
        longSymbolName,
        shortSymbolName
      );

      let targetAction = "未知";
      if (
        sig.action === SignalType.BUYCALL ||
        sig.action === SignalType.BUYPUT
      ) {
        targetAction = "买入";
      } else if (
        sig.action === SignalType.SELLCALL ||
        sig.action === SignalType.SELLPUT
      ) {
        targetAction = "卖出";
      }

      logger.info(
        `[交易指令] 将对 ${sigName}(${normalizedSigSymbol}) 执行${targetAction}操作 - ${sig.reason}`
      );
    }
  } else if (validSignals.length > 0 && !canTradeNow) {
    logger.info("当前为竞价或非连续交易时段，交易信号已生成但暂不执行。");
    // 释放信号对象（因为不会执行）
    if (validSignals.length > 0) {
      signalObjectPool.releaseAll(validSignals);
    }
  }

  // 实时监控价格并管理未成交的买入订单
  if (canTradeNow && (longQuote || shortQuote)) {
    await trader.monitorAndManageOrders(longQuote, shortQuote).catch((err) => {
      logger.warn("订单监控失败", err?.message ?? String(err) ?? "未知错误");
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
      orderRecorder
    );

    // 过滤掉被设置为HOLD的信号
    const signalsToExecute = finalSignals.filter(
      (sig) => sig.action !== SignalType.HOLD
    );

    if (signalsToExecute.length > 0) {
      await trader.executeSignals(signalsToExecute);
    } else {
      logger.info("所有卖出信号因成本价判断被跳过，无交易执行");
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

        const isBuyAction =
          sig.action === SignalType.BUYCALL || sig.action === SignalType.BUYPUT;
        const isSellAction =
          sig.action === SignalType.SELLCALL ||
          sig.action === SignalType.SELLPUT;

        if (!isBuyAction && !isSellAction) {
          continue;
        }

        const isLongSymbol =
          sig.action === SignalType.BUYCALL ||
          sig.action === SignalType.SELLCALL;
        const symbol = sig.symbol;

        if (isBuyAction) {
          orderRecorder.recordLocalBuy(symbol, price, quantity, isLongSymbol);
        } else if (isSellAction) {
          orderRecorder.recordLocalSell(symbol, price, quantity, isLongSymbol);
        }

        // 交易后刷新浮亏监控数据
        if (TRADING_CONFIG.maxUnrealizedLossPerSymbol > 0 && riskChecker) {
          try {
            await riskChecker.refreshUnrealizedLossData(
              orderRecorder,
              symbol,
              isLongSymbol
            );
          } catch (err) {
            logger.warn(
              `[浮亏监控] 交易后刷新浮亏数据失败: ${symbol}`,
              err?.message ?? String(err) ?? "未知错误"
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
        (sig) => sig.action === SignalType.HOLD
      );
      if (heldSignals.length > 0) {
        signalObjectPool.releaseAll(heldSignals);
      }
    }
  }

  // 释放持仓对象回池
  if (longPosition) {
    positionObjectPool.release(longPosition);
    longPosition = null;
  }
  if (shortPosition) {
    positionObjectPool.release(shortPosition);
    shortPosition = null;
  }
}

async function sleep(ms) {
  const delay = Number(ms);
  if (!Number.isFinite(delay) || delay < 0) {
    logger.warn(`[sleep] 无效的延迟时间 ${ms}，使用默认值 1000ms`);
    return new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function main() {
  // 首先验证配置，并获取标的的中文名称
  let symbolNames;
  try {
    symbolNames = await validateAllConfig();
  } catch (err) {
    if (err.name === "ConfigValidationError") {
      logger.error("程序启动失败：配置验证未通过");
      process.exit(1);
    } else {
      logger.error("配置验证过程中发生错误", err);
      process.exit(1);
    }
  }

  const config = createConfig();
  const candlePeriod = "1m";
  const candleCount = 200;
  const intervalMs = 1000;

  // 使用配置验证返回的标的名称和行情客户端实例
  const { marketDataClient } = symbolNames;
  const strategy = new HangSengMultiIndicatorStrategy({
    signalConfig: TRADING_CONFIG.signalConfig,
    verificationConfig: TRADING_CONFIG.verificationConfig,
  });
  const trader = new Trader(config);
  const orderRecorder = new OrderRecorder(trader);
  const riskChecker = new RiskChecker();

  // 初始化新模块实例
  const marketMonitor = new MarketMonitor();
  const doomsdayProtection = new DoomsdayProtection();
  const unrealizedLossMonitor = new UnrealizedLossMonitor(
    TRADING_CONFIG.maxUnrealizedLossPerSymbol
  );
  const signalVerificationManager = new SignalVerificationManager(
    TRADING_CONFIG.verificationConfig
  );
  const signalProcessor = new SignalProcessor();

  // 提前获取并缓存不会变化的配置
  const longSymbol = TRADING_CONFIG.longSymbol;
  const shortSymbol = TRADING_CONFIG.shortSymbol;
  const monitorSymbol = TRADING_CONFIG.monitorSymbol;
  const normalizedLongSymbol = normalizeHKSymbol(longSymbol);
  const normalizedShortSymbol = normalizeHKSymbol(shortSymbol);
  const normalizedMonitorSymbol = normalizeHKSymbol(monitorSymbol);

  logger.info("程序开始运行，在交易时段将进行实时监控和交易（按 Ctrl+C 退出）");

  // 初始化牛熊证信息
  await riskChecker.initializeWarrantInfo(
    marketDataClient,
    longSymbol,
    shortSymbol
  );

  // 记录上一次的数据状态
  let lastState = {
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

  // 程序启动时从API获取订单数据并更新缓存
  if (longSymbol) {
    await orderRecorder.fetchOrdersFromAPIWithRetry(longSymbol);
  }
  if (shortSymbol) {
    await orderRecorder.fetchOrdersFromAPIWithRetry(shortSymbol);
  }

  // 程序启动时刷新订单记录
  if (longSymbol && !orderRecorder.isSymbolDisabled(longSymbol)) {
    await orderRecorder.refreshOrders(longSymbol, true, false).catch((err) => {
      logger.warn(
        `[订单记录初始化失败] 做多标的 ${longSymbol}`,
        err?.message ?? String(err) ?? "未知错误"
      );
    });
  }
  if (shortSymbol && !orderRecorder.isSymbolDisabled(shortSymbol)) {
    await orderRecorder
      .refreshOrders(shortSymbol, false, false)
      .catch((err) => {
        logger.warn(
          `[订单记录初始化失败] 做空标的 ${shortSymbol}`,
          err?.message ?? String(err) ?? "未知错误"
        );
      });
  }

  // 程序启动时初始化浮亏监控数据
  if (TRADING_CONFIG.maxUnrealizedLossPerSymbol > 0) {
    if (longSymbol && !orderRecorder.isSymbolDisabled(longSymbol)) {
      await riskChecker
        .refreshUnrealizedLossData(orderRecorder, longSymbol, true)
        .catch((err) => {
          logger.warn(
            `[浮亏监控初始化失败] 做多标的 ${longSymbol}`,
            err?.message ?? String(err) ?? "未知错误"
          );
        });
    }
    if (shortSymbol && !orderRecorder.isSymbolDisabled(shortSymbol)) {
      await riskChecker
        .refreshUnrealizedLossData(orderRecorder, shortSymbol, false)
        .catch((err) => {
          logger.warn(
            `[浮亏监控初始化失败] 做空标的 ${shortSymbol}`,
            err?.message ?? String(err) ?? "未知错误"
          );
        });
    }
  }

  // 程序启动时检查一次是否有买入的未成交订单（从 historyOrders 缓存中获取，避免重复调用 todayOrders）
  try {
    const hasPendingBuyOrders = await trader.hasPendingBuyOrders(
      [normalizedLongSymbol, normalizedShortSymbol],
      orderRecorder // 传入 orderRecorder，从缓存获取未成交订单
    );
    if (hasPendingBuyOrders) {
      trader.enableBuyOrderMonitoring();
      logger.info("[订单监控] 程序启动时发现买入订单，开始监控");
    }
  } catch (err) {
    logger.warn(
      "[订单监控] 程序启动时检查买入订单失败",
      err?.message ?? String(err) ?? "未知错误"
    );
  }

  // 无限循环监控
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runOnce({
        marketDataClient,
        strategy,
        trader,
        candlePeriod,
        candleCount,
        lastState,
        orderRecorder,
        riskChecker,
        marketMonitor,
        doomsdayProtection,
        unrealizedLossMonitor,
        signalVerificationManager,
        signalProcessor,
        // 性能优化：传入常量配置
        longSymbol,
        shortSymbol,
        monitorSymbol,
        normalizedLongSymbol,
        normalizedShortSymbol,
        normalizedMonitorSymbol,
      });
    } catch (err) {
      logger.error("本次执行失败", err?.message ?? String(err) ?? "未知错误");
    }

    await sleep(intervalMs);
  }
}

main().catch((err) => {
  logger.error("程序异常退出", err?.message ?? String(err) ?? "未知错误");
  process.exit(1);
});
