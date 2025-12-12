import dotenv from "dotenv";
import {
  Config,
  QuoteContext,
  Period,
  AdjustType,
  NaiveDate,
  TradeSessions,
} from "longport";
import { normalizeHKSymbol, decimalToNumber, formatNumber } from "../utils.js";
import { calculateRSI, calculateKDJ, calculateMACD } from "../indicators.js";

// 加载环境变量
dotenv.config();

// ============================================
// 配置变量（可直接修改）
// ============================================
// 默认标的代码（如果未通过环境变量或命令行参数指定）
const DEFAULT_SYMBOL = "HSI.HK";

// 默认日期（如果未通过环境变量或命令行参数指定）
// 格式：YYYY-MM-DD（例如：2024-12-11）
// 设置为 null 则必须通过环境变量或命令行参数指定
const DEFAULT_DATE = "2025-12-12"; // 例如：可以设置为 "2024-12-11"
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

  return formatted; // 返回 "HH:mm:ss" 格式
}

/**
 * 获取指定日期的分时线数据
 * @param {string} symbol 标的代码（例如：HSI.HK 或 700.HK）
 * @param {string} dateStr 日期字符串，格式：YYYY-MM-DD（例如：2024-12-11）
 * @returns {Promise<void>}
 */
async function getIntradayCandlesticks(symbol, dateStr) {
  try {
    // 创建配置
    const config = Config.fromEnv();

    // 初始化 QuoteContext
    const ctx = await QuoteContext.new(config);

    // 规范化标的代码
    const normalizedSymbol = normalizeHKSymbol(symbol);

    // 解析日期字符串
    const dateParts = dateStr.split("-");
    if (dateParts.length !== 3) {
      throw new Error(`日期格式错误，应为 YYYY-MM-DD，实际：${dateStr}`);
    }

    const year = parseInt(dateParts[0], 10);
    const month = parseInt(dateParts[1], 10);
    const day = parseInt(dateParts[2], 10);

    if (
      !Number.isFinite(year) ||
      !Number.isFinite(month) ||
      !Number.isFinite(day)
    ) {
      throw new Error(`日期解析失败：${dateStr}`);
    }

    // 创建指定日期
    const targetDate = new NaiveDate(year, month, day);

    // 计算前一天的日期（用于获取历史数据以计算指标）
    // MACD需要最多35根K线（26+9），获取前一天的数据应该足够
    const targetJsDate = new Date(year, month - 1, day); // JavaScript Date（月份从0开始）
    const previousJsDate = new Date(targetJsDate);
    previousJsDate.setDate(previousJsDate.getDate() - 1);

    const prevYear = previousJsDate.getFullYear();
    const prevMonth = previousJsDate.getMonth() + 1; // NaiveDate月份从1开始
    const prevDay = previousJsDate.getDate();
    const previousDate = new NaiveDate(prevYear, prevMonth, prevDay);

    console.log(
      `\n正在获取 ${normalizedSymbol} 在 ${dateStr} 的分时线数据...\n`
    );
    console.log(
      `同时获取前一天（${prevYear}-${String(prevMonth).padStart(
        2,
        "0"
      )}-${String(prevDay).padStart(2, "0")}）的数据以计算指标...\n`
    );

    // 获取前一天和当天的1分钟K线数据（分时线）
    // 先获取前一天的数据
    let previousCandlesticks = [];
    try {
      previousCandlesticks = await ctx.historyCandlesticksByDate(
        normalizedSymbol,
        Period.Min_1,
        AdjustType.NoAdjust,
        previousDate,
        previousDate,
        TradeSessions.All
      );
      if (previousCandlesticks && previousCandlesticks.length > 0) {
        console.log(
          `成功获取前一天 ${previousCandlesticks.length} 条分时线数据`
        );
      }
    } catch (err) {
      console.warn(
        `获取前一天数据失败（可能不是交易日），将仅使用当天数据：`,
        err?.message ?? err
      );
    }

    // 获取当天的1分钟K线数据（分时线）
    const todayCandlesticks = await ctx.historyCandlesticksByDate(
      normalizedSymbol,
      Period.Min_1, // 1分钟周期
      AdjustType.NoAdjust, // 不复权
      targetDate,
      targetDate,
      TradeSessions.All // 交易时段：所有时段
    );

    // 合并数据：前一天的数据在前，当天的数据在后
    const candlesticks = [
      ...(previousCandlesticks || []),
      ...(todayCandlesticks || []),
    ];

    if (!todayCandlesticks || todayCandlesticks.length === 0) {
      console.log(`未获取到 ${normalizedSymbol} 在 ${dateStr} 的分时线数据。`);
      console.log(`可能原因：`);
      console.log(`1. 该日期不是交易日`);
      console.log(`2. 该标的在该日期没有交易数据`);
      console.log(`3. 日期格式错误或日期超出可查询范围`);
      return;
    }

    // 记录当天数据的起始索引（用于后续只显示当天的数据）
    const todayStartIndex = previousCandlesticks?.length || 0;
    const todayCandlesticksCount = todayCandlesticks.length;

    // 输出结果
    console.log(
      `成功获取 ${todayCandlesticksCount} 条当天分时线数据（共 ${candlesticks.length} 条数据，包含前一天）\n`
    );

    // 定义列宽（使用固定宽度确保对齐）
    const colWidths = {
      time: 10, // 时间
      closeHeader: 12, // 收盘价
      closeRow: 17, // 收盘价
      rsi6: 8, // RSI6
      rsi12: 8, // RSI12
      kdjK: 8, // KDJ.K
      kdjD: 8, // KDJ.D
      kdjJ: 8, // KDJ.J
      macd: 10, // MACD
    };

    // 格式化列标题
    const formatHeader = (text, width) => {
      return text.padEnd(width, " ");
    };

    // 格式化数据列
    const formatCell = (text, width) => {
      return String(text).padEnd(width, " ");
    };

    // 打印表头
    const header = [
      formatHeader("时间", colWidths.time),
      formatHeader("收盘价", colWidths.closeHeader),
      formatHeader("RSI6", colWidths.rsi6),
      formatHeader("RSI12", colWidths.rsi12),
      formatHeader("KDJ.K", colWidths.kdjK),
      formatHeader("KDJ.D", colWidths.kdjD),
      formatHeader("KDJ.J", colWidths.kdjJ),
      formatHeader("MACD", colWidths.macd),
    ].join("  ");
    console.log(header);
    console.log("─".repeat(header.length));

    // 只为当天的数据计算指标值并显示（但使用包含前一天的所有数据来计算指标）
    // 遍历当天的数据（从 todayStartIndex 开始）
    for (let i = todayStartIndex; i < candlesticks.length; i++) {
      const candle = candlesticks[i];
      const timeStr = formatTimeHHMMSS(candle.timestamp);
      const close = formatNumber(decimalToNumber(candle.close), 2);

      // 获取到当前时间点为止的所有K线数据（包括前一天的数据，用于计算指标）
      const candlesUpToNow = candlesticks.slice(0, i + 1);

      // 计算RSI6和RSI12（需要收盘价数组）
      const closes = candlesUpToNow.map((c) => decimalToNumber(c.close));
      const rsi6 = calculateRSI(closes, 6);
      const rsi12 = calculateRSI(closes, 12);

      // 计算KDJ（需要完整的K线数据）
      const kdj = calculateKDJ(candlesUpToNow, 9);

      // 计算MACD（需要收盘价数组）
      const macd = calculateMACD(closes);

      // 格式化指标值显示
      const rsi6Str = rsi6 !== null ? formatNumber(rsi6, 2) : "-";
      const rsi12Str = rsi12 !== null ? formatNumber(rsi12, 2) : "-";
      const kdjKStr = kdj.k !== null ? formatNumber(kdj.k, 2) : "-";
      const kdjDStr = kdj.d !== null ? formatNumber(kdj.d, 2) : "-";
      const kdjJStr = kdj.j !== null ? formatNumber(kdj.j, 2) : "-";
      const macdStr = macd !== null ? formatNumber(macd.macd, 4) : "-";

      // 格式化数据行
      const row = [
        formatCell(timeStr, colWidths.time),
        formatCell(close, colWidths.closeRow),
        formatCell(rsi6Str, colWidths.rsi6),
        formatCell(rsi12Str, colWidths.rsi12),
        formatCell(kdjKStr, colWidths.kdjK),
        formatCell(kdjDStr, colWidths.kdjD),
        formatCell(kdjJStr, colWidths.kdjJ),
        formatCell(macdStr, colWidths.macd),
      ].join("  ");

      console.log(row);
    }

    console.log("\n" + "─".repeat(70));
    console.log(`总计：${todayCandlesticksCount} 条当天数据`);

    // 计算统计信息（仅使用当天的数据）
    if (todayCandlesticks.length > 0) {
      const firstCandle = todayCandlesticks[0];
      const lastCandle = todayCandlesticks[todayCandlesticks.length - 1];

      const firstTime = formatTimeHHMMSS(firstCandle.timestamp);
      const lastTime = formatTimeHHMMSS(lastCandle.timestamp);

      // 使用工具函数转换和格式化价格（仅使用当天的数据）
      const highest = Math.max(
        ...todayCandlesticks.map((c) => decimalToNumber(c.high))
      );
      const lowest = Math.min(
        ...todayCandlesticks.map((c) => decimalToNumber(c.low))
      );
      const firstOpen = decimalToNumber(firstCandle.open);
      const lastClose = decimalToNumber(lastCandle.close);

      console.log(`\n统计信息：`);
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
  const dateStr =
    process.argv[3] || process.env.INTRADAY_DATE || DEFAULT_DATE || null;

  if (!dateStr) {
    console.error("错误：未指定日期");
    console.error("\n使用方法：");
    console.error("  方式1：直接在代码中修改配置变量（推荐）");
    console.error("    修改文件顶部的 DEFAULT_SYMBOL 和 DEFAULT_DATE 变量");
    console.error('    例如：const DEFAULT_DATE = "2024-12-11";');
    console.error("\n  方式2：通过环境变量配置");
    console.error("    export INTRADAY_SYMBOL=HSI.HK");
    console.error("    export INTRADAY_DATE=2024-12-11");
    console.error("    node src/test/demoTest.js");
    console.error("\n  方式3：通过命令行参数");
    console.error("    node src/test/demoTest.js HSI.HK 2024-12-11");
    console.error("\n  方式4：在 .env 文件中配置");
    console.error("    INTRADAY_SYMBOL=HSI.HK");
    console.error("    INTRADAY_DATE=2024-12-11");
    console.error("    node src/test/demoTest.js");
    process.exit(1);
  }

  await getIntradayCandlesticks(symbol, dateStr);
}

// 运行主函数
main().catch((error) => {
  console.error("程序执行失败：", error);
  process.exit(1);
});
