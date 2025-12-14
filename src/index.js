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
import { verificationEntryPool, positionObjectPool } from "./objectPool.js";
import {
  normalizeHKSymbol,
  formatAccountChannel,
  formatNumber,
  getSymbolName,
  formatQuoteDisplay,
} from "./utils.js";

/**
 * 将UTC时间转换为香港时区（UTC+8）
 * @param {Date} date 时间对象（UTC时间）
 * @returns {{hkHour: number, hkMinute: number}|null} 香港时区的小时和分钟，如果date无效则返回null
 */
function getHKTime(date) {
  if (!date) return null;
  const utcHour = date.getUTCHours();
  const utcMinute = date.getUTCMinutes();
  return {
    hkHour: (utcHour + 8) % 24,
    hkMinute: utcMinute,
  };
}

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
  const hkTime = getHKTime(date);
  if (!hkTime) return false;
  const { hkHour, hkMinute } = hkTime;

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
 * 判断是否在当日收盘前15分钟内（末日保护程序：拒绝买入）
 * 港股正常交易日收盘时间：下午 16:00，收盘前15分钟：15:45 - 15:59
 * 港股半日交易日收盘时间：中午 12:00，收盘前15分钟：11:45 - 11:59
 * @param {Date} date 时间对象（应该是UTC时间）
 * @param {boolean} isHalfDay 是否是半日交易日
 * @returns {boolean} true表示在收盘前15分钟，false表示不在
 */
function isBeforeClose15Minutes(date, isHalfDay = false) {
  if (!date) return false;
  const hkTime = getHKTime(date);
  if (!hkTime) return false;
  const { hkHour, hkMinute } = hkTime;

  if (isHalfDay) {
    // 半日交易：收盘前15分钟为 11:45 - 11:59:59（12:00收盘）
    return hkHour === 11 && hkMinute >= 45;
  } else {
    // 正常交易日：收盘前15分钟为 15:45 - 15:59:59（16:00收盘）
    return hkHour === 15 && hkMinute >= 45;
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
  const hkTime = getHKTime(date);
  if (!hkTime) return false;
  const { hkHour, hkMinute } = hkTime;

  if (isHalfDay) {
    // 半日交易：收盘前5分钟为 11:55 - 11:59:59（12:00收盘）
    return hkHour === 11 && hkMinute >= 55;
  } else {
    // 正常交易日：收盘前5分钟为 15:55 - 15:59:59（16:00收盘）
    return hkHour === 15 && hkMinute >= 55;
  }
}

/**
 * 检查数值是否发生变化（超过阈值）
 * @param {number} current 当前值
 * @param {number} last 上次值
 * @param {number} threshold 变化阈值
 * @returns {boolean} true表示值发生变化，false表示未变化
 */
function hasChanged(current, last, threshold) {
  return (
    Number.isFinite(current) &&
    Number.isFinite(last) &&
    Math.abs(current - last) > threshold
  );
}

/**
 * 计算卖出信号的数量和原因（统一处理做多和做空标的的卖出逻辑）
 * @param {Object} position 持仓对象（包含 costPrice 和 availableQuantity）
 * @param {Object} quote 行情对象（包含 price）
 * @param {Object} orderRecorder 订单记录器实例
 * @param {string} direction 方向：'LONG'（做多）或 'SHORT'（做空）
 * @param {string} originalReason 原始信号原因
 * @returns {{quantity: number|null, shouldHold: boolean, reason: string}} 返回卖出数量和原因，shouldHold为true表示应跳过此信号
 */
function calculateSellQuantity(
  position,
  quote,
  orderRecorder,
  direction,
  originalReason
) {
  // 验证输入参数
  if (
    !position ||
    !Number.isFinite(position.costPrice) ||
    position.costPrice <= 0 ||
    !Number.isFinite(position.availableQuantity) ||
    position.availableQuantity <= 0 ||
    !quote ||
    !Number.isFinite(quote.price) ||
    quote.price <= 0
  ) {
    return {
      quantity: null,
      shouldHold: true,
      reason: `${originalReason || ""}，持仓或行情数据无效`,
    };
  }

  const currentPrice = quote.price;
  const costPrice = position.costPrice;
  const directionName = direction === "LONG" ? "做多标的" : "做空标的";

  // 当前价格高于持仓成本价，立即清仓所有持仓
  if (currentPrice > costPrice) {
    return {
      quantity: position.availableQuantity,
      shouldHold: false,
      reason: `${originalReason || ""}，当前价格${currentPrice.toFixed(
        3
      )}>成本价${costPrice.toFixed(3)}，立即清空所有${directionName}持仓`,
    };
  }

  // 当前价格没有高于持仓成本价，检查历史买入订单
  if (!orderRecorder) {
    return {
      quantity: null,
      shouldHold: true,
      reason: `${
        originalReason || ""
      }，但${directionName}价格${currentPrice.toFixed(
        3
      )}未高于成本价${costPrice.toFixed(3)}，且无法获取订单记录`,
    };
  }

  // 根据方向获取符合条件的买入订单
  const getBuyOrdersBelowPrice =
    direction === "LONG"
      ? orderRecorder.getLongBuyOrdersBelowPrice.bind(orderRecorder)
      : orderRecorder.getShortBuyOrdersBelowPrice.bind(orderRecorder);

  const buyOrdersBelowPrice = getBuyOrdersBelowPrice(currentPrice);

  if (!buyOrdersBelowPrice || buyOrdersBelowPrice.length === 0) {
    // 没有符合条件的订单，跳过此信号
    return {
      quantity: null,
      shouldHold: true,
      reason: `${
        originalReason || ""
      }，但${directionName}价格${currentPrice.toFixed(
        3
      )}未高于成本价${costPrice.toFixed(3)}，且没有买入价低于当前价的历史订单`,
    };
  }

  const totalQuantity =
    orderRecorder.calculateTotalQuantity(buyOrdersBelowPrice);

  if (totalQuantity > 0) {
    // 有符合条件的订单，卖出这些订单
    return {
      quantity: totalQuantity,
      shouldHold: false,
      reason: `${
        originalReason || ""
      }，但${directionName}价格${currentPrice.toFixed(
        3
      )}未高于成本价${costPrice.toFixed(
        3
      )}，卖出历史买入订单中买入价低于当前价的订单，共 ${totalQuantity} 股`,
    };
  } else {
    // 总数量为0，跳过此信号
    return {
      quantity: null,
      shouldHold: true,
      reason: `${
        originalReason || ""
      }，但${directionName}价格${currentPrice.toFixed(
        3
      )}未高于成本价${costPrice.toFixed(3)}，且没有买入价低于当前价的历史订单`,
    };
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
    // 如果获取交易日信息失败，继续使用时间判断（保守策略）
  }

  // 如果是交易日，再检查是否在交易时段
  const canTradeNow = isTradingDayToday && isInContinuousHKSession(currentTime);

  // 并发获取三个标的的行情（优化性能：从串行改为并发）
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

  // 如果获取到了行情数据，记录一下行情时间用于调试（仅在DEBUG模式下）
  if (process.env.DEBUG === "true" && longQuote?.timestamp) {
    const quoteTime = longQuote.timestamp;
    logger.debug(
      `[交易时段检查] 当前系统时间: ${currentTime.toISOString()}, 行情时间: ${quoteTime.toISOString()}, 是否在交易时段: ${canTradeNow}`
    );
  }

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

  // 检测价格变化，只在价格变化时显示
  const longPrice = longQuote?.price;
  const shortPrice = shortQuote?.price;

  // 检查做多标的价格是否变化（阈值：0.0001）
  const longPriceChanged =
    lastState.longPrice == null && Number.isFinite(longPrice)
      ? true // 首次出现价格
      : hasChanged(longPrice, lastState.longPrice, 0.0001);

  // 检查做空标的价格是否变化（阈值：0.0001）
  const shortPriceChanged =
    lastState.shortPrice == null && Number.isFinite(shortPrice)
      ? true // 首次出现价格
      : hasChanged(shortPrice, lastState.shortPrice, 0.0001);

  if (longPriceChanged || shortPriceChanged) {
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

    // 更新价格状态（只更新有效价格，避免将 undefined 写入状态）
    if (Number.isFinite(longPrice)) {
      lastState.longPrice = longPrice;
    }
    if (Number.isFinite(shortPrice)) {
      lastState.shortPrice = shortPrice;
    }
  }

  // 获取监控标的的K线数据（用于计算指标和生成信号）
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

  // 检测监控标的的价格变化并实时显示（只检测价格变化）
  if (monitorSnapshot) {
    const currentPrice = monitorSnapshot.price;
    const lastPrice = lastState.monitorValues?.price;

    // 检查监控标的的价格是否发生变化（只检测价格变化）
    const isFirstTime = lastPrice == null && Number.isFinite(currentPrice);
    const hasPriceChanged =
      isFirstTime || hasChanged(currentPrice, lastPrice, 0.0001);

    if (hasPriceChanged) {
      // 只显示价格变化
      if (Number.isFinite(currentPrice)) {
        logger.info(
          `[监控标的] ${monitorSymbolName}(${normalizedMonitorSymbol}) 价格=${currentPrice.toFixed(
            3
          )}`
        );
      }

      // 更新保存的价格值（只保存有效价格，用于下次比较）
      if (Number.isFinite(currentPrice)) {
        lastState.monitorValues = {
          price: currentPrice,
        };
      }
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
              // 从对象池获取条目对象，减少内存分配
              const entry = verificationEntryPool.acquire();
              entry.timestamp = now;
              entry.j = currentJ;
              entry.macd = currentMACD;

              // 记录当前值
              pendingSignal.verificationHistory.push(entry);

              // 只保留最近2分钟的数据（120秒），避免内存占用过大
              const twoMinutesAgo = now.getTime() - 120 * 1000;
              const oldEntries = pendingSignal.verificationHistory.filter(
                (entry) => entry.timestamp.getTime() < twoMinutesAgo
              );
              // 释放过期条目回对象池
              verificationEntryPool.releaseAll(oldEntries);
              // 保留有效条目
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
        // 使用对象池获取持仓对象
        longPosition = positionObjectPool.acquire();
        longPosition.symbol = pos.symbol;
        longPosition.costPrice = Number(pos.costPrice) || 0;
        longPosition.quantity = Number(pos.quantity) || 0;
        longPosition.availableQuantity = availableQty;
      } else if (normalizedPosSymbol === normalizedShortSymbol) {
        // 使用对象池获取持仓对象
        shortPosition = positionObjectPool.acquire();
        shortPosition.symbol = pos.symbol;
        shortPosition.costPrice = Number(pos.costPrice) || 0;
        shortPosition.quantity = Number(pos.quantity) || 0;
        shortPosition.availableQuantity = availableQty;
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

  // 释放持仓对象回池（信号生成完成后不再需要）
  if (longPosition) {
    positionObjectPool.release(longPosition);
    longPosition = null;
  }
  if (shortPosition) {
    positionObjectPool.release(shortPosition);
    shortPosition = null;
  }

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
        // 清空该信号的历史记录并释放对象回池
        if (pendingSignal.verificationHistory) {
          verificationEntryPool.releaseAll(pendingSignal.verificationHistory);
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
        // 清空该信号的历史记录并释放对象回池
        if (pendingSignal.verificationHistory) {
          verificationEntryPool.releaseAll(pendingSignal.verificationHistory);
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
        // 清空该信号的历史记录并释放对象回池
        if (pendingSignal.verificationHistory) {
          verificationEntryPool.releaseAll(pendingSignal.verificationHistory);
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
        // 清空该信号的历史记录并释放对象回池
        if (pendingSignal.verificationHistory) {
          verificationEntryPool.releaseAll(pendingSignal.verificationHistory);
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
        // 清空该信号的历史记录并释放对象回池
        if (pendingSignal.verificationHistory) {
          verificationEntryPool.releaseAll(pendingSignal.verificationHistory);
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
      } else {
        const actionDesc = isBuyCall ? "买入做多" : "买入做空";
        logger.info(
          `[延迟验证失败] ${pendingSignal.symbol} ${verificationReason}，不执行${actionDesc}`
        );
      }

      // 清空该信号的历史记录并释放对象回池
      if (pendingSignal.verificationHistory) {
        verificationEntryPool.releaseAll(pendingSignal.verificationHistory);
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
      // 清空该信号的历史记录并释放对象回池
      if (pendingSignal.verificationHistory) {
        verificationEntryPool.releaseAll(pendingSignal.verificationHistory);
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
        `[监控标的信号] ${monitorSymbolName}(${normalizedMonitorSymbol}) 无交易信号`
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
  const shouldEnableDoomsdayProtection = TRADING_CONFIG.doomsdayProtection;
  const isBeforeClose = isBeforeClose5Minutes(currentTime, isHalfDayToday);

  let finalSignals = [];

  if (
    shouldEnableDoomsdayProtection &&
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
      // 性能优化：在循环开始时缓存常用的计算结果，避免重复调用
      const normalizedSigSymbol = normalizeHKSymbol(sig.symbol);
      const sigName = getSymbolName(
        sig.symbol,
        longSymbol,
        shortSymbol,
        longSymbolName,
        shortSymbolName
      );

      // 获取标的的当前价格用于计算持仓市值
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
        // 买入操作检查顺序：
        // 1. 先检查交易频率限制（若不通过直接拒绝，不进行后续检查）
        // 2. 再检查末日保护程序
        // 3. 再检查牛熊证风险
        // 4. 最后进行基础风险检查（浮亏检查和市值限制检查）

        // 1. 检查交易频率限制（先检查，若不通过直接拒绝）
        if (!trader._canTradeNow(sig.action)) {
          const direction =
            sig.action === SignalType.BUYCALL ? "做多标的" : "做空标的";
          const directionKey =
            sig.action === SignalType.BUYCALL ? "LONG" : "SHORT";
          const lastTime = trader._lastBuyTime.get(directionKey);
          const waitSeconds = lastTime
            ? Math.ceil((60 * 1000 - (Date.now() - lastTime)) / 1000)
            : 0;
          logger.warn(
            `[交易频率限制] ${direction} 在1分钟内已买入过，需等待 ${waitSeconds} 秒后才能再次买入：${sigName}(${normalizedSigSymbol}) ${sig.action}`
          );
          continue; // 跳过这个买入信号，不进行后续检查
        }

        // 2. 末日保护程序：收盘前15分钟拒绝买入（卖出操作不受影响）
        const shouldEnableDoomsdayProtection = TRADING_CONFIG.doomsdayProtection;
        const isBeforeClose15 = isBeforeClose15Minutes(
          currentTime,
          isHalfDayToday
        );
        if (shouldEnableDoomsdayProtection && isBeforeClose15) {
          const closeTimeRange = isHalfDayToday ? "11:45-12:00" : "15:45-16:00";
          logger.warn(
            `[末日保护程序] 收盘前15分钟内拒绝买入：${sigName}(${normalizedSigSymbol}) ${sig.action} - 当前时间在${closeTimeRange}范围内`
          );
          continue; // 跳过这个买入信号
        }

        // 3. 仅在买入时检查牛熊证风险
        // 注意：使用监控标的的实时价格（而非牛熊证本身的价格）来计算距离回收价的百分比
        // 优先使用实时行情价格，如果没有则使用K线收盘价
        const monitorCurrentPrice =
          monitorQuote?.price ?? monitorSnapshot?.price ?? null;

        // 检查牛熊证风险
        const warrantRiskResult = riskChecker.checkWarrantRisk(
          sig.symbol,
          sig.action,
          monitorCurrentPrice
        );

        if (!warrantRiskResult.allowed) {
          logger.warn(
            `[牛熊证风险拦截] 信号被牛熊证风险控制拦截：${sigName}(${normalizedSigSymbol}) ${sig.action} - ${warrantRiskResult.reason}`
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
      // 卖出操作（平仓）时不检查交易频率限制、末日保护程序和牛熊证风险

      // 4. 基础风险检查前，实时获取最新账户和持仓信息以确保准确性
      // 对于买入操作，必须实时获取最新数据以确保浮亏计算准确
      // 对于卖出操作，可以使用缓存数据（卖出操作不检查浮亏限制）
      // 注意：isBuyAction 已在上面定义，这里直接使用
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
      // 包括：浮亏检查（仅买入操作）和持仓市值限制检查（所有操作）
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
        logger.warn(
          `[风险拦截] 信号被风险控制拦截：${sigName}(${normalizedSigSymbol}) ${sig.action} - ${riskResult.reason}`
        );
      }
    }
  }

  // 只在有交易信号时显示执行信息（信号变化时已显示）
  if (finalSignals.length > 0) {
    for (const sig of finalSignals) {
      // 性能优化：在循环开始时缓存常用的计算结果
      const normalizedSigSymbol = normalizeHKSymbol(sig.symbol);
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
    // 有信号但不在交易时段

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
    logger.info(`执行交易：共 ${finalSignals.length} 个交易信号`);

    // 对卖出信号进行成本价判断和卖出数量计算
    for (const sig of finalSignals) {
      if (sig.action === SignalType.SELLCALL) {
        // 卖出做多标的：判断成本价并计算卖出数量
        const result = calculateSellQuantity(
          longPosition,
          longQuote,
          orderRecorder,
          "LONG",
          sig.reason
        );
        if (result.shouldHold) {
          sig.action = SignalType.HOLD;
          sig.reason = result.reason;
        } else {
          sig.quantity = result.quantity;
          sig.reason = result.reason;
        }
      } else if (sig.action === SignalType.SELLPUT) {
        // 卖出做空标的：判断成本价并计算卖出数量
        const result = calculateSellQuantity(
          shortPosition,
          shortQuote,
          orderRecorder,
          "SHORT",
          sig.reason
        );
        if (result.shouldHold) {
          sig.action = SignalType.HOLD;
          sig.reason = result.reason;
        } else {
          sig.quantity = result.quantity;
          sig.reason = result.reason;
        }
      }
    }

    // 过滤掉被设置为HOLD的信号
    const signalsToExecute = finalSignals.filter(
      (sig) => sig.action !== SignalType.HOLD
    );

    if (signalsToExecute.length > 0) {
      await trader.executeSignals(signalsToExecute);
    } else {
      logger.info("所有卖出信号因成本价判断被跳过，无交易执行");
    }

    // 交易后获取并显示账户和持仓信息（仅显示一次）
    await displayAccountAndPositions(trader, marketDataClient, lastState);

    // 交易后刷新订单记录（买入或卖出做多/做空标的时都需要刷新）
    // 注意：只刷新实际执行的交易（signalsToExecute），不包括被设置为HOLD的信号
    if (orderRecorder && signalsToExecute.length > 0) {
      const longSymbol = TRADING_CONFIG.longSymbol;
      const shortSymbol = TRADING_CONFIG.shortSymbol;

      // 检查是否有做多标的的交易（买入或卖出）
      const hasLongSymbolTrade = signalsToExecute.some(
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
      const hasShortSymbolTrade = signalsToExecute.some(
        (sig) =>
          sig.action === SignalType.BUYPUT || sig.action === SignalType.SELLPUT
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

  // 初始化牛熊证信息（在程序启动时检查做多和做空标的是否为牛熊证）
  await riskChecker.initializeWarrantInfo(
    marketDataClient,
    TRADING_CONFIG.longSymbol,
    TRADING_CONFIG.shortSymbol
  );

  // 记录上一次的数据状态，用于检测变化
  let lastState = {
    longPrice: null,
    shortPrice: null,
    signal: null,
    canTrade: null,
    isHalfDay: null, // 记录是否是半日交易日
    pendingDelayedSignals: [], // 待验证的延迟信号列表（每个信号有自己独立的verificationHistory）
    monitorValues: null, // 监控标的的价格值（仅保存价格用于变化检测）
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
      await runOnce({
        marketDataClient,
        strategy,
        trader,
        candlePeriod,
        candleCount,
        lastState,
        orderRecorder,
        riskChecker,
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
