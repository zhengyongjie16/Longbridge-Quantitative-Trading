/**
 * 行情数据客户端模块（WebSocket 订阅模式）
 *
 * 功能：
 * - 通过 WebSocket 订阅实时行情推送
 * - 获取 K 线数据
 * - 检查交易日信息
 *
 * 订阅机制：
 * - 创建客户端时自动初始化 WebSocket 订阅
 * - 行情数据由推送实时更新到本地缓存
 * - getQuotes() 从本地缓存读取，无 HTTP 请求
 * - 不支持动态订阅：请求未订阅的标的会抛出错误，确保配置正确
 *
 * 缓存机制：
 * - 行情数据：持久缓存（由 WebSocket 推送实时更新）
 * - 昨收价：持久缓存（初始化时获取）
 * - 交易日信息：24 小时 TTL 缓存
 * - 静态信息（name、lotSize）：永久缓存
 *
 * 核心方法：
 * - getQuotes()：批量获取多个标的实时行情（从本地缓存读取）
 * - getCandlesticks()：获取 K 线数据
 * - isTradingDay()：检查是否为交易日
 * - cacheStaticInfo()：批量缓存静态信息（内部已自动调用）
 */

import {
  AdjustType,
  Period,
  QuoteContext,
  TradeSessions,
  Market,
  NaiveDate,
  SubType,
} from 'longport';
import type { Candlestick, PushQuoteEvent } from 'longport';
import { createConfig } from '../../config/config.index.js';
import {
  normalizeHKSymbol,
  decimalToNumber,
  formatError,
} from '../../utils/helpers/index.js';
import { logger } from '../../utils/logger/index.js';
import { API } from '../../constants/index.js';
import type { Quote, TradingDayInfo, MarketDataClient, TradingDaysResult, PeriodString } from '../../types/index.js';
import type {
  RetryConfig,
  TradingDayCacheDeps,
  MarketDataClientDeps,
} from './types.js';
import { extractLotSize, extractName } from './types.js';

// 默认重试配置（使用统一常量）
const DEFAULT_RETRY: RetryConfig = {
  retries: API.DEFAULT_RETRY_COUNT,
  delayMs: API.DEFAULT_RETRY_DELAY_MS,
};

/**
 * 创建交易日缓存
 * @param _deps 依赖注入（当前为空）
 * @returns TradingDayCache 接口实例
 */
const createTradingDayCache = (_deps: TradingDayCacheDeps = {}) => {
  // 闭包捕获的私有状态
  const cache = new Map<string, { isTradingDay: boolean; isHalfDay: boolean; timestamp: number }>();
  const ttl = API.TRADING_DAY_CACHE_TTL_MS; // 缓存有效期：一天（单位：毫秒）

  /**
   * 获取指定日期的交易日信息
   */
  const get = (dateStr: string): TradingDayInfo | null => {
    const entry = cache.get(dateStr);
    if (!entry) return null;

    // 检查缓存是否过期
    if (Date.now() - entry.timestamp > ttl) {
      cache.delete(dateStr);
      return null;
    }

    return {
      isTradingDay: entry.isTradingDay,
      isHalfDay: entry.isHalfDay,
    };
  };

  /**
   * 设置指定日期的交易日信息
   */
  const set = (dateStr: string, isTradingDay: boolean, isHalfDay: boolean = false): void => {
    cache.set(dateStr, {
      isTradingDay,
      isHalfDay,
      timestamp: Date.now(),
    });
  };

  /**
   * 批量设置交易日信息
   */
  const setBatch = (tradingDays: string[], halfTradingDays: string[] = []): void => {
    const halfDaySet = new Set(halfTradingDays);
    const allTradingDays = new Set([...tradingDays, ...halfTradingDays]);

    // 缓存所有交易日（包括全日和半日）
    for (const dateStr of allTradingDays) {
      const isHalfDay = halfDaySet.has(dateStr);
      set(dateStr, true, isHalfDay);
    }
  };

  return {
    get,
    set,
    setBatch,
  };
};

/**
 * 创建行情数据客户端（WebSocket 订阅模式）
 *
 * 重构说明：
 * - 创建时自动初始化 WebSocket 订阅
 * - getQuotes() 从本地缓存读取，无 HTTP 请求
 * - 订阅模式是默认且唯一的行情获取方式
 *
 * @param deps 依赖注入，必须提供 symbols（需要订阅的标的列表）
 */
export const createMarketDataClient = async (deps: MarketDataClientDeps): Promise<MarketDataClient> => {
  const { symbols } = deps;
  const finalConfig = deps.config ?? createConfig();
  const ctx = await QuoteContext.new(finalConfig);
  const tradingDayCache = createTradingDayCache();

  // 行情缓存（由 WebSocket 推送实时更新）
  const quoteCache = new Map<string, Quote>();
  // 昨收价缓存（用于推送时补充 prevClose）
  const prevCloseCache = new Map<string, number>();
  // 静态信息缓存
  const staticInfoCache = new Map<string, unknown>();
  // 已订阅标的
  const subscribedSymbols = new Set<string>();

  // 连接状态
  const state = {
    isConnected: false,
    lastUpdateTime: null as number | null,
  };

  /**
   * 带重试的异步操作包装器
   */
  const withRetry = async <T>(
    fn: () => Promise<T>,
    { retries, delayMs }: RetryConfig = DEFAULT_RETRY,
  ): Promise<T> => {
    let lastErr: unknown;
    for (let i = 0; i <= retries; i += 1) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i < retries) {
          // 重试中，静默处理
          if (delayMs > 0) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }
      }
    }
    throw lastErr;
  };

  /**
   * 处理行情推送（WebSocket 回调）
   */
  const handleQuotePush = (event: PushQuoteEvent): void => {
    const normalizedSymbol = normalizeHKSymbol(event.symbol);
    const staticInfo = staticInfoCache.get(normalizedSymbol);
    const prevClose = prevCloseCache.get(normalizedSymbol) ?? 0;
    const lotSize = extractLotSize(staticInfo);
    const pushData = event.data;

    const quote: Quote = {
      symbol: normalizedSymbol,
      name: extractName(staticInfo),
      price: Number(pushData.lastDone),
      prevClose,
      timestamp: pushData.timestamp.getTime(),
      ...(lotSize === undefined ? {} : { lotSize }),
      raw: pushData,
      staticInfo,
    };

    quoteCache.set(normalizedSymbol, quote);
    state.lastUpdateTime = Date.now();
  };

  // ==================== 初始化订阅（自动执行） ====================

  const normalizedSymbols = symbols.map(normalizeHKSymbol);
  logger.info(`[行情订阅] 正在初始化 ${normalizedSymbols.length} 个标的...`);

  // 1. 缓存静态信息
  const staticInfoList = await withRetry(() => ctx.staticInfo(normalizedSymbols));
  for (const info of staticInfoList) {
    if (info && typeof info === 'object' && 'symbol' in info) {
      const infoSymbol = (info as { symbol: string }).symbol;
      staticInfoCache.set(infoSymbol, info);
    }
  }
  logger.debug(`[行情订阅] 已缓存 ${staticInfoList.length} 个标的的静态信息`);

  // 2. 拉取初始行情数据（获取 prevClose，保证有初始数据）
  const initialQuotes = await withRetry(() => ctx.quote(normalizedSymbols));
  for (const quote of initialQuotes) {
    if (!quote) continue;

    const quoteSymbol = quote.symbol;
    const staticInfo = staticInfoCache.get(quoteSymbol);

    // 缓存 prevClose
    prevCloseCache.set(quoteSymbol, decimalToNumber(quote.prevClose));

    // 初始化行情缓存
    const lotSize = extractLotSize(staticInfo);
    const quoteResult: Quote = {
      symbol: quoteSymbol,
      name: extractName(staticInfo),
      price: decimalToNumber(quote.lastDone),
      prevClose: decimalToNumber(quote.prevClose),
      timestamp: quote.timestamp.getTime(),
      ...(lotSize === undefined ? {} : { lotSize }),
      raw: quote,
      staticInfo,
    };
    quoteCache.set(quoteSymbol, quoteResult);
    subscribedSymbols.add(quoteSymbol);
  }

  // 3. 设置推送回调
  ctx.setOnQuote((err: Error | null, event: PushQuoteEvent) => {
    if (err) {
      logger.warn(`[行情推送] 接收推送时发生错误: ${formatError(err)}`);
      return;
    }
    handleQuotePush(event);
  });

  // 4. 订阅行情（is_first_push = true：订阅后立即推送一次当前数据）
  await ctx.subscribe(normalizedSymbols, [SubType.Quote], true);

  state.isConnected = true;
  state.lastUpdateTime = Date.now();
  logger.info(`[行情订阅] 成功订阅 ${normalizedSymbols.length} 个标的`);

  // ==================== 公共方法实现 ====================

  /**
   * 获取行情数据（从本地缓存读取）
   * 支持任意可迭代对象（Array、Set 等），调用方无需转换
   */
  const getQuotes = async (
    requestSymbols: Iterable<string>,
  ): Promise<Map<string, Quote | null>> => {
    const result = new Map<string, Quote | null>();

    for (const reqSymbol of requestSymbols) {
      const normalizedSymbol = normalizeHKSymbol(reqSymbol);
      const cached = quoteCache.get(normalizedSymbol);

      if (cached) {
        result.set(normalizedSymbol, cached);
      } else if (subscribedSymbols.has(normalizedSymbol)) {
        // 已订阅但无数据（可能是刚订阅还未收到推送）
        logger.warn(`[行情获取] 标的 ${normalizedSymbol} 无缓存数据`);
        result.set(normalizedSymbol, null);
      } else {
        // 请求的标的不在订阅列表中，抛出错误以尽早发现配置问题
        throw new Error(
          `[行情获取] 标的 ${normalizedSymbol} 未在初始化时订阅，请检查 symbols 配置`,
        );
      }
    }

    return result;
  };

  /**
   * 缓存静态信息（保持接口兼容，内部已在初始化时完成）
   */
  const cacheStaticInfo = async (newSymbols: ReadonlyArray<string>): Promise<void> => {
    const normalizedNewSymbols = newSymbols.map(normalizeHKSymbol);
    const uncachedSymbols = normalizedNewSymbols.filter((s) => !staticInfoCache.has(s));

    if (uncachedSymbols.length === 0) return;

    const infoList = await withRetry(() => ctx.staticInfo(uncachedSymbols));
    for (const info of infoList) {
      if (info && typeof info === 'object' && 'symbol' in info) {
        const infoSymbol = (info as { symbol: string }).symbol;
        staticInfoCache.set(infoSymbol, info);
      }
    }
    logger.debug(`[静态信息缓存] 新增缓存 ${infoList.length} 个标的的静态信息`);
  };

  /**
   * 规范化周期参数
   */
  const normalizePeriod = (period: PeriodString | Period): Period => {
    if (typeof period === 'number') {
      return period;
    }
    const map: Record<PeriodString, Period> = {
      '1m': Period.Min_1,
      '5m': Period.Min_5,
      '15m': Period.Min_15,
      '1h': Period.Min_60,
      '1d': Period.Day,
    };
    return map[period] ?? Period.Min_1;
  };

  /**
   * 获取 QuoteContext 实例（供内部使用）
   */
  const _getContext = async (): Promise<QuoteContext> => {
    return ctx;
  };

  /**
   * 获取指定标的的 K 线数据，用于计算 RSI/KDJ/均价。
   */
  const getCandlesticks = async (
    symbol: string,
    period: PeriodString | Period = '1m',
    count: number = 200,
    adjustType: AdjustType = AdjustType.NoAdjust,
    tradeSessions: TradeSessions = TradeSessions.All,
  ): Promise<Candlestick[]> => {
    const normalizedSymbol = normalizeHKSymbol(symbol);
    const periodEnum = normalizePeriod(period);
    return ctx.candlesticks(
      normalizedSymbol,
      periodEnum,
      count,
      adjustType,
      tradeSessions,
    );
  };

  /**
   * 获取指定日期范围的交易日信息
   */
  const getTradingDays = async (
    startDate: Date,
    endDate: Date,
    market: Market = Market.HK,
  ): Promise<TradingDaysResult> => {
    // 转换为 NaiveDate 格式
    const startNaive = new NaiveDate(
      startDate.getFullYear(),
      startDate.getMonth() + 1,
      startDate.getDate(),
    );
    const endNaive = new NaiveDate(
      endDate.getFullYear(),
      endDate.getMonth() + 1,
      endDate.getDate(),
    );

    const resp = await withRetry(() =>
      ctx.tradingDays(market, startNaive, endNaive),
    );

    // 将 NaiveDate 数组转换为字符串数组
    const tradingDays = (resp.tradingDays || []).map((date) =>
      date.toString(),
    );
    const halfTradingDays = (resp.halfTradingDays || []).map((date) =>
      date.toString(),
    );

    // 批量缓存交易日信息
    tradingDayCache.setBatch(tradingDays, halfTradingDays);

    return {
      tradingDays,
      halfTradingDays,
    };
  };

  /**
   * 判断指定日期是否是交易日
   */
  const isTradingDay = async (
    date: Date,
    market: Market = Market.HK,
  ): Promise<TradingDayInfo> => {
    // 格式化日期为 YYYY-MM-DD
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    // 先检查缓存
    const cached = tradingDayCache.get(dateStr);
    if (cached !== null) {
      return cached;
    }

    // 如果缓存未命中，查询 API（查询当天）
    try {
      const tradingDaysResult = await getTradingDays(date, date, market);

      // 检查返回的交易日列表中是否包含当天
      const isInTradingDays = tradingDaysResult.tradingDays.includes(dateStr);
      const isInHalfTradingDays = tradingDaysResult.halfTradingDays.includes(dateStr);

      // 半日交易日也算交易日
      const isTradingDayResult = isInTradingDays || isInHalfTradingDays;
      const isHalfDay = isInHalfTradingDays;

      // 缓存结果（无论是否是交易日都缓存）
      tradingDayCache.set(dateStr, isTradingDayResult, isHalfDay);

      return {
        isTradingDay: isTradingDayResult,
        isHalfDay,
      };
    } catch (err) {
      // 如果 API 调用失败，返回保守结果（假设是交易日，避免漏掉交易机会）
      logger.warn(
        `[交易日判断] API 调用失败: ${formatError(err)}，假设为交易日继续运行`,
      );
      return {
        isTradingDay: true,
        isHalfDay: false,
      };
    }
  };

  return {
    _getContext,
    getQuotes,
    getCandlesticks,
    getTradingDays,
    isTradingDay,
    cacheStaticInfo,
  };
};
