/**
 * 牛熊证搜索工具
 *
 * 功能：
 * - 根据条件搜索符合条件的牛熊证
 * - 支持按成交额、距离回收价、到期日等筛选
 * - 格式化输出搜索结果
 *
 * 筛选条件：
 * - 距离回收价百分比（牛证 > 2%，熊证 < -2%）
 * - 成交额阈值（三日内每日成交额都需 > 1000万）
 * - 上市天数（至少上市三日，过滤新上市品种）
 * - 到期日要求（剩余 > 3个月）
 *
 * 排序规则：
 * - 牛证：按距离回收价从小到大排序（离回收价越近越靠前）
 * - 熊证：按距离回收价从大到小排序（离回收价越近越靠前）
 *
 * 运行方式：
 * npm run find-warrant
 *
 * 相关配置：
 * - MONITOR_SYMBOL：监控标的代码
 * - 可在文件中修改筛选参数
 */

import {
  QuoteContext,
  Period,
  WarrantSortBy,
  SortOrderType,
  WarrantType,
  AdjustType,
  WarrantStatus,
  FilterWarrantExpiryDate,
  TradeSessions,
} from 'longport';
import { createConfig } from '../src/config/config.index.js';
import { MULTI_MONITOR_TRADING_CONFIG } from '../src/config/config.trading.js';
import {
  normalizeHKSymbol,
  decimalToNumber,
  formatNumber,
} from '../src/utils/helpers/index.js';

// ==================== 类型定义 ====================
type DecimalLikeValue = string | number | null;

// ==================== 配置参数 ====================
// 注意：修改以下配置后，需要重新运行程序才能生效

// ========== 监控标的配置 ==========
// 需要查找窝轮的监控标的代码（例如 "HSI.HK" 表示恒生指数）
// 优先级：命令行参数 > 环境变量 MONITOR_SYMBOL > 此配置 > config.trading.js 中的 monitorSymbol
const DEFAULT_MONITOR_SYMBOL = 'HSI.HK'; // 默认监控标的

// ========== 筛选条件配置 ==========
// 距离回收价百分比阈值
// 牛证要求：监控标的当前价高于回收价，距离百分比必须大于此阈值
const BULL_DISTANCE_PERCENT_THRESHOLD = 2; // 单位：%，例如 2 表示 > 2%

// 熊证要求：监控标的当前价低于回收价，距离百分比必须小于此阈值
const BEAR_DISTANCE_PERCENT_THRESHOLD = -2; // 单位：%，例如 -2 表示 < -2%

// 成交额阈值（单位：HKD）
// 当日成交额阈值：用于初步筛选窝轮列表
const MIN_DAILY_TURNOVER = 8000000; // 1000万 = 10,000,000

// 三日内每日成交额阈值：用于详细检查每个窝轮，要求三日内每日成交额都必须高于此阈值
const MIN_AVG_TURNOVER = 8000000; // 1000万 = 10,000,000

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
 * 窝轮基本信息接口
 */
interface WarrantInfo {
  symbol?: string;
  code?: string;
  name?: string;
  turnover?: unknown;
}

/**
 * 符合条件的窝轮结果接口
 */
interface QualifiedWarrant {
  symbol: string;
  name: string;
  callPrice: number;
  distancePercent: number;
  avgTurnover: number;
  avgTurnoverInWan: number;
}

/**
 * K线数据接口
 */
interface CandleData {
  turnover?: unknown;
  close?: unknown;
  volume?: unknown;
  timestamp?: Date;
}

/**
 * 查找结果接口
 */
interface FindWarrantsResult {
  bullWarrants: QualifiedWarrant[];
  bearWarrants: QualifiedWarrant[];
}

/**
 * 计算回收价距离监控标的当前价的百分比
 * 参考 risk.js 中的计算公式
 * @param callPrice 回收价
 * @param monitorPrice 监控标的当前价
 * @returns 百分比
 * 公式：(监控标的当前价 - 回收价) / 回收价 * 100
 */
function calculateDistancePercent(
  callPrice: number,
  monitorPrice: number,
): number | null {
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
 * 检查最近三日的每日成交额是否都高于指定阈值
 * @param candles K线数据数组
 * @param minTurnover 最低成交额阈值
 * @returns 如果最近三根K线的成交额都高于阈值则返回平均成交额，否则返回 null
 */
function checkDailyTurnover(candles: CandleData[], minTurnover: number): number | null {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  // 检查K线数量，过滤上市不到三日的牛熊证
  if (candles.length < 3) {
    return null;
  }

  // 只取最近三根K线
  const recentCandles = candles.slice(-3);

  let totalTurnover = 0;
  let validDays = 0;

  for (const candle of recentCandles) {
    let turnover: number | null =
      candle.turnover == null ? null : decimalToNumber(candle.turnover as DecimalLikeValue);

    // 如果没有 turnover 字段或无效，使用 close * volume 计算
    if (!Number.isFinite(turnover) || (turnover !== null && turnover <= 0)) {
      const close = decimalToNumber(candle.close as DecimalLikeValue);
      const volume = decimalToNumber(candle.volume as DecimalLikeValue);
      if (Number.isFinite(close) && Number.isFinite(volume) && volume > 0) {
        turnover = close * volume;
      } else {
        continue; // 跳过无效数据
      }
    }

    // TypeScript类型守卫：此时 turnover 必定是有效数字
    if (turnover === null || !Number.isFinite(turnover)) {
      continue;
    }

    // 此时 turnover 已被类型守卫确认为 number
    // 检查当天成交额是否低于阈值
    if (turnover < minTurnover) {
      return null; // 任何一天低于阈值，直接返回 null
    }

    totalTurnover += turnover;
    validDays++;
  }

  // 必须有完整的三个交易日数据，且每日成交额都达标
  return validDays === 3 ? totalTurnover / validDays : null;
}

/**
 * 检查单个窝轮是否符合条件（通用函数，适用于牛证和熊证）
 * @param warrant 窝轮对象
 * @param ctx QuoteContext 实例
 * @param monitorPrice 监控标的当前价
 * @param isBull 是否为牛证（true=牛证，false=熊证）
 * @returns 符合条件的窝轮信息，不符合则返回 null
 */
async function checkWarrant(
  warrant: WarrantInfo,
  ctx: QuoteContext,
  monitorPrice: number,
  isBull: boolean,
): Promise<QualifiedWarrant | null> {
  const warrantSymbol = warrant.symbol || warrant.code;
  if (!warrantSymbol) {
    return null;
  }

  try {
    // 获取 warrantQuote 获取回收价
    const warrantQuotes = await ctx.warrantQuote([warrantSymbol]);
    const warrantQuote = warrantQuotes?.[0] as {
      call_price?: unknown;
      callPrice?: unknown;
      name?: string;
    } | null;
    if (!warrantQuote) return null;

    // 获取回收价
    const callPriceNum = decimalToNumber(
      (warrantQuote.call_price ?? warrantQuote.callPrice) as DecimalLikeValue,
    );
    if (!Number.isFinite(callPriceNum) || callPriceNum <= 0) return null;

    // 计算回收价距离监控标的当前价的百分比
    const distancePercent = calculateDistancePercent(
      callPriceNum,
      monitorPrice,
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

    // 获取日K线数据（获取最近10根K线，从最新交易日向历史查询）
    // 参数说明：
    // - symbol: 标的代码
    // - Period.Day: 日K线
    // - AdjustType.NoAdjust: 不复权
    // - false: 向历史方向查询（true=向未来，false=向历史）
    // - null: 从最新交易日开始查询
    // - 10: 查询10根K线
    // - TradeSessions.Intraday: 日内交易时段
    const candles = await ctx.historyCandlesticksByOffset(
      warrantSymbol,
      Period.Day,
      AdjustType.NoAdjust,
      false,
      null,
      10,
      TradeSessions.Intraday,
    );

    if (!Array.isArray(candles) || candles.length === 0) return null;

    // 检查最近三根K线的成交额是否都高于阈值
    const avgTurnover = checkDailyTurnover(candles as CandleData[], MIN_AVG_TURNOVER);
    if (avgTurnover === null) return null;

    // 符合条件
    return {
      symbol: warrantSymbol,
      name: warrantQuote.name || warrant.name || warrantSymbol,
      callPrice: callPriceNum,
      distancePercent,
      avgTurnover: avgTurnover,
      avgTurnoverInWan: avgTurnover / 10000,
    };
  } catch {
    return null;
  }
}

/**
 * 批量并发处理窝轮检查（分批处理以避免API限流）
 * @param warrants 窝轮列表
 * @param checkFunction 检查函数（接受 warrant 作为参数）
 * @param batchSize 每批处理的数量
 * @returns 符合条件的窝轮列表
 */
async function checkWarrantsBatch(
  warrants: WarrantInfo[],
  checkFunction: (warrant: WarrantInfo) => Promise<QualifiedWarrant | null>,
  batchSize: number,
): Promise<QualifiedWarrant[]> {
  if (!warrants?.length) return [];

  const results: QualifiedWarrant[] = [];
  for (let i = 0; i < warrants.length; i += batchSize) {
    const batchResults = await Promise.all(
      warrants.slice(i, i + batchSize).map(checkFunction),
    );
    for (const result of batchResults) {
      if (result) results.push(result);
    }
  }
  return results;
}

/**
 * 获取符合条件的牛熊证
 * @param monitorSymbol 监控标的代码（例如 "HSI.HK"）
 * @returns 符合条件的牛证和熊证列表
 */
async function findQualifiedWarrants(
  monitorSymbol: string,
): Promise<FindWarrantsResult> {
  try {
    // 创建配置
    const config = createConfig();

    // 初始化 QuoteContext
    const ctx = await QuoteContext.new(config);

    // 规范化监控标的代码
    const normalizedMonitorSymbol = normalizeHKSymbol(monitorSymbol);

    // 1. 获取监控标的的当前价
    const monitorQuotes = await ctx.quote([normalizedMonitorSymbol]);
    const monitorQuote = monitorQuotes?.[0] as { lastDone?: unknown } | null;
    if (!monitorQuote) {
      throw new Error(`无法获取监控标的 ${normalizedMonitorSymbol} 的行情数据`);
    }

    const monitorPrice = decimalToNumber(monitorQuote.lastDone as DecimalLikeValue);
    if (!Number.isFinite(monitorPrice) || monitorPrice <= 0) {
      throw new Error(
        `监控标的 ${normalizedMonitorSymbol} 的当前价无效: ${monitorPrice}`,
      );
    }

    // 2. 使用 warrantList API 获取窝轮列表（并行获取牛证和熊证）
    const expiryDateFilters = [
      FilterWarrantExpiryDate.Between_3_6,
      FilterWarrantExpiryDate.Between_6_12,
      FilterWarrantExpiryDate.GT_12,
    ];
    const commonParams: [
      string,
      typeof WarrantSortBy[keyof typeof WarrantSortBy],
      typeof SortOrderType[keyof typeof SortOrderType],
      undefined,
      typeof FilterWarrantExpiryDate[keyof typeof FilterWarrantExpiryDate][],
      undefined,
      typeof WarrantStatus[keyof typeof WarrantStatus][]
    ] = [
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
        commonParams[0],
        commonParams[1],
        commonParams[2],
        [WarrantType.Bull],
        commonParams[3],
        commonParams[4],
        commonParams[5],
        commonParams[6],
      ),
      ctx.warrantList(
        commonParams[0],
        commonParams[1],
        commonParams[2],
        [WarrantType.Bear],
        commonParams[3],
        commonParams[4],
        commonParams[5],
        commonParams[6],
      ),
    ]);

    // 过滤：只保留当日成交额 >= MIN_DAILY_TURNOVER 的窝轮
    const filterByTurnover = (warrants: unknown[]): WarrantInfo[] => {
      if (!Array.isArray(warrants)) return [];
      const result: WarrantInfo[] = [];
      for (const w of warrants) {
        const warrant = w as WarrantInfo;
        const turnover = decimalToNumber(warrant.turnover as DecimalLikeValue);
        if (Number.isFinite(turnover) && turnover >= MIN_DAILY_TURNOVER) {
          result.push(warrant);
        }
      }
      return result;
    };

    const bullWarrants = filterByTurnover(bullWarrantList);
    const bearWarrants = filterByTurnover(bearWarrantList);

    // 3. 对每个牛证和熊证进行详细检查（回收价和成交额）
    // 创建检查函数的绑定版本
    const checkBull = (w: WarrantInfo): Promise<QualifiedWarrant | null> =>
      checkWarrant(w, ctx, monitorPrice, true);
    const checkBear = (w: WarrantInfo): Promise<QualifiedWarrant | null> =>
      checkWarrant(w, ctx, monitorPrice, false);

    // 并行检查牛证和熊证（分批处理以避免API限流）
    const [qualifiedBullWarrants, qualifiedBearWarrants] = await Promise.all([
      checkWarrantsBatch(bullWarrants, checkBull, BATCH_SIZE),
      checkWarrantsBatch(bearWarrants, checkBear, BATCH_SIZE),
    ]);

    // 排序结果
    // 牛证按距离回收价从小到大排序（离回收价越近排越前）
    qualifiedBullWarrants.sort((a, b) => a.distancePercent - b.distancePercent);
    // 熊证按距离回收价从大到小排序（离回收价越近排越前，因为是负值所以用降序）
    qualifiedBearWarrants.sort((a, b) => b.distancePercent - a.distancePercent);

    return {
      bullWarrants: qualifiedBullWarrants,
      bearWarrants: qualifiedBearWarrants,
    };
  } catch (err) {
    console.error('[错误] 查找窝轮失败:', err);
    throw err;
  }
}

/**
 * 主函数
 */
async function main(): Promise<void> {
  try {
    // 从配置获取监控标的，优先级：命令行参数 > 环境变量 > 文件配置 > 交易配置
    const monitorSymbol =
      process.argv[2] ||
      process.env['MONITOR_SYMBOL'] ||
      DEFAULT_MONITOR_SYMBOL ||
      (MULTI_MONITOR_TRADING_CONFIG.monitors.length > 0
        ? MULTI_MONITOR_TRADING_CONFIG.monitors[0]?.monitorSymbol
        : null);

    if (!monitorSymbol) {
      console.error('错误: 未指定监控标的');
      console.error(
        '使用方法: node dist/tools/findWarrant.js <监控标的代码>',
      );
      console.error('例如: node tools/findWarrant.js HSI.HK');
      console.error('或设置环境变量 MONITOR_SYMBOL');
      console.error('或在文件配置中设置 DEFAULT_MONITOR_SYMBOL 常量');
      process.exit(1);
    }

    const SEPARATOR = '='.repeat(60);
    const minAvgTurnoverWan = formatNumber(MIN_AVG_TURNOVER / 10000, 0);
    console.log(
      [
        SEPARATOR,
        '查找符合条件的牛熊证',
        SEPARATOR,
        `监控标的: ${monitorSymbol}`,
        '筛选条件:',
        `  - 牛证: 上市至少三日，过期日 >= ${MIN_EXPIRY_MONTHS}个月，三日内每日成交额都需 >= ${minAvgTurnoverWan}万，且距离百分比 > ${BULL_DISTANCE_PERCENT_THRESHOLD}%（监控标的当前价高于回收价）`,
        `  - 熊证: 上市至少三日，过期日 >= ${MIN_EXPIRY_MONTHS}个月，三日内每日成交额都需 >= ${minAvgTurnoverWan}万，且距离百分比 < ${BEAR_DISTANCE_PERCENT_THRESHOLD}%（监控标的当前价低于回收价）`,
        '排序规则:',
        `  - 牛证: 按距离回收价从小到大排序（离回收价越近越靠前）`,
        `  - 熊证: 按距离回收价从大到小排序（离回收价越近越靠前）`,
        SEPARATOR,
      ].join('\n'),
    );

    const result = await findQualifiedWarrants(monitorSymbol);

    // 输出结果
    const printWarrants = (warrants: QualifiedWarrant[], title: string): void => {
      const lines = [`\n${SEPARATOR}`, title, SEPARATOR];
      if (warrants.length === 0) {
        lines.push(`无符合条件的${title.includes('牛证') ? '牛证' : '熊证'}`);
      } else {
        for (let i = 0; i < warrants.length; i++) {
          const w = warrants[i]!;
          lines.push(
            `\n${i + 1}. ${w.name} (${w.symbol})`,
            `   回收价: ${formatNumber(w.callPrice, 2)} HKD`,
            `   距离百分比: ${formatNumber(w.distancePercent, 2)}%`,
            `   三日平均成交额: ${formatNumber(w.avgTurnoverInWan, 2)} 万 HKD（每日达标）`,
          );
        }
      }
      console.log(lines.join('\n'));
    };

    printWarrants(result.bullWarrants, '符合条件的牛证:');
    printWarrants(result.bearWarrants, '符合条件的熊证:');
  } catch (err) {
    console.error('\n[致命错误]', err);
    process.exit(1);
  }
}

// 运行主函数
try {
  await main();
} catch (error: unknown) {
  console.error('程序执行失败：', error);
  process.exit(1);
}

export { findQualifiedWarrants };

