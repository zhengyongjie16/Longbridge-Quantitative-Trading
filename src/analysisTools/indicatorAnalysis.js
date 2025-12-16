import {
  QuoteContext,
  Period,
  AdjustType,
  NaiveDate,
  TradeSessions,
  Market,
} from "longport";
import { normalizeHKSymbol, decimalToNumber, formatNumber } from "../utils.js";
import { RSI, MACD, EMA, MFI } from "technicalindicators";
import { TRADING_CONFIG } from "../config/config.trading.js";
import { createConfig } from "../config/config.js";

// ============================================
// 配置变量（可直接修改）
// ============================================
// 默认标的代码（如果未通过环境变量或命令行参数指定）
const DEFAULT_SYMBOL = "HSI.HK";

// 默认做多标的代码（如果未通过环境变量指定）
// 不带 .HK 后缀，内部会自动规范为港股
// 设置为 null 则从环境变量 LONG_SYMBOL 或 TRADING_CONFIG 获取
const DEFAULT_LONG_SYMBOL = "54806"; // 例如：可以设置为 "54806"

// 默认做空标的代码（如果未通过环境变量指定）
// 不带 .HK 后缀，内部会自动规范为港股
// 设置为 null 则从环境变量 SHORT_SYMBOL 或 TRADING_CONFIG 获取
const DEFAULT_SHORT_SYMBOL = "63372"; // 例如：可以设置为 "63372"

// 默认日期或日期范围（如果未通过环境变量或命令行参数指定）
// 格式：
//   - 单一日期：YYYY-MM-DD（例如：2024-12-11）
//   - 日期范围：YYYY-MM-DD:YYYY-MM-DD 或 YYYY-MM-DD,YYYY-MM-DD（例如：2024-12-11:2024-12-15）
// 设置为 null 则必须通过环境变量或命令行参数指定
const DEFAULT_DATE = "2025-12-16"; // 例如：可以设置为 "2024-12-11" 或 "2024-12-11:2024-12-15"
// ============================================

/**
 * 格式化时间为 HH:mm:ss 格式（香港时间）
 * 使用与代码库其他地方相同的 toLocaleString 方法，确保时区转换的一致性
 * 参考：index.js:235-237 使用相同的时区转换方法
 * @param {number|Date} timestamp 时间戳或日期对象
 * @returns {string} 格式化的时间字符串 HH:mm:ss
 */
function formatTimeHHMMSS(timestamp) {
  const ts =
    typeof timestamp === "number"
      ? timestamp
      : timestamp?.getTime?.() || Date.now();
  const date = new Date(ts);

  // 使用与代码库其他地方相同的时区转换方法（index.js:235-237）
  // 使用 toLocaleString 和 timeZone: "Asia/Hong_Kong" 确保准确的时区转换
  // 直接指定只返回时间部分，避免手动解析
  const formatted = date.toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Hong_Kong",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return formatted;
}

// 缓存日期格式化器，避免重复创建
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Hong_Kong",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * 格式化日期为 YYYY-MM-DD 格式（香港时间）
 * 使用缓存的 Intl.DateTimeFormat 确保时区转换的准确性
 * @param {number|Date|NaiveDate} timestamp 时间戳、日期对象或 NaiveDate
 * @returns {string} 格式化的日期字符串 YYYY-MM-DD
 */
function formatDateYYYYMMDD(timestamp) {
  // 如果是 NaiveDate 对象，直接格式化
  if (timestamp && typeof timestamp === "object" && "year" in timestamp) {
    const { year, month, day } = timestamp;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(
      2,
      "0"
    )}`;
  }

  const ts =
    typeof timestamp === "number"
      ? timestamp
      : timestamp?.getTime?.() || Date.now();
  const date = new Date(ts);

  const parts = dateFormatter.formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;

  if (!year || !month || !day) {
    // 如果格式化失败，使用备用方法
    const dateStr = date.toLocaleDateString("zh-CN", {
      timeZone: "Asia/Hong_Kong",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return dateStr.replaceAll("/", "-");
  }

  return `${year}-${month}-${day}`;
}

/**
 * 计算 RSI 指标
 * @param {number[]} closes 收盘价数组
 * @param {number} period RSI 周期
 * @returns {number|null} RSI 值，如果计算失败则返回 null
 */
function calculateRSI(closes, period) {
  if (closes.length <= period) {
    return null;
  }
  try {
    const rsiResult = RSI.calculate({ values: closes, period });
    if (rsiResult && rsiResult.length > 0) {
      const rsi = rsiResult.at(-1);
      // 确保 RSI 值在有效范围内（0-100）
      if (Number.isFinite(rsi) && rsi >= 0 && rsi <= 100) {
        return rsi;
      }
    }
  } catch (err) {
    // 静默处理错误，不影响程序运行
  }
  return null;
}

/**
 * 格式化指标值显示
 * @param {number|null|undefined} value 指标值
 * @param {number} decimals 小数位数
 * @returns {string} 格式化后的字符串，如果值为 null 或 undefined 则返回 "-"
 */
function formatIndicatorValue(value, decimals) {
  return value !== null && value !== undefined
    ? formatNumber(value, decimals)
    : "-";
}

/**
 * 使用 EMA 平滑数值数组
 * @param {number[]} values 待平滑的数值数组
 * @param {number} period EMA 周期
 * @param {number} initialValue 初始值
 * @returns {number[]} 平滑后的数值数组
 */
function smoothWithEMA(values, period, initialValue = 50) {
  const ema = new EMA({ period, values: [] });
  const smoothed = [];
  ema.nextValue(initialValue);
  for (const value of values) {
    const smoothedValue = ema.nextValue(value);
    if (smoothedValue !== undefined) {
      smoothed.push(smoothedValue);
    } else {
      smoothed.push(smoothed.at(-1) ?? initialValue);
    }
  }
  return smoothed;
}

/**
 * 计算 KDJ 指标
 * @param {number[]} closes 收盘价数组
 * @param {number[]} highs 最高价数组
 * @param {number[]} lows 最低价数组
 * @param {number} candlesLength K线数量
 * @returns {{k: number|null, d: number|null, j: number|null}} KDJ 指标值
 */
function calculateKDJIndicator(closes, highs, lows, candlesLength) {
  let kdj = { k: null, d: null, j: null };
  try {
    const KDJ_MIN_PERIOD = 9;
    if (candlesLength >= KDJ_MIN_PERIOD) {
      const period = 9;
      const emaPeriod = 5;

      // 计算所有 RSV 值（优化：使用循环查找最大值/最小值，避免展开操作）
      const rsvValues = [];
      for (let j = period - 1; j < candlesLength; j++) {
        const windowStart = j - period + 1;
        const close = closes[j];

        if (!Number.isFinite(close)) continue;

        // 使用循环查找最大值和最小值，避免 Math.max/min 展开操作
        let highestHigh = -Infinity;
        let lowestLow = Infinity;
        for (let k = windowStart; k <= j; k++) {
          const high = highs[k];
          const low = lows[k];
          if (Number.isFinite(high) && high > highestHigh) highestHigh = high;
          if (Number.isFinite(low) && low < lowestLow) lowestLow = low;
        }

        const range = highestHigh - lowestLow;
        if (!Number.isFinite(range) || range === 0) continue;

        const rsv = ((close - lowestLow) / range) * 100;
        rsvValues.push(rsv);
      }

      if (rsvValues.length > 0) {
        const kValues = smoothWithEMA(rsvValues, emaPeriod, 50);
        const dValues = smoothWithEMA(kValues, emaPeriod, 50);
        const k = kValues.at(-1);
        const d = dValues.at(-1);
        const j = 3 * k - 2 * d;

        if (Number.isFinite(k) && Number.isFinite(d) && Number.isFinite(j)) {
          kdj = { k, d, j };
        }
      }
    }
  } catch (err) {
    // 静默处理错误
  }
  return kdj;
}

/**
 * 计算 MACD 指标
 * @param {number[]} closes 收盘价数组
 * @returns {{macd: number}|null} MACD 指标值（仅返回 MACD 柱状图值）
 */
function calculateMACDIndicator(closes) {
  try {
    if (closes.length >= 35) {
      const macdResult = MACD.calculate({
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
      });
      if (macdResult?.length > 0) {
        const lastMacd = macdResult.at(-1);
        const macdValue = lastMacd.histogram * 2;

        if (Number.isFinite(macdValue)) {
          return { macd: macdValue };
        }
      }
    }
  } catch (err) {
    // 静默处理错误
  }
  return null;
}

/**
 * 计算 MFI 指标
 * @param {number[]} highs 最高价数组
 * @param {number[]} lows 最低价数组
 * @param {number[]} closes 收盘价数组
 * @param {number[]} volumes 成交量数组
 * @returns {number|null} MFI 指标值
 */
function calculateMFIIndicator(highs, lows, closes, volumes) {
  try {
    const mfiPeriod = 14;
    const minRequired = mfiPeriod + 1;
    if (
      highs.length >= minRequired &&
      lows.length >= minRequired &&
      closes.length >= minRequired &&
      volumes.length >= minRequired
    ) {
      const mfiResult = MFI.calculate({
        high: highs,
        low: lows,
        close: closes,
        volume: volumes,
        period: mfiPeriod,
      });
      if (mfiResult?.length > 0) {
        const mfiValue = mfiResult.at(-1);
        if (Number.isFinite(mfiValue) && mfiValue >= 0 && mfiValue <= 100) {
          return mfiValue;
        }
      }
    }
  } catch (err) {
    // 静默处理错误
  }
  return null;
}

/**
 * 计算所有技术指标（同步执行，避免不必要的 Promise 开销）
 * @param {number[]} closes 收盘价数组
 * @param {number[]} highs 最高价数组
 * @param {number[]} lows 最低价数组
 * @param {number[]} volumes 成交量数组
 * @param {number} candlesLength K线数量
 * @returns {Object} 包含所有指标值的对象
 */
function calculateAllIndicators(closes, highs, lows, volumes, candlesLength) {
  return {
    rsi6: calculateRSI(closes, 6),
    rsi12: calculateRSI(closes, 12),
    kdj: calculateKDJIndicator(closes, highs, lows, candlesLength),
    macd: calculateMACDIndicator(closes),
    mfi: calculateMFIIndicator(highs, lows, closes, volumes),
  };
}

/**
 * 解析日期范围字符串
 * 支持格式：
 * - 单一日期：YYYY-MM-DD（例如：2024-12-11）
 * - 日期范围：YYYY-MM-DD:YYYY-MM-DD 或 YYYY-MM-DD,YYYY-MM-DD（例如：2024-12-11:2024-12-15）
 * @param {string} dateRangeStr 日期范围字符串
 * @returns {{startDate: {year: number, month: number, day: number}, endDate: {year: number, month: number, day: number}}} 开始和结束日期对象
 * @throws {TypeError} 如果日期格式错误或解析失败
 */
function parseDateRange(dateRangeStr) {
  if (!dateRangeStr || typeof dateRangeStr !== "string") {
    throw new TypeError("日期范围字符串不能为空");
  }

  // 解析单个日期字符串
  const parseDateString = (dateStr) => {
    const dateParts = dateStr.split("-");
    if (dateParts.length !== 3) {
      throw new TypeError(`日期格式错误，应为 YYYY-MM-DD，实际：${dateStr}`);
    }
    const year = Number.parseInt(dateParts[0], 10);
    const month = Number.parseInt(dateParts[1], 10);
    const day = Number.parseInt(dateParts[2], 10);
    if (
      !Number.isFinite(year) ||
      !Number.isFinite(month) ||
      !Number.isFinite(day)
    ) {
      throw new TypeError(`日期解析失败：${dateStr}`);
    }
    return { year, month, day };
  };

  // 支持两种分隔符：冒号(:) 或逗号(,)
  const separator = dateRangeStr.includes(":") ? ":" : ",";
  const parts = dateRangeStr.split(separator).map((s) => s.trim());

  if (parts.length === 1) {
    // 单一日期，开始和结束日期相同
    const date = parseDateString(parts[0]);
    return { startDate: date, endDate: date };
  } else if (parts.length === 2) {
    // 日期范围
    const startDate = parseDateString(parts[0]);
    const endDate = parseDateString(parts[1]);

    // 验证结束日期不能早于开始日期
    const startJsDate = new Date(
      startDate.year,
      startDate.month - 1,
      startDate.day
    );
    const endJsDate = new Date(endDate.year, endDate.month - 1, endDate.day);
    if (endJsDate < startJsDate) {
      throw new TypeError(`结束日期不能早于开始日期：${dateRangeStr}`);
    }

    return { startDate, endDate };
  } else {
    throw new TypeError(
      `日期范围格式错误，应为 YYYY-MM-DD 或 YYYY-MM-DD:YYYY-MM-DD，实际：${dateRangeStr}`
    );
  }
}

/**
 * 获取日期范围内的交易日列表
 * @param {QuoteContext} ctx QuoteContext 实例
 * @param {NaiveDate} startDate 开始日期
 * @param {NaiveDate} endDate 结束日期
 * @param {Market} market 市场类型，默认为香港市场
 * @returns {Promise<NaiveDate[]>} 交易日列表（包括全日和半日交易日）
 */
async function getTradingDaysInRange(
  ctx,
  startDate,
  endDate,
  market = Market.HK
) {
  try {
    const resp = await ctx.tradingDays(market, startDate, endDate);
    // 合并全日交易日和半日交易日（半日交易日也算交易日）
    const allTradingDays = [
      ...(resp.tradingDays || []),
      ...(resp.halfTradingDays || []),
    ];
    // 按日期排序（优化：使用更简洁的比较）
    allTradingDays.sort((a, b) => {
      const yearDiff = a.year - b.year;
      if (yearDiff !== 0) return yearDiff;
      const monthDiff = a.month - b.month;
      if (monthDiff !== 0) return monthDiff;
      return a.day - b.day;
    });
    return allTradingDays;
  } catch (err) {
    console.warn(`获取交易日列表失败，将使用所有日期：`, err?.message ?? err);
    return [];
  }
}

/**
 * 获取指定日期之前的最后一个交易日
 * @param {QuoteContext} ctx QuoteContext 实例
 * @param {NaiveDate} date 指定日期
 * @param {Market} market 市场类型，默认为香港市场
 * @param {number} maxDaysBack 最多向前查找的天数（默认30天）
 * @returns {Promise<NaiveDate|null>} 上一个交易日，如果找不到则返回 null
 */
async function getPreviousTradingDay(
  ctx,
  date,
  market = Market.HK,
  maxDaysBack = 30
) {
  try {
    // 计算查询的开始日期（向前查找最多 maxDaysBack 天）
    const startJsDate = new Date(date.year, date.month - 1, date.day);
    startJsDate.setDate(startJsDate.getDate() - maxDaysBack);
    const startNaiveDate = new NaiveDate(
      startJsDate.getFullYear(),
      startJsDate.getMonth() + 1,
      startJsDate.getDate()
    );

    // 计算查询的结束日期（指定日期的前一天）
    const endJsDate = new Date(date.year, date.month - 1, date.day);
    endJsDate.setDate(endJsDate.getDate() - 1);
    const endNaiveDate = new NaiveDate(
      endJsDate.getFullYear(),
      endJsDate.getMonth() + 1,
      endJsDate.getDate()
    );

    // 获取这个日期范围内的交易日列表
    const tradingDays = await getTradingDaysInRange(
      ctx,
      startNaiveDate,
      endNaiveDate,
      market
    );

    if (tradingDays.length > 0) {
      // 返回最后一个交易日（最接近指定日期的交易日）
      return tradingDays.at(-1);
    }

    return null;
  } catch (err) {
    console.warn(`获取上一个交易日失败：`, err?.message ?? err);
    return null;
  }
}

/**
 * 将交易日列表分割成多个较小的范围（用于处理API的1000条限制）
 * @param {NaiveDate[]} tradingDays 交易日列表
 * @param {number} maxDaysPerBatch 每批最多天数（默认2天，约1000条1分钟K线）
 * @returns {Array<{start: NaiveDate, end: NaiveDate}>} 日期范围数组
 */
function splitTradingDaysIntoRanges(tradingDays, maxDaysPerBatch = 2) {
  if (tradingDays.length === 0) {
    return [];
  }

  const ranges = [];
  for (let i = 0; i < tradingDays.length; i += maxDaysPerBatch) {
    const batch = tradingDays.slice(i, i + maxDaysPerBatch);
    const start = batch[0];
    const end = batch.at(-1);
    ranges.push({ start, end });
  }

  return ranges;
}

/**
 * 获取标的的分时线数据（自动跳过非交易日，仅获取交易日的K线数据）
 * @param {QuoteContext} ctx QuoteContext 实例
 * @param {string} symbol 标的代码
 * @param {NaiveDate} startDate 开始日期
 * @param {NaiveDate} endDate 结束日期
 * @param {string} symbolName 标的名称（用于日志）
 * @returns {Promise<Array>} 分时线数据数组
 */
async function fetchSymbolCandlesticks(
  ctx,
  symbol,
  startDate,
  endDate,
  symbolName
) {
  try {
    const normalizedSymbol = normalizeHKSymbol(symbol);
    console.log(`正在获取${symbolName} ${normalizedSymbol} 的分时线数据...`);

    // 先获取日期范围内的交易日列表
    const tradingDays = await getTradingDaysInRange(ctx, startDate, endDate);

    if (tradingDays.length === 0) {
      console.warn(
        `日期范围内没有交易日，将尝试获取所有日期的数据（可能包含非交易日）`
      );
      // 如果没有交易日，回退到原来的逻辑
      const dateRanges = splitDateRange(startDate, endDate, 2);
      return await fetchCandlesticksByRanges(
        ctx,
        normalizedSymbol,
        dateRanges,
        symbolName
      );
    }

    console.log(
      `日期范围内共有 ${tradingDays.length} 个交易日，将自动跳过非交易日`
    );

    // 将交易日列表分割成多个批次（每批最多2天，避免超过1000条限制）
    const dateRanges = splitTradingDaysIntoRanges(tradingDays, 2);

    if (dateRanges.length > 1) {
      console.log(
        `将分 ${dateRanges.length} 批获取数据（每批最多2个交易日）...`
      );
    }

    return await fetchCandlesticksByRanges(
      ctx,
      normalizedSymbol,
      dateRanges,
      symbolName
    );
  } catch (err) {
    console.warn(`获取${symbolName}分时线数据失败：`, err?.message ?? err);
    return [];
  }
}

/**
 * 按日期范围批次获取K线数据（辅助函数）
 * @param {QuoteContext} ctx QuoteContext 实例
 * @param {string} normalizedSymbol 规范化后的标的代码
 * @param {Array<{start: NaiveDate, end: NaiveDate}>} dateRanges 日期范围数组
 * @param {string} symbolName 标的名称（用于日志）
 * @returns {Promise<Array>} 分时线数据数组
 */
async function fetchCandlesticksByRanges(
  ctx,
  normalizedSymbol,
  dateRanges,
  symbolName
) {
  const allCandlesticks = [];
  for (let i = 0; i < dateRanges.length; i++) {
    const { start, end } = dateRanges[i];
    const batchCandlesticks = await ctx.historyCandlesticksByDate(
      normalizedSymbol,
      Period.Min_1,
      AdjustType.NoAdjust,
      start,
      end,
      TradeSessions.All
    );

    if (batchCandlesticks && batchCandlesticks.length > 0) {
      allCandlesticks.push(...batchCandlesticks);

      // 如果返回的数据达到1000条，说明可能还有更多数据，需要进一步分割
      if (batchCandlesticks.length >= 1000) {
        console.warn(
          `警告：批次 ${i + 1} 返回了 ${
            batchCandlesticks.length
          } 条数据，可能达到API限制。如果数据不完整，请减小日期范围。`
        );
      }
    }

    // 添加短暂延迟，避免请求过于频繁
    if (i < dateRanges.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  if (allCandlesticks.length > 0) {
    console.log(
      `成功获取${symbolName} ${allCandlesticks.length} 条分时线数据（共 ${dateRanges.length} 批）`
    );
    return allCandlesticks;
  }
  console.warn(`未获取到${symbolName}的分时线数据`);
  return [];
}

/**
 * 将日期范围分割成多个较小的范围（用于处理API的1000条限制，回退方案）
 * @param {NaiveDate} startDate 开始日期
 * @param {NaiveDate} endDate 结束日期
 * @param {number} maxDaysPerBatch 每批最多天数（默认2天，约1000条1分钟K线）
 * @returns {Array<{start: NaiveDate, end: NaiveDate}>} 日期范围数组
 */
function splitDateRange(startDate, endDate, maxDaysPerBatch = 2) {
  // 内联比较函数
  const compare = (date1, date2) => {
    if (date1.year !== date2.year) return date1.year < date2.year ? -1 : 1;
    if (date1.month !== date2.month) return date1.month < date2.month ? -1 : 1;
    if (date1.day < date2.day) return -1;
    if (date1.day > date2.day) return 1;
    return 0;
  };

  const ranges = [];
  let currentStart = startDate;

  while (compare(currentStart, endDate) <= 0) {
    // 计算当前批次的结束日期
    let currentEnd = currentStart;
    for (
      let i = 1;
      i < maxDaysPerBatch && compare(currentEnd, endDate) < 0;
      i++
    ) {
      const nextDate = new Date(
        currentEnd.year,
        currentEnd.month - 1,
        currentEnd.day
      );
      nextDate.setDate(nextDate.getDate() + 1);
      currentEnd = new NaiveDate(
        nextDate.getFullYear(),
        nextDate.getMonth() + 1,
        nextDate.getDate()
      );
    }

    // 确保不超过结束日期
    if (compare(currentEnd, endDate) > 0) currentEnd = endDate;

    ranges.push({ start: currentStart, end: currentEnd });

    // 准备下一批的开始日期（当前结束日期的下一天）
    if (compare(currentEnd, endDate) >= 0) break;

    const nextStart = new Date(
      currentEnd.year,
      currentEnd.month - 1,
      currentEnd.day
    );
    nextStart.setDate(nextStart.getDate() + 1);
    currentStart = new NaiveDate(
      nextStart.getFullYear(),
      nextStart.getMonth() + 1,
      nextStart.getDate()
    );
  }

  return ranges;
}

/**
 * 获取指定日期范围的分时线数据
 * @param {string} symbol 标的代码（例如：HSI.HK 或 700.HK）
 * @param {string} dateRangeStr 日期范围字符串，格式：
 *   - 单一日期：YYYY-MM-DD（例如：2024-12-11）
 *   - 日期范围：YYYY-MM-DD:YYYY-MM-DD 或 YYYY-MM-DD,YYYY-MM-DD（例如：2024-12-11:2024-12-15）
 * @returns {Promise<void>}
 */
async function getIntradayCandlesticks(symbol, dateRangeStr) {
  try {
    // 创建配置
    const config = createConfig();

    // 初始化 QuoteContext
    const ctx = await QuoteContext.new(config);

    // 规范化标的代码
    const normalizedSymbol = normalizeHKSymbol(symbol);

    // 解析日期范围字符串
    const { startDate, endDate } = parseDateRange(dateRangeStr);

    // 创建开始和结束日期对象
    const startNaiveDate = new NaiveDate(
      startDate.year,
      startDate.month,
      startDate.day
    );
    const endNaiveDate = new NaiveDate(
      endDate.year,
      endDate.month,
      endDate.day
    );

    // 格式化日期字符串（使用统一的格式化函数）
    const startDateStr = formatDateYYYYMMDD(startNaiveDate);
    const endDateStr = formatDateYYYYMMDD(endNaiveDate);
    const dateRangeDisplayStr =
      startDateStr === endDateStr
        ? startDateStr
        : `${startDateStr} 至 ${endDateStr}`;

    console.log(
      `\n正在获取 ${normalizedSymbol} 在 ${dateRangeDisplayStr} 的分时线数据...\n`
    );

    // 获取开始日期之前的最后一个交易日（用于获取历史数据以计算指标）
    // MACD需要最多35根K线（26+9），获取上一个交易日的数据应该足够
    console.log(`正在查找开始日期之前的最后一个交易日...`);
    const previousTradingDay = await getPreviousTradingDay(
      ctx,
      startNaiveDate,
      Market.HK,
      30
    );

    let previousCandlesticks = [];
    if (previousTradingDay) {
      const prevDateStr = formatDateYYYYMMDD(previousTradingDay);
      console.log(
        `找到上一个交易日：${prevDateStr}，将获取该日期的数据以计算指标...\n`
      );

      // 获取上一个交易日的数据（用于计算指标）
      try {
        previousCandlesticks = await ctx.historyCandlesticksByDate(
          normalizedSymbol,
          Period.Min_1,
          AdjustType.NoAdjust,
          previousTradingDay,
          previousTradingDay,
          TradeSessions.All
        );
        if (previousCandlesticks && previousCandlesticks.length > 0) {
          console.log(
            `成功获取上一个交易日 ${previousCandlesticks.length} 条分时线数据`
          );
        }
      } catch (err) {
        console.warn(`获取上一个交易日数据失败：`, err?.message ?? err);
      }
    } else {
      console.log(`未找到上一个交易日，将仅使用日期范围内的数据计算指标...\n`);
    }

    // 获取日期范围内的1分钟K线数据（分时线）
    // 使用 fetchSymbolCandlesticks 函数，它会自动处理API的1000条限制
    const rangeCandlesticks = await fetchSymbolCandlesticks(
      ctx,
      normalizedSymbol,
      startNaiveDate,
      endNaiveDate,
      "监控标的"
    );

    // 合并数据：前一天的数据在前，日期范围内的数据在后
    const candlesticks = [
      ...(previousCandlesticks || []),
      ...(rangeCandlesticks || []),
    ];

    if (!rangeCandlesticks || rangeCandlesticks.length === 0) {
      console.log(
        `未获取到 ${normalizedSymbol} 在 ${dateRangeDisplayStr} 的分时线数据。`
      );
      console.log(`可能原因：`);
      console.log(`1. 该日期范围内没有交易日`);
      console.log(`2. 该标的在该日期范围内没有交易数据`);
      console.log(`3. 日期格式错误或日期超出可查询范围`);
      return;
    }

    // 记录日期范围内数据的起始索引（用于后续只显示日期范围内的数据）
    const rangeStartIndex = previousCandlesticks?.length || 0;
    const rangeCandlesticksCount = rangeCandlesticks.length;

    // 输出结果
    console.log(
      `成功获取 ${rangeCandlesticksCount} 条日期范围内分时线数据（共 ${candlesticks.length} 条数据，包含前一天）\n`
    );

    // 获取做多和做空标的的分时线数据（日期范围内数据，用于显示价格）
    // 优先级：代码配置 > 环境变量 > TRADING_CONFIG，确保转换为字符串
    const longSymbolRaw =
      DEFAULT_LONG_SYMBOL ||
      process.env.LONG_SYMBOL ||
      TRADING_CONFIG.longSymbol;
    const shortSymbolRaw =
      DEFAULT_SHORT_SYMBOL ||
      process.env.SHORT_SYMBOL ||
      TRADING_CONFIG.shortSymbol;
    const longSymbolStr = longSymbolRaw ? String(longSymbolRaw) : null;
    const shortSymbolStr = shortSymbolRaw ? String(shortSymbolRaw) : null;

    // 并发获取做多和做空标的的数据（日期范围）
    const [longCandlesticks, shortCandlesticks] = await Promise.all([
      longSymbolStr
        ? fetchSymbolCandlesticks(
            ctx,
            longSymbolStr,
            startNaiveDate,
            endNaiveDate,
            "做多标的"
          )
        : Promise.resolve([]),
      shortSymbolStr
        ? fetchSymbolCandlesticks(
            ctx,
            shortSymbolStr,
            startNaiveDate,
            endNaiveDate,
            "做空标的"
          )
        : Promise.resolve([]),
    ]);

    console.log("");

    // 创建做多和做空标的的价格映射（按时间戳索引，便于快速查找）
    const longPriceData = longCandlesticks.map((c) => ({
      timestamp: c.timestamp,
      price: decimalToNumber(c.close),
    }));
    const shortPriceData = shortCandlesticks.map((c) => ({
      timestamp: c.timestamp,
      price: decimalToNumber(c.close),
    }));

    // 创建价格查找器（优化：使用 Map 缓存精确匹配）
    const createPriceFinder = (priceData) => {
      if (!priceData || priceData.length === 0) return () => undefined;

      // 创建精确匹配的 Map 缓存
      const exactMatchMap = new Map();
      for (const item of priceData) {
        exactMatchMap.set(item.timestamp, item.price);
      }

      // 创建排序后的数组用于容差匹配（按时间戳排序）
      const sortedData = [...priceData].sort(
        (a, b) => a.timestamp - b.timestamp
      );
      const tolerance = 5000; // 5秒 = 5000毫秒

      return (targetTimestamp) => {
        // 先尝试精确匹配
        const exactPrice = exactMatchMap.get(targetTimestamp);
        if (exactPrice !== undefined) return exactPrice;

        // 如果精确匹配失败，查找最接近的时间戳（容差匹配）
        let closestItem = null;
        let minDiff = Infinity;

        for (const item of sortedData) {
          const diff = Math.abs(item.timestamp - targetTimestamp);
          if (diff <= tolerance && diff < minDiff) {
            minDiff = diff;
            closestItem = item;
          }
          // 如果已经超出容差范围且时间戳已经超过目标时间，可以提前退出
          if (item.timestamp > targetTimestamp + tolerance) break;
        }

        return closestItem ? closestItem.price : undefined;
      };
    };

    // 创建价格查找器
    const findLongPrice = createPriceFinder(longPriceData);
    const findShortPrice = createPriceFinder(shortPriceData);

    // 定义列宽（使用固定宽度确保对齐）
    const colWidths = {
      date: 12, // 日期
      time: 10, // 时间
      close: 12, // 收盘价（监控标的）
      longPrice: 12, // 做多标的价格
      shortPrice: 12, // 做空标的价格
      rsi6: 8, // RSI6
      rsi12: 8, // RSI12
      kdjK: 8, // KDJ.K
      kdjD: 8, // KDJ.D
      kdjJ: 8, // KDJ.J
      macd: 10, // MACD
      mfi: 8, // MFI
    };

    const rowWidths = {
      date: 14, // 日期
      time: 12, // 时间
      close: 15, // 收盘价（监控标的）
      longPrice: 16, // 做多标的价格
      shortPrice: 16, // 做空标的价格
      rsi6: 8, // RSI6
      rsi12: 8, // RSI12
      kdjK: 8, // KDJ.K
      kdjD: 8, // KDJ.D
      kdjJ: 8, // KDJ.J
      macd: 10, // MACD
      mfi: 8, // MFI
    };

    // 格式化列标题和数据列
    const formatHeader = (text, width) => text.padEnd(width, " ");
    const formatCell = (text, width) => String(text).padEnd(width, " ");

    // 打印表头
    const header = [
      formatHeader("日期", colWidths.date),
      formatHeader("时间", colWidths.time),
      formatHeader("收盘价", colWidths.close),
      formatHeader("做多标的", colWidths.longPrice),
      formatHeader("做空标的", colWidths.shortPrice),
      formatHeader("RSI6", colWidths.rsi6),
      formatHeader("RSI12", colWidths.rsi12),
      formatHeader("KDJ.K", colWidths.kdjK),
      formatHeader("KDJ.D", colWidths.kdjD),
      formatHeader("KDJ.J", colWidths.kdjJ),
      formatHeader("MACD", colWidths.macd),
      formatHeader("MFI", colWidths.mfi),
    ].join("  ");
    console.log(header);
    console.log("─".repeat(header.length + 15));

    // 预先提取所有数据数组，避免在循环中重复提取
    const allCloses = candlesticks.map((c) => decimalToNumber(c.close));
    const allHighs = candlesticks.map((c) => decimalToNumber(c.high));
    const allLows = candlesticks.map((c) => decimalToNumber(c.low));
    const allVolumes = candlesticks.map((c) => decimalToNumber(c.volume));

    // 遍历日期范围内的数据（从 rangeStartIndex 开始）
    for (let i = rangeStartIndex; i < candlesticks.length; i++) {
      const candle = candlesticks[i];
      const dateStr = formatDateYYYYMMDD(candle.timestamp);
      const timeStr = formatTimeHHMMSS(candle.timestamp);
      const close = formatNumber(decimalToNumber(candle.close), 2);

      // 获取做多和做空标的在当前时间点的价格（使用容差匹配）
      const longPrice = findLongPrice(candle.timestamp);
      const shortPrice = findShortPrice(candle.timestamp);
      const longPriceStr = formatIndicatorValue(longPrice, 3);
      const shortPriceStr = formatIndicatorValue(shortPrice, 3);

      // 使用切片获取到当前时间点为止的数据（避免重复创建数组）
      const closes = allCloses.slice(0, i + 1);
      const highs = allHighs.slice(0, i + 1);
      const lows = allLows.slice(0, i + 1);
      const volumes = allVolumes.slice(0, i + 1);

      // 计算所有技术指标（同步执行）
      const indicators = calculateAllIndicators(
        closes,
        highs,
        lows,
        volumes,
        i + 1
      );

      const { rsi6, rsi12, kdj, macd, mfi } = indicators;

      // 格式化指标值显示（使用通用函数）
      const rsi6Str = formatIndicatorValue(rsi6, 2);
      const rsi12Str = formatIndicatorValue(rsi12, 2);
      const kdjKStr = formatIndicatorValue(kdj.k, 2);
      const kdjDStr = formatIndicatorValue(kdj.d, 2);
      const kdjJStr = formatIndicatorValue(kdj.j, 2);
      const macdStr = formatIndicatorValue(macd?.macd, 4);
      const mfiStr = formatIndicatorValue(mfi, 2);

      // 格式化数据行
      const row = [
        formatCell(dateStr, rowWidths.date),
        formatCell(timeStr, rowWidths.time),
        formatCell(close, rowWidths.close),
        formatCell(longPriceStr, rowWidths.longPrice),
        formatCell(shortPriceStr, rowWidths.shortPrice),
        formatCell(rsi6Str, rowWidths.rsi6),
        formatCell(rsi12Str, rowWidths.rsi12),
        formatCell(kdjKStr, rowWidths.kdjK),
        formatCell(kdjDStr, rowWidths.kdjD),
        formatCell(kdjJStr, rowWidths.kdjJ),
        formatCell(macdStr, rowWidths.macd),
        formatCell(mfiStr, rowWidths.mfi),
      ].join("  ");

      console.log(row);
    }

    console.log("\n" + "─".repeat(70));
    console.log(`总计：${rangeCandlesticksCount} 条日期范围内数据`);

    // 计算统计信息（仅使用日期范围内的数据）
    if (rangeCandlesticks.length > 0) {
      const firstCandle = rangeCandlesticks[0];
      const lastCandle = rangeCandlesticks.at(-1);

      const firstTime = formatTimeHHMMSS(firstCandle.timestamp);
      const lastTime = formatTimeHHMMSS(lastCandle.timestamp);

      // 使用工具函数转换和格式化价格（仅使用日期范围内的数据）
      // 优化：使用循环替代 Math.max/min 展开操作，避免潜在的性能问题
      let highest = -Infinity;
      let lowest = Infinity;
      for (const c of rangeCandlesticks) {
        const high = decimalToNumber(c.high);
        const low = decimalToNumber(c.low);
        if (high > highest) highest = high;
        if (low < lowest) lowest = low;
      }
      const firstOpen = decimalToNumber(firstCandle.open);
      const lastClose = decimalToNumber(lastCandle.close);

      console.log(`\n统计信息：`);
      console.log(`日期范围：${dateRangeDisplayStr}`);
      console.log(`开始时间：${firstTime}`);
      console.log(`结束时间：${lastTime}`);
      console.log(`最高价：${formatNumber(highest, 2)}`);
      console.log(`最低价：${formatNumber(lowest, 2)}`);
      console.log(`开盘价：${formatNumber(firstOpen, 2)}`);
      console.log(`收盘价：${formatNumber(lastClose, 2)}`);
    }
  } catch (error) {
    console.error(`\n获取分时线数据失败：`, error.message || error);
    if (error.stack) {
      console.error(`错误堆栈：`, error.stack);
    }
    process.exit(1);
  }
}

// 主函数
async function main() {
  // 配置优先级（从高到低）：
  // 1. 命令行参数（process.argv[2], process.argv[3]）- 最高优先级，最灵活
  // 2. 环境变量（INTRADAY_SYMBOL, INTRADAY_DATE）
  // 3. 代码中的配置变量（DEFAULT_SYMBOL, DEFAULT_DATE）- 方便直接修改代码
  // 4. 默认值

  const symbol =
    process.argv[2] ||
    process.env.INTRADAY_SYMBOL ||
    DEFAULT_SYMBOL ||
    "HSI.HK";
  const dateRangeStr =
    process.argv[3] || process.env.INTRADAY_DATE || DEFAULT_DATE || null;

  if (!dateRangeStr) {
    console.error("错误：未指定日期或日期范围");
    console.error("\n使用方法：");
    console.error("  方式1：直接在代码中修改配置变量（推荐）");
    console.error("    修改文件顶部的 DEFAULT_SYMBOL 和 DEFAULT_DATE 变量");
    console.error('    例如：const DEFAULT_DATE = "2024-12-11";');
    console.error(
      '    或日期范围：const DEFAULT_DATE = "2024-12-11:2024-12-15";'
    );
    console.error("\n  方式2：通过环境变量配置");
    console.error("    export INTRADAY_SYMBOL=HSI.HK");
    console.error("    export INTRADAY_DATE=2024-12-11");
    console.error("    或日期范围：export INTRADAY_DATE=2024-12-11:2024-12-15");
    console.error("    node src/analysisTools/indicatorAnalysis.js");
    console.error("\n  方式3：通过命令行参数");
    console.error(
      "    单一日期：node src/analysisTools/indicatorAnalysis.js HSI.HK 2024-12-11"
    );
    console.error(
      "    日期范围：node src/analysisTools/indicatorAnalysis.js HSI.HK 2024-12-11:2024-12-15"
    );
    console.error("\n  方式4：在 .env 文件中配置");
    console.error("    INTRADAY_SYMBOL=HSI.HK");
    console.error("    INTRADAY_DATE=2024-12-11");
    console.error("    或日期范围：INTRADAY_DATE=2024-12-11:2024-12-15");
    console.error("    node src/analysisTools/indicatorAnalysis.js");
    console.error("\n日期格式说明：");
    console.error("  - 单一日期：YYYY-MM-DD（例如：2024-12-11）");
    console.error(
      "  - 日期范围：YYYY-MM-DD:YYYY-MM-DD 或 YYYY-MM-DD,YYYY-MM-DD（例如：2024-12-11:2024-12-15）"
    );
    process.exit(1);
  }

  await getIntradayCandlesticks(symbol, dateRangeStr);
}

// 运行主函数
main().catch((error) => {
  console.error("程序执行失败：", error);
  process.exit(1);
});
