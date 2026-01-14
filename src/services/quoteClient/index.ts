/**
 * 行情数据客户端模块
 *
 * 功能：
 * - 获取实时行情数据
 * - 获取 K 线数据
 * - 检查交易日信息
 * - 检查牛熊证信息（回收价等）
 *
 * 缓存机制：
 * - 行情数据：1 秒 TTL 缓存
 * - 交易日信息：24 小时 TTL 缓存
 * - 牛熊证信息：持久缓存
 * - 静态信息（name、lotSize）：永久缓存（程序启动时填充）
 *
 * 核心方法：
 * - getQuotes()：批量获取多个标的实时行情
 * - getCandlesticks()：获取 K 线数据
 * - isTradingDay()：检查是否为交易日
 * - checkWarrantInfo()：检查牛熊证回收价
 * - cacheStaticInfo()：批量缓存静态信息（由配置验证流程调用）
 */

import {
  AdjustType,
  Period,
  QuoteContext,
  TradeSessions,
  Market,
  NaiveDate,
  Candlestick,
} from 'longport';
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
  CacheEntry,
  QuoteCache,
  TradingDayCache,
  QuoteCacheDeps,
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
 * 创建行情缓存
 * @param deps 依赖注入
 * @returns QuoteCache 接口实例
 */
export const createQuoteCache = <T>(deps: QuoteCacheDeps = {}): QuoteCache<T> => {
  const ttlMs = deps.ttlMs ?? API.QUOTE_CACHE_TTL_MS;
  const map = new Map<string, CacheEntry<T>>();

  const get = (key: string): T | null => {
    const entry = map.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > ttlMs) {
      map.delete(key);
      return null;
    }
    return entry.value;
  };

  const set = (key: string, value: T): void => {
    map.set(key, { value, ts: Date.now() });
  };

  return {
    get,
    set,
  };
};

/**
 * 创建交易日缓存
 * @param _deps 依赖注入（当前为空）
 * @returns TradingDayCache 接口实例
 */
export const createTradingDayCache = (_deps: TradingDayCacheDeps = {}): TradingDayCache => {
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
 * 创建行情数据客户端
 * @param deps 依赖注入
 * @returns Promise<MarketDataClient> 接口实例
 */
export const createMarketDataClient = async (deps: MarketDataClientDeps = {}): Promise<MarketDataClient> => {
  const finalConfig = deps.config ?? createConfig();
  const ctxPromise = QuoteContext.new(finalConfig);
  const quoteCache = createQuoteCache<Quote>();
  const tradingDayCache = createTradingDayCache();

  // staticInfo 永久缓存（在配置验证阶段填充，运行时只读）
  const staticInfoCache = new Map<string, unknown>();

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
   * 批量缓存静态信息（供配置验证流程使用）
   * 在程序启动时调用一次，将所有标的的静态信息缓存起来
   * @param symbols 标的代码数组
   */
  const cacheStaticInfo = async (symbols: ReadonlyArray<string>): Promise<void> => {
    const ctx = await ctxPromise;
    const normalizedSymbols = symbols.map(normalizeHKSymbol);
    if (normalizedSymbols.length === 0) {
      return;
    }
    try {
      const statics = await withRetry(() => ctx.staticInfo(normalizedSymbols));
      if (statics) {
        for (const info of statics) {
          if (info && typeof info === 'object' && 'symbol' in info) {
            const symbol = (info as { symbol: string }).symbol;
            staticInfoCache.set(symbol, info);
          }
        }
        logger.debug(`[静态信息缓存] 成功缓存 ${statics.length} 个标的的静态信息`);
      }
    } catch (err) {
      logger.error(
        '[静态信息缓存] 批量缓存失败：',
        formatError(err),
      );
      throw err;
    }
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
    return ctxPromise;
  };

  /**
   * 批量获取多个标的的最新行情
   * 使用单次 API 调用获取所有标的行情，减少 API 调用次数
   * 静态信息（name、lotSize）从永久缓存读取，不调用 staticInfo API
   *
   * @param symbols 标的代码数组
   * @returns 标的代码到行情数据的 Map（使用规范化后的标的代码作为 key）
   */
  const getQuotes = async (symbols: ReadonlyArray<string>): Promise<Map<string, Quote | null>> => {
    const ctx = await ctxPromise;
    const result = new Map<string, Quote | null>();

    // 规范化所有标的代码
    const normalizedSymbols = symbols.map(normalizeHKSymbol);

    // 分离已缓存和未缓存的标的
    const uncachedSymbols: string[] = [];
    for (const symbol of normalizedSymbols) {
      const cached = quoteCache.get(symbol);
      if (cached) {
        result.set(symbol, cached);
      } else {
        uncachedSymbols.push(symbol);
      }
    }

    // 如果所有标的都已缓存，直接返回
    if (uncachedSymbols.length === 0) {
      return result;
    }

    try {
      // 只调用 quote API 获取实时行情，不调用 staticInfo API
      const quotes = await withRetry(() => ctx.quote(uncachedSymbols));

      // 从永久缓存读取静态信息
      const staticInfoMap = new Map<string, unknown>();
      for (const symbol of uncachedSymbols) {
        const cachedStaticInfo = staticInfoCache.get(symbol);
        if (cachedStaticInfo) {
          staticInfoMap.set(symbol, cachedStaticInfo);
        }
        // 缓存未命中时不处理，staticInfoMap 中就没有该 symbol
      }

      // 处理每个行情数据
      if (quotes) {
        for (const quote of quotes) {
          if (!quote) continue;

          const symbol = quote.symbol;
          const staticInfo = staticInfoMap.get(symbol);
          const name = extractName(staticInfo);
          const lotSize = extractLotSize(staticInfo);

          const quoteResult: Quote = {
            symbol: quote.symbol,
            name,
            price: decimalToNumber(quote.lastDone),
            prevClose: decimalToNumber(quote.prevClose),
            timestamp: quote.timestamp.getTime(),
            ...(lotSize === undefined ? {} : { lotSize }),
            raw: quote,
            staticInfo,
          };

          // 缓存并添加到结果
          quoteCache.set(symbol, quoteResult);
          result.set(symbol, quoteResult);
        }
      }

      // 对于未返回数据的标的，设置为 null
      for (const symbol of uncachedSymbols) {
        if (!result.has(symbol)) {
          logger.warn(`[行情获取] 标的 ${symbol} 未返回行情数据`);
          result.set(symbol, null);
        }
      }

      return result;
    } catch (err) {
      logger.error(
        '[行情获取] 批量获取标的行情时发生错误：',
        formatError(err),
      );

      // 发生错误时，将所有未缓存的标的设为 null
      for (const symbol of uncachedSymbols) {
        if (!result.has(symbol)) {
          result.set(symbol, null);
        }
      }

      return result;
    }
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
    const ctx = await ctxPromise;
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
    const ctx = await ctxPromise;

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
      const result = await getTradingDays(date, date, market);

      // 检查返回的交易日列表中是否包含当天
      const isInTradingDays = result.tradingDays.includes(dateStr);
      const isInHalfTradingDays = result.halfTradingDays.includes(dateStr);

      // 半日交易日也算交易日
      const isTradingDay = isInTradingDays || isInHalfTradingDays;
      const isHalfDay = isInHalfTradingDays;

      // 缓存结果（无论是否是交易日都缓存）
      tradingDayCache.set(dateStr, isTradingDay, isHalfDay);

      return {
        isTradingDay,
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

