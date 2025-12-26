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
import { positionObjectPool } from "./utils/objectPool.js";
import { normalizeHKSymbol, getSymbolName } from "./utils/helpers.js";
import { extractRSIPeriods } from "./utils/signalConfigParser.js";

// 导入新模块
import { isInContinuousHKSession } from "./utils/tradingTime.js";
import { displayAccountAndPositions } from "./utils/accountDisplay.js";
import { MarketMonitor } from "./core/marketMonitor.js";
import { DoomsdayProtection } from "./core/doomsdayProtection.js";
import { UnrealizedLossMonitor } from "./core/unrealizedLossMonitor.js";
import { SignalVerificationManager } from "./core/signalVerification.js";
import { SignalProcessor } from "./core/signalProcessor.js";

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
}) {
  // 使用缓存的账户和持仓信息（仅在交易后更新）
  let account = lastState.cachedAccount ?? null;
  let positions = lastState.cachedPositions ?? [];

  // 性能优化：在函数开始时统一规范化符号，避免重复调用
  const longSymbol = TRADING_CONFIG.longSymbol;
  const shortSymbol = TRADING_CONFIG.shortSymbol;
  const monitorSymbol = TRADING_CONFIG.monitorSymbol;
  const normalizedLongSymbol = normalizeHKSymbol(longSymbol);
  const normalizedShortSymbol = normalizeHKSymbol(shortSymbol);
  const normalizedMonitorSymbol = normalizeHKSymbol(monitorSymbol);

  // 判断是否在交易时段（使用当前系统时间）
  const currentTime = new Date();

  // 首先检查今天是否是交易日（使用 API）
  let isTradingDayToday = true;
  let isHalfDayToday = false;

  try {
    const tradingDayInfo = await marketDataClient.isTradingDay(currentTime);
    isTradingDayToday = tradingDayInfo.isTradingDay;
    isHalfDayToday = tradingDayInfo.isHalfDay;

    // 如果不是交易日，提前返回
    if (!isTradingDayToday) {
      if (lastState.canTrade !== false) {
        logger.info("今天不是交易日，暂停实时监控。");
        lastState.canTrade = false;
      }
      return;
    }

    // 如果是半日交易日，记录日志
    if (isHalfDayToday && !lastState.isHalfDay) {
      logger.info("今天是半日交易日。");
      lastState.isHalfDay = true;
    } else if (!isHalfDayToday && lastState.isHalfDay) {
      lastState.isHalfDay = false;
    }
  } catch (err) {
    logger.warn(
      "无法获取交易日信息，将根据时间判断是否在交易时段",
      err?.message ?? err
    );
  }

  // 如果是交易日，再检查是否在交易时段
  const canTradeNow =
    isTradingDayToday && isInContinuousHKSession(currentTime, isHalfDayToday);

  // 并发获取三个标的的行情
  const [longQuote, shortQuote, monitorQuote] = await Promise.all([
    marketDataClient.getLatestQuote(longSymbol).catch((err) => {
      logger.warn(`[行情获取失败] 做多标的`, err?.message ?? err);
      return null;
    }),
    marketDataClient.getLatestQuote(shortSymbol).catch((err) => {
      logger.warn(`[行情获取失败] 做空标的`, err?.message ?? err);
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
        err?.message ?? err
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

        if (
          Number.isFinite(period) &&
          period >= 1 &&
          period <= 250 &&
          !emaPeriods.includes(period)
        ) {
          emaPeriods.push(period);
        }
      }
    }
  }

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
  const validActions = [
    SignalType.BUYCALL,
    SignalType.SELLCALL,
    SignalType.BUYPUT,
    SignalType.SELLPUT,
  ];

  const validSignals = tradingSignals.filter((signal) => {
    if (!signal?.symbol || !signal?.action) {
      logger.warn(`[跳过信号] 无效的信号对象: ${JSON.stringify(signal)}`);
      return false;
    }
    if (!validActions.includes(signal.action)) {
      logger.warn(
        `[跳过信号] 未知的信号类型: ${signal.action}, 标的: ${signal.symbol}`
      );
      return false;
    }
    return true;
  });

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
        `交易所时间：${lastCandleTime.toLocaleString("zh-CN", {
          timeZone: "Asia/Hong_Kong",
          hour12: false,
        })}`
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

  // 补充价格和lotSize信息
  const signals = validSignals.map((signal) => {
    const normalizedSigSymbol = signal.symbol;

    let price = null;
    let lotSize = null;
    let symbolName = signal.symbolName || null;

    if (normalizedSigSymbol === normalizedLongSymbol && longQuote) {
      price = longQuote.price;
      lotSize = longQuote.lotSize;
      if (!symbolName) {
        symbolName = longQuote.name;
      }
    } else if (normalizedSigSymbol === normalizedShortSymbol && shortQuote) {
      price = shortQuote.price;
      lotSize = shortQuote.lotSize;
      if (!symbolName) {
        symbolName = shortQuote.name;
      }
    }

    return {
      ...signal,
      price,
      lotSize,
      symbolName,
    };
  });

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
  } else if (signals.length > 0 && canTradeNow) {
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

    finalSignals = await signalProcessor.applyRiskChecks(signals, context);
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
  } else if (signals.length > 0 && !canTradeNow) {
    logger.info("当前为竞价或非连续交易时段，交易信号已生成但暂不执行。");
  }

  // 实时监控价格并管理未成交的买入订单
  if (canTradeNow && (longQuote || shortQuote)) {
    await trader.monitorAndManageOrders(longQuote, shortQuote).catch((err) => {
      logger.warn("订单监控失败", err?.message ?? err);
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
              err?.message ?? err
            );
          }
        }
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

  logger.info("程序开始运行，在交易时段将进行实时监控和交易（按 Ctrl+C 退出）");

  // 初始化牛熊证信息
  await riskChecker.initializeWarrantInfo(
    marketDataClient,
    TRADING_CONFIG.longSymbol,
    TRADING_CONFIG.shortSymbol
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
  };

  // 程序启动时立即获取一次账户和持仓信息
  await displayAccountAndPositions(trader, marketDataClient, lastState);

  // 程序启动时从API获取订单数据并更新缓存
  const longSymbol = TRADING_CONFIG.longSymbol;
  const shortSymbol = TRADING_CONFIG.shortSymbol;
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
        err?.message ?? err
      );
    });
  }
  if (shortSymbol && !orderRecorder.isSymbolDisabled(shortSymbol)) {
    await orderRecorder
      .refreshOrders(shortSymbol, false, false)
      .catch((err) => {
        logger.warn(
          `[订单记录初始化失败] 做空标的 ${shortSymbol}`,
          err?.message ?? err
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
            err?.message ?? err
          );
        });
    }
    if (shortSymbol && !orderRecorder.isSymbolDisabled(shortSymbol)) {
      await riskChecker
        .refreshUnrealizedLossData(orderRecorder, shortSymbol, false)
        .catch((err) => {
          logger.warn(
            `[浮亏监控初始化失败] 做空标的 ${shortSymbol}`,
            err?.message ?? err
          );
        });
    }
  }

  // 程序启动时检查一次是否有买入的未成交订单
  try {
    const normalizedLongSymbol = normalizeHKSymbol(longSymbol);
    const normalizedShortSymbol = normalizeHKSymbol(shortSymbol);
    const hasPendingBuyOrders = await trader.hasPendingBuyOrders([
      normalizedLongSymbol,
      normalizedShortSymbol,
    ]);
    if (hasPendingBuyOrders) {
      trader.enableBuyOrderMonitoring();
      logger.info("[订单监控] 程序启动时发现买入订单，开始监控");
    }
  } catch (err) {
    logger.warn("[订单监控] 程序启动时检查买入订单失败", err?.message ?? err);
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
      });
    } catch (err) {
      logger.error("本次执行失败", err);
    }

    await sleep(intervalMs);
  }
}

main().catch((err) => {
  logger.error("程序异常退出", err);
  process.exit(1);
});
