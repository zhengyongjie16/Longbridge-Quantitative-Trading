import { createConfig } from "./config/config.js";
import { HangSengMultiIndicatorStrategy } from "./strategy.js";
import { Trader } from "./trader.js";
import { buildIndicatorSnapshot } from "./indicators.js";
import { RiskChecker } from "./risk.js";
import { TRADING_CONFIG } from "./config/config.trading.js";
import { logger } from "./logger.js";
import { validateAllConfig } from "./config/config.validator.js";
import { SignalType } from "./signalTypes.js";
import { OrderRecorder } from "./orderRecorder.js";
import {
  normalizeHKSymbol,
  formatAccountChannel,
  formatNumber,
} from "./utils.js";

/**
 * 判断是否在港股连续交易时段（仅检查时间，不检查是否是交易日）
 * 港股连续交易时段：
 * - 上午：09:30 - 12:00
 * - 下午：13:00 - 16:00
 * @param {Date} date 时间对象（应该是UTC时间）
 * @returns {boolean} true表示在连续交易时段，false表示不在
 */
function isInContinuousHKSession(date) {
  if (!date) return false;
  // 将时间转换为香港时区（UTC+8）
  const utcHour = date.getUTCHours();
  const utcMinute = date.getUTCMinutes();
  const hkHour = (utcHour + 8) % 24;
  const hkMinute = utcMinute;

  // 上午连续交易时段：09:30 - 12:00（不含 12:00 本身）
  const inMorning =
    (hkHour === 9 && hkMinute >= 30) || // 9:30 - 9:59
    (hkHour >= 10 && hkHour < 12); // 10:00 - 11:59

  // 下午连续交易时段：13:00 - 15:59:59
  // 注意：16:00:00 是收盘时间，不包含在连续交易时段内
  const inAfternoon = hkHour >= 13 && hkHour < 16; // 13:00 - 15:59

  return inMorning || inAfternoon;
}

/**
 * 判断是否在当日收盘前30分钟内（末日保护程序：拒绝买入）
 * 港股正常交易日收盘时间：下午 16:00，收盘前30分钟：15:30 - 15:59
 * 港股半日交易日收盘时间：中午 12:00，收盘前30分钟：11:30 - 11:59
 * @param {Date} date 时间对象（应该是UTC时间）
 * @param {boolean} isHalfDay 是否是半日交易日
 * @returns {boolean} true表示在收盘前30分钟，false表示不在
 */
function isBeforeClose30Minutes(date, isHalfDay = false) {
  if (!date) return false;
  const utcHour = date.getUTCHours();
  const utcMinute = date.getUTCMinutes();
  const hkHour = (utcHour + 8) % 24;
  const hkMinute = utcMinute;

  if (isHalfDay) {
    // 半日交易：收盘前30分钟为 11:30 - 11:59:59（12:00收盘）
    return hkHour === 11 && hkMinute >= 30;
  } else {
    // 正常交易日：收盘前30分钟为 15:30 - 15:59:59（16:00收盘）
    return hkHour === 15 && hkMinute >= 30;
  }
}

/**
 * 判断是否在当日收盘前5分钟内（末日保护程序：自动清仓）
 * 港股正常交易日收盘时间：下午 16:00，收盘前5分钟：15:55 - 15:59
 * 港股半日交易日收盘时间：中午 12:00，收盘前5分钟：11:55 - 11:59
 * @param {Date} date 时间对象（应该是UTC时间）
 * @param {boolean} isHalfDay 是否是半日交易日
 * @returns {boolean} true表示在收盘前5分钟，false表示不在
 */
function isBeforeClose5Minutes(date, isHalfDay = false) {
  if (!date) return false;
  const utcHour = date.getUTCHours();
  const utcMinute = date.getUTCMinutes();
  const hkHour = (utcHour + 8) % 24;
  const hkMinute = utcMinute;

  if (isHalfDay) {
    // 半日交易：收盘前5分钟为 11:55 - 11:59:59（12:00收盘）
    return hkHour === 11 && hkMinute >= 55;
  } else {
    // 正常交易日：收盘前5分钟为 15:55 - 15:59:59（16:00收盘）
    return hkHour === 15 && hkMinute >= 55;
  }
}

/**
 * 主程序：
 * 1. 从环境变量读取 LongPort 配置（见快速开始文档：https://open.longbridge.com/zh-CN/docs/getting-started）
 * 2. 拉取监控标的的 K 线数据（用于计算指标和生成信号）
 * 3. 计算 RSI / KDJ / VWAP，并生成策略信号
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
}) {
  // 返回是否有数据变化
  let hasChange = false;

  // 使用缓存的账户和持仓信息（仅在交易后更新）
  let account = lastState.cachedAccount ?? null;
  let positions = lastState.cachedPositions ?? [];
  // 获取做多标的的行情（用于判断是否在交易时段）
  const longSymbol = TRADING_CONFIG.longSymbol;
  const longQuote = await marketDataClient
    .getLatestQuote(longSymbol)
    .catch((err) => {
      logger.warn(`[行情获取失败] 做多标的`, err?.message ?? err);
      return null;
    });
  const longSymbolName = longQuote?.name ?? longSymbol;

  // 判断是否在交易时段（使用当前系统时间，而不是行情数据的时间戳）
  // 因为行情数据的时间戳可能是历史数据或缓存数据，不能准确反映当前是否在交易时段
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
        hasChange = true;
        logger.info("今天不是交易日，暂停实时监控。");
        lastState.canTrade = false;
      }
      return hasChange;
    }

    // 如果是半日交易日，记录日志
    if (isHalfDayToday && !lastState.isHalfDay) {
      logger.info("今天是半日交易日。");
      lastState.isHalfDay = true;
      hasChange = true;
    } else if (!isHalfDayToday && lastState.isHalfDay) {
      lastState.isHalfDay = false;
    }
  } catch (err) {
    logger.warn(
      "无法获取交易日信息，将根据时间判断是否在交易时段",
      err?.message ?? err
    );
    // 如果获取交易日信息失败，继续使用时间判断（保守策略）
  }

  // 如果是交易日，再检查是否在交易时段
  const canTradeNow = isTradingDayToday && isInContinuousHKSession(currentTime);

  // 如果获取到了行情数据，记录一下行情时间用于调试（仅在DEBUG模式下）
  if (process.env.DEBUG === "true" && longQuote?.timestamp) {
    const quoteTime = longQuote.timestamp;
    logger.debug(
      `[交易时段检查] 当前系统时间: ${currentTime.toISOString()}, 行情时间: ${quoteTime.toISOString()}, 是否在交易时段: ${canTradeNow}`
    );
  }

  // 检测交易时段变化
  if (lastState.canTrade !== canTradeNow) {
    hasChange = true;
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
    return hasChange;
  }

  // 以下逻辑仅在连续交易时段执行
  const shortSymbol = TRADING_CONFIG.shortSymbol;

  // 获取做空标的的行情
  const shortQuote = await marketDataClient
    .getLatestQuote(shortSymbol)
    .catch((err) => {
      logger.warn(`[行情获取失败] 做空标的`, err?.message ?? err);
      return null;
    });
  const shortSymbolName = shortQuote?.name ?? shortSymbol;

  // 检测价格变化，只在价格变化时显示
  const longPrice = longQuote?.price;
  const shortPrice = shortQuote?.price;

  if (
    longPrice !== lastState.longPrice ||
    shortPrice !== lastState.shortPrice
  ) {
    hasChange = true;

    // 统一的行情显示格式化函数
    const formatQuoteDisplay = (quote, symbol) => {
      if (!quote) {
        return null;
      }

      const nameText = quote.name ?? "-";
      const codeText = normalizeHKSymbol(symbol);
      const currentPrice = quote.price;

      // 最新价格
      const priceText = Number.isFinite(currentPrice)
        ? currentPrice.toFixed(3)
        : currentPrice ?? "-";

      // 时间
      const tsText = quote.timestamp
        ? quote.timestamp.toLocaleString("zh-CN", {
            timeZone: "Asia/Hong_Kong",
            hour12: false,
          })
        : "未知时间";

      // 涨跌额和涨跌幅度
      let changeAmountText = "-";
      let changePercentText = "-";

      if (
        Number.isFinite(currentPrice) &&
        Number.isFinite(quote.prevClose) &&
        quote.prevClose !== 0
      ) {
        // 涨跌额 = 当前价格 - 前收盘价
        const changeAmount = currentPrice - quote.prevClose;
        changeAmountText = `${
          changeAmount >= 0 ? "+" : ""
        }${changeAmount.toFixed(3)}`;

        // 涨跌幅度 = (当前价格 - 前收盘价) / 前收盘价 * 100%
        const changePercent = (changeAmount / quote.prevClose) * 100;
        changePercentText = `${
          changePercent >= 0 ? "+" : ""
        }${changePercent.toFixed(2)}%`;
      }

      return {
        nameText,
        codeText,
        priceText,
        changeAmountText,
        changePercentText,
        tsText,
      };
    };

    // 显示做多标的行情
    const longDisplay = formatQuoteDisplay(longQuote, longSymbol);
    if (longDisplay) {
      logger.info(
        `[做多标的] ${longDisplay.nameText}(${longDisplay.codeText}) 最新价格=${longDisplay.priceText} 涨跌额=${longDisplay.changeAmountText} 涨跌幅度=${longDisplay.changePercentText} 时间=${longDisplay.tsText}`
      );
    } else {
      logger.warn(`未获取到做多标的行情。`);
    }

    // 显示做空标的行情
    const shortDisplay = formatQuoteDisplay(shortQuote, shortSymbol);
    if (shortDisplay) {
      logger.info(
        `[做空标的] ${shortDisplay.nameText}(${shortDisplay.codeText}) 最新价格=${shortDisplay.priceText} 涨跌额=${shortDisplay.changeAmountText} 涨跌幅度=${shortDisplay.changePercentText} 时间=${shortDisplay.tsText}`
      );
    } else {
      logger.warn(`未获取到做空标的行情。`);
    }

    // 更新价格状态
    lastState.longPrice = longPrice;
    lastState.shortPrice = shortPrice;
  }

  // 获取监控标的的K线数据（用于计算指标和生成信号）
  const monitorSymbol = TRADING_CONFIG.monitorSymbol;
  const monitorQuote = await marketDataClient
    .getLatestQuote(monitorSymbol)
    .catch(() => null);
  const monitorSymbolName = monitorQuote?.name ?? monitorSymbol;
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

  // 只计算监控标的的指标
  const monitorSnapshot = buildIndicatorSnapshot(monitorSymbol, monitorCandles);

  // 检测监控标的的所有指标值变化并实时显示
  if (monitorSnapshot) {
    const currentValues = {
      price: monitorSnapshot.price,
      vwap: monitorSnapshot.vwap,
      rsi6: monitorSnapshot.rsi6,
      rsi12: monitorSnapshot.rsi12,
      kdj: monitorSnapshot.kdj,
      macd: monitorSnapshot.macd,
    };

    const lastValues = lastState.monitorValues || {};

    // 检查是否有任何值发生变化
    const isFirstTime =
      !lastValues.price && !lastValues.vwap && !lastValues.rsi6;

    const hasValueChanged =
      isFirstTime ||
      // 价格变化
      (Number.isFinite(currentValues.price) &&
        Number.isFinite(lastValues.price) &&
        Math.abs(currentValues.price - lastValues.price) > 0.0001) ||
      // VWAP变化
      (Number.isFinite(currentValues.vwap) &&
        Number.isFinite(lastValues.vwap) &&
        Math.abs(currentValues.vwap - lastValues.vwap) > 0.0001) ||
      // RSI6变化
      (Number.isFinite(currentValues.rsi6) &&
        Number.isFinite(lastValues.rsi6) &&
        Math.abs(currentValues.rsi6 - lastValues.rsi6) > 0.01) ||
      // RSI12变化
      (Number.isFinite(currentValues.rsi12) &&
        Number.isFinite(lastValues.rsi12) &&
        Math.abs(currentValues.rsi12 - lastValues.rsi12) > 0.01) ||
      // KDJ变化（首次或值变化）
      (!lastValues.kdj && currentValues.kdj) ||
      (currentValues.kdj &&
        lastValues.kdj &&
        (Math.abs((currentValues.kdj.k ?? 0) - (lastValues.kdj?.k ?? 0)) >
          0.01 ||
          Math.abs((currentValues.kdj.d ?? 0) - (lastValues.kdj?.d ?? 0)) >
            0.01 ||
          Math.abs((currentValues.kdj.j ?? 0) - (lastValues.kdj?.j ?? 0)) >
            0.01)) ||
      // MACD变化（首次或MACD柱值变化）
      (!lastValues.macd &&
        currentValues.macd &&
        Number.isFinite(currentValues.macd.macd)) ||
      (currentValues.macd &&
        lastValues.macd &&
        Number.isFinite(currentValues.macd.macd) &&
        Number.isFinite(lastValues.macd?.macd) &&
        Math.abs(currentValues.macd.macd - lastValues.macd.macd) > 0.0001);

    if (hasValueChanged) {
      hasChange = true;

      // 构建显示信息
      const parts = [];

      // 价格
      if (Number.isFinite(currentValues.price)) {
        parts.push(`价格=${currentValues.price.toFixed(3)}`);
      }

      // VWAP
      if (Number.isFinite(currentValues.vwap)) {
        parts.push(`VWAP=${currentValues.vwap.toFixed(3)}`);
      }

      // RSI
      if (Number.isFinite(currentValues.rsi6)) {
        parts.push(`RSI6=${currentValues.rsi6.toFixed(2)}`);
      }
      if (Number.isFinite(currentValues.rsi12)) {
        parts.push(`RSI12=${currentValues.rsi12.toFixed(2)}`);
      }

      // KDJ
      if (
        currentValues.kdj &&
        Number.isFinite(currentValues.kdj.k) &&
        Number.isFinite(currentValues.kdj.d) &&
        Number.isFinite(currentValues.kdj.j)
      ) {
        parts.push(
          `KDJ(K=${currentValues.kdj.k.toFixed(
            2
          )},D=${currentValues.kdj.d.toFixed(
            2
          )},J=${currentValues.kdj.j.toFixed(2)})`
        );
      }

      // MACD（只显示MACD柱值）
      if (currentValues.macd && Number.isFinite(currentValues.macd.macd)) {
        parts.push(`MACD=${currentValues.macd.macd.toFixed(4)}`);
      }

      if (parts.length > 0) {
        logger.info(
          `[监控标的指标] ${monitorSymbolName}(${normalizeHKSymbol(
            monitorSymbol
          )}) ${parts.join(" ")}`
        );
      }

      // 更新保存的值
      lastState.monitorValues = {
        price: currentValues.price,
        vwap: currentValues.vwap,
        rsi6: currentValues.rsi6,
        rsi12: currentValues.rsi12,
        kdj: currentValues.kdj
          ? {
              k: currentValues.kdj.k,
              d: currentValues.kdj.d,
              j: currentValues.kdj.j,
            }
          : null,
        macd: currentValues.macd
          ? {
              dif: currentValues.macd.dif,
              dea: currentValues.macd.dea,
              macd: currentValues.macd.macd,
            }
          : null,
      };
    }
  }

  // 为所有待验证的信号记录当前监控标的值（每秒记录一次）
  // 每个信号都有自己独立的历史记录
  // 增加5秒缓冲，确保在验证时间点之后5秒内还能记录，用于容错获取最近的值
  if (
    monitorSnapshot &&
    lastState.pendingDelayedSignals &&
    lastState.pendingDelayedSignals.length > 0
  ) {
    const now = new Date();
    const currentJ = monitorSnapshot.kdj?.j ?? null;
    const currentMACD = monitorSnapshot.macd?.macd ?? null;

    // 为每个待验证信号记录当前值（如果值有效）
    if (Number.isFinite(currentJ) && Number.isFinite(currentMACD)) {
      for (const pendingSignal of lastState.pendingDelayedSignals) {
        // 记录条件：triggerTime + 5秒 > 当前时间（增加5秒缓冲）
        // 这样可以确保在验证时间点之后5秒内还能继续记录，用于容错获取最近的值
        if (pendingSignal.triggerTime) {
          const bufferTime = new Date(
            pendingSignal.triggerTime.getTime() + 5 * 1000
          ); // triggerTime + 5秒
          if (bufferTime > now) {
            // 确保信号有历史记录数组
            if (!pendingSignal.verificationHistory) {
              pendingSignal.verificationHistory = [];
            }

            // 避免在同一秒内重复记录（精确到秒）
            const nowSeconds = Math.floor(now.getTime() / 1000);
            const lastEntry =
              pendingSignal.verificationHistory[
                pendingSignal.verificationHistory.length - 1
              ];
            const lastEntrySeconds = lastEntry
              ? Math.floor(lastEntry.timestamp.getTime() / 1000)
              : null;

            // 如果上一记录不是同一秒，则添加新记录
            if (lastEntrySeconds !== nowSeconds) {
              // 记录当前值
              pendingSignal.verificationHistory.push({
                timestamp: now,
                j: currentJ,
                macd: currentMACD,
              });

              // 只保留最近2分钟的数据（120秒），避免内存占用过大
              const twoMinutesAgo = now.getTime() - 120 * 1000;
              pendingSignal.verificationHistory =
                pendingSignal.verificationHistory.filter(
                  (entry) => entry.timestamp.getTime() >= twoMinutesAgo
                );
            }
          }
        }
      }
    }
  }

  // 获取做多和做空标的的持仓信息
  const normalizedLongSymbol = normalizeHKSymbol(longSymbol);
  const normalizedShortSymbol = normalizeHKSymbol(shortSymbol);

  let longPosition = null;
  let shortPosition = null;

  // 验证 positions 是数组
  if (Array.isArray(positions)) {
    for (const pos of positions) {
      // 验证持仓对象有效性
      if (!pos?.symbol || typeof pos.symbol !== "string") {
        continue; // 跳过无效持仓
      }

      const normalizedPosSymbol = normalizeHKSymbol(pos.symbol);

      // 验证可用数量有效性
      const availableQty = Number(pos.availableQuantity) || 0;
      if (!Number.isFinite(availableQty) || availableQty <= 0) {
        continue; // 跳过无效或零持仓
      }

      if (normalizedPosSymbol === normalizedLongSymbol) {
        longPosition = {
          symbol: pos.symbol,
          costPrice: Number(pos.costPrice) || 0,
          quantity: Number(pos.quantity) || 0,
          availableQuantity: availableQty,
        };
      } else if (normalizedPosSymbol === normalizedShortSymbol) {
        shortPosition = {
          symbol: pos.symbol,
          costPrice: Number(pos.costPrice) || 0,
          quantity: Number(pos.quantity) || 0,
          availableQuantity: availableQty,
        };
      }
    }
  }

  // 根据策略生成交易信号（包含立即执行的清仓信号和延迟验证的开仓信号）
  const { immediateSignals, delayedSignals } = strategy.generateCloseSignals(
    monitorSnapshot,
    longPosition,
    longQuote?.price ?? null,
    shortPosition,
    shortQuote?.price ?? null,
    normalizedLongSymbol,
    normalizedShortSymbol,
    orderRecorder
  );

  // 将立即执行的信号添加到交易信号列表
  const tradingSignals = [...immediateSignals];

  // 初始化待验证信号数组（如果不存在）
  if (!lastState.pendingDelayedSignals) {
    lastState.pendingDelayedSignals = [];
  }

  // 处理延迟验证信号，添加到待验证列表
  for (const delayedSignal of delayedSignals) {
    if (delayedSignal && delayedSignal.triggerTime) {
      // 检查是否已存在相同的待验证信号（避免重复添加）
      const existingSignal = lastState.pendingDelayedSignals.find(
        (s) =>
          s.symbol === delayedSignal.symbol &&
          s.action === delayedSignal.action &&
          s.triggerTime.getTime() === delayedSignal.triggerTime.getTime()
      );

      if (!existingSignal) {
        lastState.pendingDelayedSignals.push(delayedSignal);
        hasChange = true;
        const actionDesc =
          delayedSignal.action === SignalType.BUYCALL ? "买入做多" : "买入做空";
        logger.info(
          `[延迟验证信号] 新增待验证${actionDesc}信号：${delayedSignal.symbol} - ${delayedSignal.reason}`
        );
      }
    }
  }

  // 检查是否有待验证的信号到了验证时间
  const now = new Date();
  const signalsToVerify = lastState.pendingDelayedSignals.filter(
    (s) => s.triggerTime && s.triggerTime <= now
  );

  // 处理需要验证的信号
  for (const pendingSignal of signalsToVerify) {
    try {
      // 验证策略更新：从实时监控标的的值获取J2和MACD2
      // 触发信号时已记录J1和MACD1，现在需要获取60秒后的J2和MACD2
      if (!pendingSignal.triggerTime) {
        logger.warn(
          `[延迟验证错误] ${pendingSignal.symbol} 缺少triggerTime，跳过验证`
        );
        // 清空该信号的历史记录
        if (pendingSignal.verificationHistory) {
          pendingSignal.verificationHistory = [];
        }
        // 从待验证列表中移除
        const index = lastState.pendingDelayedSignals.indexOf(pendingSignal);
        if (index >= 0) {
          lastState.pendingDelayedSignals.splice(index, 1);
        }
        continue;
      }

      // 获取J1和MACD1（从信号中获取，触发时已记录）
      const j1 = pendingSignal.j1;
      const macd1 = pendingSignal.macd1;

      if (!Number.isFinite(j1) || !Number.isFinite(macd1)) {
        logger.warn(
          `[延迟验证错误] ${pendingSignal.symbol} 缺少J1或MACD1值（J1=${j1}, MACD1=${macd1}），跳过验证`
        );
        // 清空该信号的历史记录
        if (pendingSignal.verificationHistory) {
          pendingSignal.verificationHistory = [];
        }
        // 从待验证列表中移除
        const index = lastState.pendingDelayedSignals.indexOf(pendingSignal);
        if (index >= 0) {
          lastState.pendingDelayedSignals.splice(index, 1);
        }
        continue;
      }

      // 目标时间就是triggerTime（触发时已设置为当前时间+60秒）
      const targetTime = pendingSignal.triggerTime;

      // 从该信号自己的验证历史记录中获取J2和MACD2
      // 优先获取精确匹配的值，如果失败则获取距离目标时间最近的值（误差5秒内）
      const history = pendingSignal.verificationHistory || [];

      // 查找精确匹配或最近的值
      let bestMatch = null;
      let minTimeDiff = Infinity;
      const maxTimeDiff = 5 * 1000; // 5秒误差

      for (const entry of history) {
        const timeDiff = Math.abs(
          entry.timestamp.getTime() - targetTime.getTime()
        );
        if (timeDiff <= maxTimeDiff && timeDiff < minTimeDiff) {
          minTimeDiff = timeDiff;
          bestMatch = entry;
        }
      }

      // 如果找不到匹配的值，尝试使用历史记录中最新的值（如果时间差在合理范围内）
      if (!bestMatch && history.length > 0) {
        const latestEntry = history[history.length - 1];
        const timeDiff = Math.abs(
          latestEntry.timestamp.getTime() - targetTime.getTime()
        );
        if (timeDiff <= maxTimeDiff) {
          bestMatch = latestEntry;
        }
      }

      if (
        !bestMatch ||
        !Number.isFinite(bestMatch.j) ||
        !Number.isFinite(bestMatch.macd)
      ) {
        logger.warn(
          `[延迟验证失败] ${
            pendingSignal.symbol
          } 无法获取有效的J2或MACD2值（目标时间=${targetTime.toLocaleString(
            "zh-CN",
            { timeZone: "Asia/Hong_Kong", hour12: false }
          )}，当前时间=${now.toLocaleString("zh-CN", {
            timeZone: "Asia/Hong_Kong",
            hour12: false,
          })}）`
        );
        // 清空该信号的历史记录
        if (pendingSignal.verificationHistory) {
          pendingSignal.verificationHistory = [];
        }
        // 从待验证列表中移除
        const index = lastState.pendingDelayedSignals.indexOf(pendingSignal);
        if (index >= 0) {
          lastState.pendingDelayedSignals.splice(index, 1);
        }
        continue;
      }

      const j2 = bestMatch.j;
      const macd2 = bestMatch.macd;
      const actualTime = bestMatch.timestamp;
      const timeDiffSeconds =
        Math.abs(actualTime.getTime() - targetTime.getTime()) / 1000;

      // 根据信号类型使用不同的验证条件
      const isBuyCall = pendingSignal.action === SignalType.BUYCALL;
      const isBuyPut = pendingSignal.action === SignalType.BUYPUT;

      // 只处理延迟验证的信号类型
      if (!isBuyCall && !isBuyPut) {
        logger.warn(
          `[延迟验证错误] ${pendingSignal.symbol} 未知的信号类型: ${pendingSignal.action}，跳过验证`
        );
        // 清空该信号的历史记录
        if (pendingSignal.verificationHistory) {
          pendingSignal.verificationHistory = [];
        }
        // 从待验证列表中移除
        const index = lastState.pendingDelayedSignals.indexOf(pendingSignal);
        if (index >= 0) {
          lastState.pendingDelayedSignals.splice(index, 1);
        }
        continue;
      }

      let verificationPassed = false;
      let verificationReason = "";

      if (isBuyCall) {
        // 买入做多标的：J2 > J1 且 MACD2 > MACD1
        const jCondition = j2 > j1;
        const macdCondition = macd2 > macd1;
        verificationPassed = jCondition && macdCondition;
        verificationReason = verificationPassed
          ? `J1=${j1.toFixed(2)} J2=${j2.toFixed(
              2
            )} (J2>J1) MACD1=${macd1.toFixed(4)} MACD2=${macd2.toFixed(
              4
            )} (MACD2>MACD1) 时间差=${timeDiffSeconds.toFixed(1)}秒`
          : `J1=${j1.toFixed(2)} J2=${j2.toFixed(2)} (J2${
              j2 > j1 ? ">" : "<="
            }J1) MACD1=${macd1.toFixed(4)} MACD2=${macd2.toFixed(4)} (MACD2${
              macd2 > macd1 ? ">" : "<="
            }MACD1) 时间差=${timeDiffSeconds.toFixed(1)}秒`;
      } else if (isBuyPut) {
        // 买入做空标的：J2 < J1 且 MACD2 < MACD1
        const jCondition = j2 < j1;
        const macdCondition = macd2 < macd1;
        verificationPassed = jCondition && macdCondition;
        verificationReason = verificationPassed
          ? `J1=${j1.toFixed(2)} J2=${j2.toFixed(
              2
            )} (J2<J1) MACD1=${macd1.toFixed(4)} MACD2=${macd2.toFixed(
              4
            )} (MACD2<MACD1) 时间差=${timeDiffSeconds.toFixed(1)}秒`
          : `J1=${j1.toFixed(2)} J2=${j2.toFixed(2)} (J2${
              j2 < j1 ? "<" : ">="
            }J1) MACD1=${macd1.toFixed(4)} MACD2=${macd2.toFixed(4)} (MACD2${
              macd2 < macd1 ? "<" : ">="
            }MACD1) 时间差=${timeDiffSeconds.toFixed(1)}秒`;
      } else {
        // 理论上不会执行到这里（前面已检查），但为了安全起见
        verificationPassed = false;
        verificationReason = `未知的信号类型: ${pendingSignal.action}`;
        logger.warn(
          `[延迟验证错误] ${pendingSignal.symbol} ${verificationReason}，跳过验证`
        );
        // 清空该信号的历史记录
        if (pendingSignal.verificationHistory) {
          pendingSignal.verificationHistory = [];
        }
        // 从待验证列表中移除
        const index = lastState.pendingDelayedSignals.indexOf(pendingSignal);
        if (index >= 0) {
          lastState.pendingDelayedSignals.splice(index, 1);
        }
        continue;
      }

      if (verificationPassed) {
        const actionDesc = isBuyCall ? "买入做多" : "买入做空";
        logger.info(
          `[延迟验证通过] ${pendingSignal.symbol} ${verificationReason}，执行${actionDesc}`
        );

        // 获取标的的当前价格和最小买卖单位
        let currentPrice = null;
        let lotSize = null;
        if (isBuyCall && longQuote) {
          currentPrice = longQuote.price;
          lotSize = longQuote.lotSize;
        } else if (isBuyPut && shortQuote) {
          currentPrice = shortQuote.price;
          lotSize = shortQuote.lotSize;
        }

        // 获取标的的中文名称
        let symbolName = null;
        if (isBuyCall && longQuote) {
          symbolName = longQuote.name;
        } else if (isBuyPut && shortQuote) {
          symbolName = shortQuote.name;
        }

        // 生成买入信号
        const verifiedSignal = {
          symbol: pendingSignal.symbol,
          symbolName: symbolName,
          action: pendingSignal.action,
          reason: `延迟验证通过：${verificationReason}`,
          price: currentPrice,
          lotSize: lotSize,
          signalTriggerTime: pendingSignal.triggerTime, // 信号触发时间
        };

        // 添加到交易信号列表
        tradingSignals.push(verifiedSignal);
        hasChange = true;
      } else {
        const actionDesc = isBuyCall ? "买入做多" : "买入做空";
        logger.info(
          `[延迟验证失败] ${pendingSignal.symbol} ${verificationReason}，不执行${actionDesc}`
        );
      }

      // 清空该信号的历史记录
      if (pendingSignal.verificationHistory) {
        pendingSignal.verificationHistory = [];
      }

      // 从待验证列表中移除（无论验证是否通过）
      const index = lastState.pendingDelayedSignals.indexOf(pendingSignal);
      if (index >= 0) {
        lastState.pendingDelayedSignals.splice(index, 1);
      }
    } catch (err) {
      logger.error(
        `[延迟验证错误] 处理待验证信号 ${pendingSignal.symbol} 时发生错误`,
        err?.message ?? err
      );
      // 清空该信号的历史记录
      if (pendingSignal.verificationHistory) {
        pendingSignal.verificationHistory = [];
      }
      // 从待验证列表中移除错误的信号
      const index = lastState.pendingDelayedSignals.indexOf(pendingSignal);
      if (index >= 0) {
        lastState.pendingDelayedSignals.splice(index, 1);
      }
    }
  }

  // 检测信号变化
  // 验证信号数组的有效性
  const validSignals = tradingSignals.filter(
    (s) =>
      s?.symbol &&
      s?.action &&
      (s.action === SignalType.BUYCALL ||
        s.action === SignalType.SELLCALL ||
        s.action === SignalType.BUYPUT ||
        s.action === SignalType.SELLPUT)
  );

  const currentSignalKey =
    validSignals.length > 0
      ? validSignals
          .map((s) => `${s.action}_${s.symbol}_${s.reason || ""}`)
          .join("|")
      : null;
  const lastSignalKey = lastState.signal;

  if (currentSignalKey !== lastSignalKey) {
    hasChange = true;
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
        // 判断信号类型
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
        `[监控标的信号] ${monitorSymbolName}(${normalizeHKSymbol(
          monitorSymbol
        )}) 无交易信号`
      );
    }

    lastState.signal = currentSignalKey;
  }

  // 使用新策略生成的交易信号
  // 过滤并验证信号，只处理有效的信号
  const signals = tradingSignals
    .filter((signal) => {
      if (!signal?.symbol || !signal?.action) {
        logger.warn(`[跳过信号] 无效的信号对象: ${JSON.stringify(signal)}`);
        return false;
      }
      const validActions = [
        SignalType.BUYCALL,
        SignalType.SELLCALL,
        SignalType.BUYPUT,
        SignalType.SELLPUT,
      ];
      if (!validActions.includes(signal.action)) {
        logger.warn(
          `[跳过信号] 未知的信号类型: ${signal.action}, 标的: ${signal.symbol}`
        );
        return false;
      }
      return true;
    })
    .map((signal) => {
      const normalizedSigSymbol = normalizeHKSymbol(signal.symbol);

      // 确定价格、lotSize和名称
      let price = null;
      let lotSize = null;
      let symbolName = signal.symbolName || null; // 优先使用信号中的名称

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
        symbolName, // 添加名称信息
      };
    });

  // 末日保护程序：检查是否需要在收盘前5分钟清仓（使用当前系统时间，而非行情时间）
  const shouldClearBeforeClose = TRADING_CONFIG.clearPositionsBeforeClose;
  const isBeforeClose = isBeforeClose5Minutes(currentTime, isHalfDayToday);

  let finalSignals = [];

  if (
    shouldClearBeforeClose &&
    isBeforeClose &&
    canTradeNow &&
    Array.isArray(positions) &&
    positions.length > 0
  ) {
    // 当日收盘前5分钟，清空所有持仓（无论是做多标的持仓还是做空标的持仓）
    const closeTimeRange = isHalfDayToday ? "11:55-11:59" : "15:55-15:59";
    logger.info(
      `[末日保护程序] 收盘前5分钟（${closeTimeRange}），准备清空所有持仓`
    );

    // 为每个持仓生成清仓信号
    const clearSignals = [];
    const normalizedLongSymbol = normalizeHKSymbol(longSymbol);
    const normalizedShortSymbol = normalizeHKSymbol(shortSymbol);
    // 验证 positions 是数组
    if (Array.isArray(positions)) {
      for (const pos of positions) {
        // 验证持仓对象有效性
        if (!pos || !pos.symbol || typeof pos.symbol !== "string") {
          continue; // 跳过无效持仓
        }

        const availableQty = Number(pos.availableQuantity) || 0;
        if (!Number.isFinite(availableQty) || availableQty <= 0) {
          continue; // 跳过无效或零持仓
        }

        const normalizedPosSymbol = normalizeHKSymbol(pos.symbol);
        const isShortPos = normalizedPosSymbol === normalizedShortSymbol;

        // 获取该标的的当前价格、最小买卖单位和名称
        let currentPrice = null;
        let lotSize = null;
        let symbolName = pos.symbolName || null; // 优先使用持仓中的名称
        if (normalizedPosSymbol === normalizedLongSymbol && longQuote) {
          currentPrice = longQuote.price;
          lotSize = longQuote.lotSize;
          if (!symbolName) {
            symbolName = longQuote.name;
          }
        } else if (
          normalizedPosSymbol === normalizedShortSymbol &&
          shortQuote
        ) {
          currentPrice = shortQuote.price;
          lotSize = shortQuote.lotSize;
          if (!symbolName) {
            symbolName = shortQuote.name;
          }
        }

        // 收盘前清仓逻辑：
        // - 做多标的持仓：使用 SELLCALL 信号 → OrderSide.Sell（卖出做多标的，清仓）
        // - 做空标的持仓：使用 SELLPUT 信号 → OrderSide.Sell（卖出做空标的，平空仓）
        const action = isShortPos ? SignalType.SELLPUT : SignalType.SELLCALL;
        const positionType = isShortPos ? "做空标的" : "做多标的";

        clearSignals.push({
          symbol: pos.symbol,
          symbolName: symbolName, // 添加名称信息
          action: action,
          price: currentPrice, // 添加当前价格，用于增强限价单
          lotSize: lotSize, // 添加最小买卖单位
          reason: `末日保护程序：收盘前5分钟自动清仓（${positionType}持仓）`,
          signalTriggerTime: new Date(), // 收盘前清仓信号的触发时间
        });

        logger.info(
          `[末日保护程序] 生成清仓信号：${positionType} ${pos.symbol} 数量=${availableQty} 操作=${action}`
        );
      }
    }

    if (clearSignals.length > 0) {
      finalSignals = clearSignals;
      logger.info(
        `[末日保护程序] 共生成 ${clearSignals.length} 个清仓信号，准备执行`
      );
    }
  } else if (signals.length > 0 && canTradeNow) {
    // 正常交易信号处理
    const orderNotional = TRADING_CONFIG.targetNotional;
    for (const sig of signals) {
      // 获取标的的当前价格用于计算持仓市值
      const normalizedSigSymbol = normalizeHKSymbol(sig.symbol);
      const normalizedLongSymbol = normalizeHKSymbol(longSymbol);
      const normalizedShortSymbol = normalizeHKSymbol(shortSymbol);

      let currentPrice = null;
      if (normalizedSigSymbol === normalizedLongSymbol && longQuote) {
        currentPrice = longQuote.price;
      } else if (normalizedSigSymbol === normalizedShortSymbol && shortQuote) {
        currentPrice = shortQuote.price;
      }

      // 检查牛熊证风险（仅在买入时检查，卖出时不检查）
      // 注意：所有操作均无卖空操作，做空是指买入做空标的而非卖空做空标的
      //
      // 做多和做空操作根据监控标的信号产生：
      //   - BUYCALL → 买入做多标的（做多操作，需要检查牛熊证风险）
      //   - BUYPUT → 买入做空标的（做空操作，需要检查牛熊证风险）
      //
      // 卖出操作（不检查牛熊证风险）：
      //   - SELLCALL → 卖出做多标的（清仓）
      //   - SELLPUT → 卖出做空标的（平空仓）
      const isBuyAction =
        sig.action === SignalType.BUYCALL || sig.action === SignalType.BUYPUT;

      if (isBuyAction) {
        // 末日保护程序：收盘前30分钟拒绝买入（卖出操作不受影响）
        const shouldClearBeforeClose = TRADING_CONFIG.clearPositionsBeforeClose;
        const isBeforeClose30 = isBeforeClose30Minutes(
          currentTime,
          isHalfDayToday
        );
        if (shouldClearBeforeClose && isBeforeClose30) {
          // 获取标的的中文名称
          let sigName = sig.symbol;
          if (normalizedSigSymbol === normalizedLongSymbol) {
            sigName = longSymbolName;
          } else if (normalizedSigSymbol === normalizedShortSymbol) {
            sigName = shortSymbolName;
          }
          const codeText = normalizeHKSymbol(sig.symbol);
          const closeTimeRange = isHalfDayToday ? "11:30-12:00" : "15:30-16:00";
          logger.warn(
            `[末日保护程序] 收盘前30分钟内拒绝买入：${sigName}(${codeText}) ${sig.action} - 当前时间在${closeTimeRange}范围内`
          );
          continue; // 跳过这个买入信号
        }

        // 仅在买入时检查牛熊证风险
        // 注意：使用监控标的的实时价格（而非牛熊证本身的价格）来计算距离回收价的百分比
        // 优先使用实时行情价格，如果没有则使用K线收盘价
        const monitorCurrentPrice =
          monitorQuote?.price ?? monitorSnapshot?.price ?? null;
        const warrantRiskResult = riskChecker.checkWarrantRisk(
          sig.symbol,
          sig.action,
          monitorCurrentPrice
        );

        if (!warrantRiskResult.allowed) {
          // 获取标的的中文名称
          let sigName = sig.symbol;
          if (normalizedSigSymbol === normalizedLongSymbol) {
            sigName = longSymbolName;
          } else if (normalizedSigSymbol === normalizedShortSymbol) {
            sigName = shortSymbolName;
          }
          const codeText = normalizeHKSymbol(sig.symbol);
          logger.warn(
            `[牛熊证风险拦截] 信号被牛熊证风险控制拦截：${sigName}(${codeText}) ${sig.action} - ${warrantRiskResult.reason}`
          );
          continue; // 跳过这个信号，不加入finalSignals
        } else if (warrantRiskResult.warrantInfo?.isWarrant) {
          // 如果是牛熊证且风险检查通过，记录信息
          const warrantType =
            warrantRiskResult.warrantInfo.warrantType === "BULL"
              ? "牛证"
              : "熊证";
          const distancePercent =
            warrantRiskResult.warrantInfo.distanceToStrikePercent;
          logger.info(
            `[牛熊证风险检查] ${
              sig.symbol
            } 为${warrantType}，距离回收价百分比：${
              distancePercent?.toFixed(2) ?? "未知"
            }%，风险检查通过`
          );
        }
      }
      // 卖出操作（平仓）时不检查牛熊证风险

      // 基础风险检查前，实时获取最新账户和持仓信息以确保准确性
      // 对于买入操作，必须实时获取最新数据以确保浮亏计算准确
      // 对于卖出操作，可以使用缓存数据（卖出操作不检查浮亏限制）
      // 注意：isBuyAction 已在上面定义（第1070行），这里直接使用
      let accountForRiskCheck = account;
      let positionsForRiskCheck = positions;

      // 对于买入操作，总是实时获取最新数据以确保浮亏检查准确
      // 对于卖出操作，如果缓存为空才实时获取
      if (
        isBuyAction ||
        !accountForRiskCheck ||
        !positionsForRiskCheck ||
        positionsForRiskCheck.length === 0
      ) {
        try {
          const freshAccount = await trader
            .getAccountSnapshot()
            .catch((err) => {
              logger.warn("风险检查前获取账户信息失败", err?.message ?? err);
              return null;
            });
          const freshPositions = await trader
            .getStockPositions()
            .catch((err) => {
              logger.warn("风险检查前获取持仓信息失败", err?.message ?? err);
              return [];
            });

          // 对于买入操作，必须确保账户数据可用
          if (freshAccount) {
            accountForRiskCheck = freshAccount;
            lastState.cachedAccount = freshAccount;
          } else if (isBuyAction) {
            // 买入操作时，如果获取账户信息失败，记录警告
            // 风险检查会在 checkBeforeOrder 中拒绝（因为 account 为 null）
            logger.warn(
              "[风险检查] 买入操作前无法获取最新账户信息，风险检查将拒绝该操作"
            );
          }

          // 对于买入操作，即使持仓数组为空也要更新（确保浮亏计算准确）
          // 对于卖出操作，只在有持仓数据时更新
          if (Array.isArray(freshPositions)) {
            if (isBuyAction || freshPositions.length > 0) {
              positionsForRiskCheck = freshPositions;
              lastState.cachedPositions = freshPositions;
            }
          } else if (isBuyAction) {
            // 买入操作时，如果获取持仓信息失败，使用空数组（确保浮亏计算能正常进行）
            positionsForRiskCheck = [];
            lastState.cachedPositions = [];
          }
        } catch (err) {
          logger.warn("风险检查前获取账户和持仓信息失败", err?.message ?? err);
        }
      }

      // 基础风险检查（使用最新获取的账户和持仓信息）
      const riskResult = riskChecker.checkBeforeOrder(
        accountForRiskCheck,
        positionsForRiskCheck,
        sig,
        orderNotional,
        currentPrice
      );
      if (riskResult.allowed) {
        finalSignals.push(sig);
      } else {
        // 获取标的的中文名称
        const normalizedSigSymbol = normalizeHKSymbol(sig.symbol);
        const normalizedLongSymbol = normalizeHKSymbol(longSymbol);
        const normalizedShortSymbol = normalizeHKSymbol(shortSymbol);
        let sigName = sig.symbol;
        if (normalizedSigSymbol === normalizedLongSymbol) {
          sigName = longSymbolName;
        } else if (normalizedSigSymbol === normalizedShortSymbol) {
          sigName = shortSymbolName;
        }
        const codeText = normalizeHKSymbol(sig.symbol);
        logger.warn(
          `[风险拦截] 信号被风险控制拦截：${sigName}(${codeText}) ${sig.action} - ${riskResult.reason}`
        );
      }
    }
  }

  // 只在有交易信号时显示执行信息（信号变化时已显示）
  if (finalSignals.length > 0) {
    hasChange = true;
    for (const sig of finalSignals) {
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
      // 获取标的的中文名称
      const normalizedSigSymbol = normalizeHKSymbol(sig.symbol);
      const normalizedLongSymbol = normalizeHKSymbol(longSymbol);
      const normalizedShortSymbol = normalizeHKSymbol(shortSymbol);
      let sigName = sig.symbol;
      if (normalizedSigSymbol === normalizedLongSymbol) {
        sigName = longSymbolName;
      } else if (normalizedSigSymbol === normalizedShortSymbol) {
        sigName = shortSymbolName;
      }
      const codeText = normalizeHKSymbol(sig.symbol);
      logger.info(
        `[交易指令] 将对 ${sigName}(${codeText}) 执行${targetAction}操作 - ${sig.reason}`
      );
    }
  } else if (signals.length > 0 && !canTradeNow) {
    // 有信号但不在交易时段
    hasChange = true;
    logger.info("当前为竞价或非连续交易时段，交易信号已生成但暂不执行。");
  }

  // 实时监控价格并管理未成交的买入订单（每秒一次，仅在交易时段且需要监控时执行）
  // 注意：不在交易时段时，即使有买入订单也不监控
  if (canTradeNow && (longQuote || shortQuote)) {
    await trader.monitorAndManageOrders(longQuote, shortQuote).catch((err) => {
      logger.warn("订单监控失败", err?.message ?? err);
    });
  }

  // 执行交易（只在有信号时显示）
  if (finalSignals.length > 0) {
    hasChange = true;
    logger.info(`执行交易：共 ${finalSignals.length} 个交易信号`);
    await trader.executeSignals(finalSignals);

    // 交易后获取并显示账户和持仓信息（仅显示一次）
    await displayAccountAndPositions(trader, marketDataClient, lastState);

    // 交易后刷新订单记录（买入或卖出做多/做空标的时都需要刷新）
    if (orderRecorder) {
      const longSymbol = TRADING_CONFIG.longSymbol;
      const shortSymbol = TRADING_CONFIG.shortSymbol;

      // 检查是否有买入或卖出操作
      const hasBuyOrSell = finalSignals.some(
        (sig) =>
          sig.action === SignalType.BUYCALL ||
          sig.action === SignalType.BUYPUT ||
          sig.action === SignalType.SELLCALL ||
          sig.action === SignalType.SELLPUT
      );

      if (hasBuyOrSell) {
        // 检查是否有做多标的的交易（买入或卖出）
        const hasLongSymbolTrade = finalSignals.some(
          (sig) =>
            sig.action === SignalType.BUYCALL ||
            sig.action === SignalType.SELLCALL
        );
        if (hasLongSymbolTrade && longSymbol) {
          await orderRecorder.refreshOrders(longSymbol, true).catch((err) => {
            logger.warn(
              `[订单记录刷新失败] 做多标的 ${longSymbol}`,
              err?.message ?? err
            );
          });
        }

        // 检查是否有做空标的的交易（买入或卖出）
        const hasShortSymbolTrade = finalSignals.some(
          (sig) =>
            sig.action === SignalType.BUYPUT ||
            sig.action === SignalType.SELLPUT
        );
        if (hasShortSymbolTrade && shortSymbol) {
          await orderRecorder.refreshOrders(shortSymbol, false).catch((err) => {
            logger.warn(
              `[订单记录刷新失败] 做空标的 ${shortSymbol}`,
              err?.message ?? err
            );
          });
        }
      }
    }
  }

  // 返回是否有数据变化
  return hasChange;
}

/**
 * 显示账户和持仓信息（仅在交易后调用）
 * @param {Object} trader Trader实例
 * @param {Object} marketDataClient MarketDataClient实例
 * @param {Object} lastState 状态对象，用于更新缓存
 */
async function displayAccountAndPositions(trader, marketDataClient, lastState) {
  try {
    const account = await trader.getAccountSnapshot().catch((err) => {
      logger.warn("获取账户信息失败", err?.message ?? err);
      return null;
    });

    const positions = await trader.getStockPositions().catch((err) => {
      logger.warn("获取股票仓位失败", err?.message ?? err);
      return [];
    });

    // 更新缓存
    lastState.cachedAccount = account;
    lastState.cachedPositions = positions;

    // 显示账户和持仓信息
    if (account) {
      logger.info(
        `账户概览 [${account.currency}] 余额=${account.totalCash.toFixed(
          2
        )} 市值=${account.netAssets.toFixed(
          2
        )} 持仓市值≈${account.positionValue.toFixed(2)}`
      );
    }
    if (Array.isArray(positions) && positions.length > 0) {
      logger.info("股票持仓：");

      // 批量获取所有持仓标的的完整信息（包含中文名称和价格）
      const positionSymbols = positions.map((p) => p.symbol).filter(Boolean);
      const symbolInfoMap = new Map(); // key: normalizedSymbol, value: {name, price}
      if (positionSymbols.length > 0) {
        // 使用 getLatestQuote 获取每个标的的完整信息（包含 staticInfo 和中文名称）
        const quotePromises = positionSymbols.map((symbol) =>
          marketDataClient.getLatestQuote(symbol).catch((err) => {
            logger.warn(
              `[持仓监控] 获取标的 ${symbol} 信息失败: ${err?.message ?? err}`
            );
            return null;
          })
        );
        const quotes = await Promise.all(quotePromises);

        quotes.forEach((quote) => {
          if (quote?.symbol) {
            const normalizedSymbol = normalizeHKSymbol(quote.symbol);
            symbolInfoMap.set(normalizedSymbol, {
              name: quote.name ?? null,
              price: quote.price ?? null,
            });
          }
        });
      }

      // 计算总资产用于计算仓位百分比
      const totalAssets = account?.netAssets ?? 0;

      positions.forEach((pos) => {
        const normalizedPosSymbol = normalizeHKSymbol(pos.symbol);
        const symbolInfo = symbolInfoMap.get(normalizedPosSymbol);

        // 优先使用从行情 API 获取的中文名称，否则使用持仓数据中的名称，最后使用 "-"
        const nameText = symbolInfo?.name ?? pos.symbolName ?? "-";
        const codeText = normalizeHKSymbol(pos.symbol);

        // 获取当前价格（优先使用实时价格，否则使用成本价）
        const currentPrice = symbolInfo?.price ?? pos.costPrice ?? 0;

        // 计算持仓市值
        const posQuantity = Number(pos.quantity) || 0;
        const marketValue =
          Number.isFinite(currentPrice) && currentPrice > 0 && posQuantity > 0
            ? posQuantity * currentPrice
            : 0;

        // 计算仓位百分比
        const positionPercent =
          Number.isFinite(totalAssets) && totalAssets > 0 && marketValue > 0
            ? (marketValue / totalAssets) * 100
            : 0;

        // 构建价格显示文本
        const priceText =
          symbolInfo?.price !== null && symbolInfo?.price !== undefined
            ? `现价=${formatNumber(currentPrice, 3)}`
            : `成本价=${formatNumber(pos.costPrice, 3)}`;

        // 格式化账户渠道显示名称
        const channelDisplay = formatAccountChannel(pos.accountChannel);

        logger.info(
          `- [${channelDisplay}] ${nameText}(${codeText}) 持仓=${formatNumber(
            pos.quantity,
            2
          )} 可用=${formatNumber(
            pos.availableQuantity,
            2
          )} ${priceText} 市值=${formatNumber(
            marketValue,
            2
          )} 仓位=${formatNumber(positionPercent, 2)}% ${pos.currency ?? ""}`
        );
      });
    } else {
      logger.info("当前无股票持仓。");
    }
  } catch (err) {
    logger.warn("获取账户和持仓信息失败", err?.message ?? err);
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

  // 使用配置验证返回的标的名称和行情客户端实例（避免重复创建）
  const { monitorName, longName, shortName, marketDataClient } = symbolNames;
  const strategy = new HangSengMultiIndicatorStrategy();
  const trader = new Trader(config);
  const orderRecorder = new OrderRecorder(trader);

  // 初始化风险检查器
  const riskChecker = new RiskChecker();

  logger.info(
    `监控标的: ${monitorName}(${normalizeHKSymbol(
      TRADING_CONFIG.monitorSymbol
    )})`
  );
  logger.info(
    `做多标的: ${longName}(${normalizeHKSymbol(TRADING_CONFIG.longSymbol)})`
  );
  logger.info(
    `做空标的: ${shortName}(${normalizeHKSymbol(TRADING_CONFIG.shortSymbol)})`
  );
  logger.info("程序开始运行，在交易时段将进行实时监控和交易（按 Ctrl+C 退出）");

  // 预加载当月和下月的交易日信息到缓存
  const today = new Date();
  await marketDataClient.preloadTradingDaysForMonth(today);
  // 同时加载下个月的交易日信息（如果当前是月底）
  const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  await marketDataClient.preloadTradingDaysForMonth(nextMonth);

  // 初始化牛熊证信息（在程序启动时检查做多和做空标的是否为牛熊证）
  logger.info("[风险检查] 正在初始化牛熊证信息...");
  await riskChecker.initializeWarrantInfo(
    marketDataClient,
    TRADING_CONFIG.longSymbol,
    TRADING_CONFIG.shortSymbol
  );

  // 记录上一次的数据状态，用于检测变化
  let lastState = {
    longPrice: null,
    shortPrice: null,
    monitorPrice: null,
    signal: null,
    canTrade: null,
    isHalfDay: null, // 记录是否是半日交易日
    pendingDelayedSignals: [], // 待验证的延迟信号列表（每个信号有自己独立的verificationHistory）
    monitorValues: null, // 监控标的的所有指标值（price, vwap, rsi6, rsi12, kdj, macd）
    cachedAccount: null, // 缓存的账户信息（仅在交易后更新）
    cachedPositions: [], // 缓存的持仓信息（仅在交易后更新）
  };

  // 程序启动时立即获取一次账户和持仓信息
  await displayAccountAndPositions(trader, marketDataClient, lastState);

  // 程序启动时刷新订单记录
  const longSymbol = TRADING_CONFIG.longSymbol;
  const shortSymbol = TRADING_CONFIG.shortSymbol;
  if (longSymbol) {
    await orderRecorder.refreshOrders(longSymbol, true).catch((err) => {
      logger.warn(
        `[订单记录初始化失败] 做多标的 ${longSymbol}`,
        err?.message ?? err
      );
    });
  }
  if (shortSymbol) {
    await orderRecorder.refreshOrders(shortSymbol, false).catch((err) => {
      logger.warn(
        `[订单记录初始化失败] 做空标的 ${shortSymbol}`,
        err?.message ?? err
      );
    });
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

  // 无限循环监控（用户要求不设执行次数上限）
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const hasChange = await runOnce({
        marketDataClient,
        strategy,
        trader,
        candlePeriod,
        candleCount,
        lastState,
        orderRecorder,
        riskChecker,
      });

      // 更新状态
      if (hasChange) {
        // 状态已更新，继续下一次循环
      }
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
