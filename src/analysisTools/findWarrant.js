import {
  QuoteContext,
  Period,
  NaiveDate,
  TradeSessions,
  WarrantSortBy,
  SortOrderType,
  WarrantType,
  AdjustType,
  WarrantStatus,
  FilterWarrantExpiryDate,
} from "longport";
import { createConfig } from "../config/config.js";
import { TRADING_CONFIG } from "../config/config.trading.js";
import { normalizeHKSymbol, decimalToNumber, formatNumber } from "../utils.js";

// ==================== 配置参数 ====================
// 注意：修改以下配置后，需要重新运行程序才能生效

// ========== 监控标的配置 ==========
// 需要查找窝轮的监控标的代码（例如 "HSI.HK" 表示恒生指数）
// 优先级：命令行参数 > 环境变量 MONITOR_SYMBOL > 此配置 > config.trading.js 中的 monitorSymbol
const DEFAULT_MONITOR_SYMBOL = "HSI.HK"; // 默认监控标的

// ========== 筛选条件配置 ==========
// 距离回收价百分比阈值
// 牛证要求：监控标的当前价高于回收价，距离百分比必须大于此阈值
const BULL_DISTANCE_PERCENT_THRESHOLD = 2; // 单位：%，例如 2 表示 > 2%

// 熊证要求：监控标的当前价低于回收价，距离百分比必须小于此阈值
const BEAR_DISTANCE_PERCENT_THRESHOLD = -2; // 单位：%，例如 -2 表示 < -2%

// 成交额阈值（单位：HKD）
// 当日成交额阈值：用于初步筛选窝轮列表
const MIN_DAILY_TURNOVER = 10000000; // 2000万 = 20,000,000

// 三日内平均成交额阈值：用于详细检查每个窝轮
const MIN_AVG_TURNOVER = 10000000; // 2000万 = 20,000,000

// 过期日要求
// 只筛选过期日在指定月数以上的窝轮（API使用枚举值：Between_3_6, Between_6_12, GT_12）
const MIN_EXPIRY_MONTHS = 3; // 单位：月，例如 3 表示 >= 3个月

// ========== 性能配置 ==========
// 批量处理配置
// 每批并发处理的窝轮数量，用于避免API限流
// 建议值：20-50，可根据API响应速度和限流策略调整
const BATCH_SIZE = 50; // 每批处理数量
// ==================== 配置参数结束 ====================

/**
 * 计算回收价距离监控标的当前价的百分比
 * 参考 risk.js 中的计算公式
 * @param {number} callPrice 回收价
 * @param {number} monitorPrice 监控标的当前价
 * @returns {number} 百分比
 * 公式：(监控标的当前价 - 回收价) / 回收价 * 100
 */
function calculateDistancePercent(callPrice, monitorPrice) {
  if (
    !Number.isFinite(callPrice) ||
    !Number.isFinite(monitorPrice) ||
    callPrice === 0
  ) {
    return null;
  }
  return ((monitorPrice - callPrice) / callPrice) * 100;
}

/**
 * 计算三日内的平均成交额
 * @param {Array} candles K线数据数组
 * @returns {number|null} 平均成交额（HKD），如果数据不足则返回 null
 */
function calculateAverageTurnover(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  let totalTurnover = 0;
  let validDays = 0;

  for (const candle of candles) {
    let turnover =
      candle.turnover != null ? decimalToNumber(candle.turnover) : null;

    // 如果没有 turnover 字段或无效，使用 close * volume 计算
    if (!Number.isFinite(turnover) || turnover <= 0) {
      const close = decimalToNumber(candle.close);
      const volume = decimalToNumber(candle.volume);
      if (Number.isFinite(close) && Number.isFinite(volume) && volume > 0) {
        turnover = close * volume;
      } else {
        continue;
      }
    }

    totalTurnover += turnover;
    validDays++;
  }

  return validDays > 0 ? totalTurnover / validDays : null;
}

/**
 * 检查单个窝轮是否符合条件（通用函数，适用于牛证和熊证）
 * @param {Object} warrant 窝轮对象
 * @param {Object} ctx QuoteContext 实例
 * @param {number} monitorPrice 监控标的当前价
 * @param {NaiveDate} startDate 开始日期
 * @param {NaiveDate} endDate 结束日期
 * @param {boolean} isBull 是否为牛证（true=牛证，false=熊证）
 * @returns {Promise<Object|null>} 符合条件的窝轮信息，不符合则返回 null
 */
async function checkWarrant(
  warrant,
  ctx,
  monitorPrice,
  startDate,
  endDate,
  isBull
) {
  const warrantSymbol = warrant.symbol || warrant.code;
  if (!warrantSymbol) {
    return null;
  }

  try {
    // 获取 warrantQuote 获取回收价
    const warrantQuotes = await ctx.warrantQuote([warrantSymbol]);
    const warrantQuote = warrantQuotes?.[0];
    if (!warrantQuote) return null;

    // 获取回收价
    const callPriceNum = decimalToNumber(
      warrantQuote.call_price ?? warrantQuote.callPrice
    );
    if (!Number.isFinite(callPriceNum) || callPriceNum <= 0) return null;

    // 计算回收价距离监控标的当前价的百分比
    const distancePercent = calculateDistancePercent(
      callPriceNum,
      monitorPrice
    );
    if (distancePercent === null) return null;

    // 根据牛证/熊证判断距离百分比是否符合要求
    const threshold = isBull
      ? BULL_DISTANCE_PERCENT_THRESHOLD
      : BEAR_DISTANCE_PERCENT_THRESHOLD;
    if (
      isBull
        ? distancePercent <= 0 || distancePercent <= threshold
        : distancePercent >= 0 || distancePercent >= threshold
    ) {
      return null;
    }

    // 获取日K线数据
    const candles = await ctx.historyCandlesticksByDate(
      warrantSymbol,
      Period.Day,
      AdjustType.NoAdjust,
      startDate,
      endDate,
      TradeSessions.All
    );

    if (!Array.isArray(candles) || candles.length === 0) return null;

    // 计算平均成交额
    const avgTurnover = calculateAverageTurnover(candles);
    if (!Number.isFinite(avgTurnover) || avgTurnover < MIN_AVG_TURNOVER)
      return null;

    // 符合条件
    return {
      symbol: warrantSymbol,
      name: warrantQuote.name || warrant.name || warrantSymbol,
      callPrice: callPriceNum,
      distancePercent,
      avgTurnover,
      avgTurnoverInWan: avgTurnover / 10000,
    };
  } catch (err) {
    return null;
  }
}

/**
 * 批量并发处理窝轮检查（分批处理以避免API限流）
 * @param {Array} warrants 窝轮列表
 * @param {Function} checkFunction 检查函数（接受 warrant 作为参数）
 * @param {number} batchSize 每批处理的数量
 * @returns {Promise<Array>} 符合条件的窝轮列表
 */
async function checkWarrantsBatch(warrants, checkFunction, batchSize) {
  if (!warrants?.length) return [];

  const results = [];
  for (let i = 0; i < warrants.length; i += batchSize) {
    const batchResults = await Promise.all(
      warrants.slice(i, i + batchSize).map(checkFunction)
    );
    for (const result of batchResults) {
      if (result) results.push(result);
    }
  }
  return results;
}

/**
 * 获取符合条件的牛熊证
 * @param {string} monitorSymbol 监控标的代码（例如 "HSI.HK"）
 * @returns {Promise<{bullWarrants: Array, bearWarrants: Array}>} 符合条件的牛证和熊证列表
 */
async function findQualifiedWarrants(monitorSymbol) {
  try {
    // 创建配置
    const config = createConfig();

    // 初始化 QuoteContext
    const ctx = await QuoteContext.new(config);

    // 规范化监控标的代码
    const normalizedMonitorSymbol = normalizeHKSymbol(monitorSymbol);

    // 1. 获取监控标的的当前价
    const monitorQuotes = await ctx.quote([normalizedMonitorSymbol]);
    const monitorQuote = monitorQuotes?.[0];
    if (!monitorQuote) {
      throw new Error(`无法获取监控标的 ${normalizedMonitorSymbol} 的行情数据`);
    }

    const monitorPrice = decimalToNumber(monitorQuote.lastDone);
    if (!Number.isFinite(monitorPrice) || monitorPrice <= 0) {
      throw new Error(
        `监控标的 ${normalizedMonitorSymbol} 的当前价无效: ${monitorPrice}`
      );
    }

    // 2. 使用 warrantList API 获取窝轮列表（并行获取牛证和熊证）
    const expiryDateFilters = [
      FilterWarrantExpiryDate.Between_3_6,
      FilterWarrantExpiryDate.Between_6_12,
      FilterWarrantExpiryDate.GT_12,
    ];
    const commonParams = [
      normalizedMonitorSymbol,
      WarrantSortBy.ExpiryDate,
      SortOrderType.Ascending,
      undefined, // issuer
      expiryDateFilters,
      undefined, // priceType
      [WarrantStatus.Normal],
    ];

    const [bullWarrantList, bearWarrantList] = await Promise.all([
      ctx.warrantList(
        ...commonParams.slice(0, 3),
        [WarrantType.Bull],
        ...commonParams.slice(3)
      ),
      ctx.warrantList(
        ...commonParams.slice(0, 3),
        [WarrantType.Bear],
        ...commonParams.slice(3)
      ),
    ]);

    // 过滤：只保留当日成交额 >= MIN_DAILY_TURNOVER 的窝轮
    const filterByTurnover = (warrants) => {
      if (!Array.isArray(warrants)) return [];
      const result = [];
      for (const w of warrants) {
        const turnover = decimalToNumber(w.turnover);
        if (Number.isFinite(turnover) && turnover >= MIN_DAILY_TURNOVER) {
          result.push(w);
        }
      }
      return result;
    };

    const bullWarrants = filterByTurnover(bullWarrantList);
    const bearWarrants = filterByTurnover(bearWarrantList);

    // 3. 对每个牛证和熊证进行详细检查（回收价和成交额）
    // 提前计算日期范围（3天前到今天）
    const today = new Date();
    const threeDaysAgo = new Date(today.getTime() - 259200000); // 3 * 24 * 60 * 60 * 1000
    const toNaiveDate = (date) =>
      new NaiveDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
    const startDate = toNaiveDate(threeDaysAgo);
    const endDate = toNaiveDate(today);

    // 创建检查函数的绑定版本
    const checkBull = (w) =>
      checkWarrant(w, ctx, monitorPrice, startDate, endDate, true);
    const checkBear = (w) =>
      checkWarrant(w, ctx, monitorPrice, startDate, endDate, false);

    // 并行检查牛证和熊证（分批处理以避免API限流）
    const [qualifiedBullWarrants, qualifiedBearWarrants] = await Promise.all([
      checkWarrantsBatch(bullWarrants, checkBull, BATCH_SIZE),
      checkWarrantsBatch(bearWarrants, checkBear, BATCH_SIZE),
    ]);

    return {
      bullWarrants: qualifiedBullWarrants,
      bearWarrants: qualifiedBearWarrants,
    };
  } catch (err) {
    console.error(`[错误] 查找窝轮失败:`, err);
    throw err;
  }
}

/**
 * 主函数
 */
async function main() {
  try {
    // 从配置获取监控标的，优先级：命令行参数 > 环境变量 > 文件配置 > 交易配置
    const monitorSymbol =
      process.argv[2] ||
      process.env.MONITOR_SYMBOL ||
      DEFAULT_MONITOR_SYMBOL ||
      TRADING_CONFIG.monitorSymbol;

    if (!monitorSymbol) {
      console.error("错误: 未指定监控标的");
      console.error(
        "使用方法: node src/analysisTools/findWarrant.js <监控标的代码>"
      );
      console.error("例如: node src/analysisTools/findWarrant.js HSI.HK");
      console.error("或设置环境变量 MONITOR_SYMBOL");
      console.error("或在文件配置中设置 DEFAULT_MONITOR_SYMBOL 常量");
      process.exit(1);
    }

    const SEPARATOR = "=".repeat(60);
    const minAvgTurnoverWan = formatNumber(MIN_AVG_TURNOVER / 10000, 0);
    console.log(
      [
        SEPARATOR,
        "查找符合条件的牛熊证",
        SEPARATOR,
        `监控标的: ${monitorSymbol}`,
        `筛选条件:`,
        `  - 牛证: 过期日 >= ${MIN_EXPIRY_MONTHS}个月，三日内平均成交额 >= ${minAvgTurnoverWan}万，且距离百分比 > ${BULL_DISTANCE_PERCENT_THRESHOLD}%（监控标的当前价高于回收价）`,
        `  - 熊证: 过期日 >= ${MIN_EXPIRY_MONTHS}个月，三日内平均成交额 >= ${minAvgTurnoverWan}万，且距离百分比 < ${BEAR_DISTANCE_PERCENT_THRESHOLD}%（监控标的当前价低于回收价）`,
        SEPARATOR,
      ].join("\n")
    );

    const result = await findQualifiedWarrants(monitorSymbol);

    // 输出结果
    const printWarrants = (warrants, title) => {
      const lines = [`\n${SEPARATOR}`, title, SEPARATOR];
      if (warrants.length === 0) {
        lines.push(`无符合条件的${title.includes("牛证") ? "牛证" : "熊证"}`);
      } else {
        for (let i = 0; i < warrants.length; i++) {
          const w = warrants[i];
          lines.push(
            `\n${i + 1}. ${w.name} (${w.symbol})`,
            `   回收价: ${formatNumber(w.callPrice, 2)} HKD`,
            `   距离百分比: ${formatNumber(w.distancePercent, 2)}%`,
            `   三日内平均成交额: ${formatNumber(w.avgTurnoverInWan, 2)} 万 HKD`
          );
        }
      }
      console.log(lines.join("\n"));
    };

    printWarrants(result.bullWarrants, "符合条件的牛证:");
    printWarrants(result.bearWarrants, "符合条件的熊证:");
  } catch (err) {
    console.error("\n[致命错误]", err);
    process.exit(1);
  }
}

// 运行主函数
main().catch((error) => {
  console.error("程序执行失败：", error);
  process.exit(1);
});

export { findQualifiedWarrants };
