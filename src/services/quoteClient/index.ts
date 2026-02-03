/**
 * 行情数据客户端模块（WebSocket 订阅模式）
 *
 * 功能：
 * - 通过 WebSocket 订阅实时行情推送
 * - 获取 K 线数据
 * - 检查交易日信息
 *
 * 订阅机制：
 * - 创建客户端时不自动订阅，需显式调用 subscribeSymbols
 * - 行情数据由推送实时更新到本地缓存
 * - getQuotes() 从本地缓存读取，无 HTTP 请求
 * - 支持动态订阅；未订阅标的调用 getQuotes 会抛错，需要先订阅
 *
 * 缓存机制：
 * - 行情数据：随订阅实时更新（退订会清理缓存）
 * - 昨收价：订阅后缓存（退订会清理缓存）
 * - 交易日信息：24 小时 TTL 缓存
 * - 静态信息（name、lotSize）：缓存直到退订或显式清理
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
import { decimalToNumber, formatError, formatSymbolDisplay } from '../../utils/helpers/index.js';
import { logger } from '../../utils/logger/index.js';
import { API } from '../../constants/index.js';
import type { Quote, TradingDayInfo, MarketDataClient, TradingDaysResult, PeriodString } from '../../types/index.js';
import type {
  RetryConfig,
  TradingDayCacheDeps,
  MarketDataClientDeps,
} from './types.js';
import { extractLotSize, extractName } from './utils.js';

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
function createTradingDayCache(
  _deps: TradingDayCacheDeps = {},
): {
  get: (dateStr: string) => TradingDayInfo | null;
  set: (dateStr: string, isTradingDay: boolean, isHalfDay?: boolean) => void;
  setBatch: (tradingDays: string[], halfTradingDays?: string[]) => void;
} {
  // 闭包捕获的私有状态
  const cache = new Map<string, { isTradingDay: boolean; isHalfDay: boolean; timestamp: number }>();
  const ttl = API.TRADING_DAY_CACHE_TTL_MS; // 缓存有效期：一天（单位：毫秒）

  /**
   * 获取指定日期的交易日信息
   */
  function get(dateStr: string): TradingDayInfo | null {
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
  }

  /**
   * 设置指定日期的交易日信息
   */
  function set(dateStr: string, isTradingDay: boolean, isHalfDay: boolean = false): void {
    cache.set(dateStr, {
      isTradingDay,
      isHalfDay,
      timestamp: Date.now(),
    });
  }

  /**
   * 批量设置交易日信息
   */
  function setBatch(tradingDays: string[], halfTradingDays: string[] = []): void {
    const halfDaySet = new Set(halfTradingDays);
    const allTradingDays = new Set([...tradingDays, ...halfTradingDays]);

    // 缓存所有交易日（包括全日和半日）
    for (const dateStr of allTradingDays) {
      const isHalfDay = halfDaySet.has(dateStr);
      set(dateStr, true, isHalfDay);
    }
  }

  return {
    get,
    set,
    setBatch,
  };
}

/**
 * 创建行情数据客户端（WebSocket 订阅模式）
 *
 * 重构说明：
 * - 创建时自动初始化 WebSocket 订阅
 * - getQuotes() 从本地缓存读取，无 HTTP 请求
 * - 订阅模式是默认且唯一的行情获取方式
 *
 * @param deps 依赖注入
 */
export async function createMarketDataClient(
  deps: MarketDataClientDeps,
): Promise<MarketDataClient> {
  const { config } = deps;
  const ctx = await QuoteContext.new(config);
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
  async function withRetry<T>(
    fn: () => Promise<T>,
    { retries, delayMs }: RetryConfig = DEFAULT_RETRY,
  ): Promise<T> {
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
  }

  /**
   * 处理行情推送（WebSocket 回调）
   */
  function handleQuotePush(event: PushQuoteEvent): void {
    const symbol = event.symbol;
    const staticInfo = staticInfoCache.get(symbol);
    const prevClose = prevCloseCache.get(symbol) ?? 0;
    const lotSize = extractLotSize(staticInfo);
    const pushData = event.data;

    const quote: Quote = {
      symbol,
      name: extractName(staticInfo),
      price: Number(pushData.lastDone),
      prevClose,
      timestamp: pushData.timestamp.getTime(),
      ...(lotSize === undefined ? {} : { lotSize }),
      raw: pushData,
      staticInfo,
    };

    quoteCache.set(symbol, quote);
    state.lastUpdateTime = Date.now();
  }

  // 设置推送回调
  ctx.setOnQuote((err: Error | null, event: PushQuoteEvent) => {
    if (err) {
      logger.warn(`[行情推送] 接收推送时发生错误: ${formatError(err)}`);
      return;
    }
    handleQuotePush(event);
  });

  // ==================== 公共方法实现 ====================

  /**
   * 获取行情数据（从本地缓存读取）
   * 支持任意可迭代对象（Array、Set 等），调用方无需转换
   */
  async function getQuotes(
    requestSymbols: Iterable<string>,
  ): Promise<Map<string, Quote | null>> {
    const result = new Map<string, Quote | null>();

    for (const reqSymbol of requestSymbols) {
      const cached = quoteCache.get(reqSymbol);

      if (cached) {
        result.set(reqSymbol, cached);
      } else if (subscribedSymbols.has(reqSymbol)) {
        // 已订阅但无数据（可能是刚订阅还未收到推送）
        const staticInfo = staticInfoCache.get(reqSymbol);
        const symbolName = extractName(staticInfo);
        logger.warn(`[行情获取] 标的 ${formatSymbolDisplay(reqSymbol, symbolName)} 无缓存数据`);
        result.set(reqSymbol, null);
      } else {
        // 请求的标的不在订阅列表中，抛出错误以尽早发现配置问题
        throw new Error(
          `[行情获取] 标的 ${reqSymbol} 未订阅，请先订阅`,
        );
      }
    }

    return result;
  }

  /**
   * 动态订阅新增标的
   */
  function normalizeSymbols(symbols: ReadonlyArray<string>): ReadonlyArray<string> {
    const uniqueSymbols = new Set<string>();
    for (const symbol of symbols) {
      if (symbol) {
        uniqueSymbols.add(symbol);
      }
    }
    return Array.from(uniqueSymbols);
  }

  async function subscribeSymbols(symbols: ReadonlyArray<string>): Promise<void> {
    const uniqueSymbols = normalizeSymbols(symbols);
    const newSymbols = uniqueSymbols.filter((symbol) => !subscribedSymbols.has(symbol));
    if (newSymbols.length === 0) {
      return;
    }

    await cacheStaticInfo(newSymbols);

    const initialQuotes = await withRetry(() => ctx.quote(newSymbols));
    for (const quote of initialQuotes) {
      if (!quote) continue;
      const quoteSymbol = quote.symbol;
      const staticInfo = staticInfoCache.get(quoteSymbol);
      prevCloseCache.set(quoteSymbol, decimalToNumber(quote.prevClose));
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

    await withRetry(() => ctx.subscribe(newSymbols, [SubType.Quote]));
    state.isConnected = true;
    state.lastUpdateTime = Date.now();
    logger.info(`[行情订阅] 新增订阅 ${newSymbols.length} 个标的`);
  }

  /**
   * 动态取消订阅标的
   */
  async function unsubscribeSymbols(symbols: ReadonlyArray<string>): Promise<void> {
    const uniqueSymbols = normalizeSymbols(symbols);
    const removeSymbols = uniqueSymbols.filter((symbol) => subscribedSymbols.has(symbol));
    if (removeSymbols.length === 0) {
      return;
    }

    await withRetry(() => ctx.unsubscribe(removeSymbols, [SubType.Quote]));
    for (const symbol of removeSymbols) {
      subscribedSymbols.delete(symbol);
      quoteCache.delete(symbol);
      prevCloseCache.delete(symbol);
    }
    logger.info(`[行情订阅] 已退订 ${removeSymbols.length} 个标的`);
  }

  /**
   * 缓存静态信息（保持接口兼容，内部已在初始化时完成）
   */
  async function cacheStaticInfo(newSymbols: ReadonlyArray<string>): Promise<void> {
    const uncachedSymbols = newSymbols.filter((s) => !staticInfoCache.has(s));

    if (uncachedSymbols.length === 0) return;

    const infoList = await withRetry(() => ctx.staticInfo(uncachedSymbols));
    for (const info of infoList) {
      if (info && typeof info === 'object' && 'symbol' in info) {
        const infoSymbol = (info as { symbol: string }).symbol;
        staticInfoCache.set(infoSymbol, info);
      }
    }
    logger.debug(`[静态信息缓存] 新增缓存 ${infoList.length} 个标的的静态信息`);
  }

  /**
   * 规范化周期参数
   */
  function normalizePeriod(period: PeriodString | Period): Period {
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
  }

  /**
   * 获取 QuoteContext 实例（供内部使用）
   */
  async function _getContext(): Promise<QuoteContext> {
    return ctx;
  }

  /**
   * 获取指定标的的 K 线数据，用于计算 RSI/KDJ/均价。
   */
  async function getCandlesticks(
    symbol: string,
    period: PeriodString | Period = '1m',
    count: number = 200,
    adjustType: AdjustType = AdjustType.NoAdjust,
    tradeSessions: TradeSessions = TradeSessions.All,
  ): Promise<Candlestick[]> {
    const periodEnum = normalizePeriod(period);
    return ctx.candlesticks(
      symbol,
      periodEnum,
      count,
      adjustType,
      tradeSessions,
    );
  }

  /**
   * 获取指定日期范围的交易日信息
   */
  async function getTradingDays(
    startDate: Date,
    endDate: Date,
    market: Market = Market.HK,
  ): Promise<TradingDaysResult> {
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
  }

  /**
   * 判断指定日期是否是交易日
   */
  async function isTradingDay(
    date: Date,
    market: Market = Market.HK,
  ): Promise<TradingDayInfo> {
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

      // 缓存结果（无论是否是交易日都缓存）
      tradingDayCache.set(dateStr, isTradingDayResult, isInHalfTradingDays);

      return {
        isTradingDay: isTradingDayResult,
        isHalfDay: isInHalfTradingDays,
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
  }

  return {
    _getContext,
    getQuotes,
    subscribeSymbols,
    unsubscribeSymbols,
    getCandlesticks,
    getTradingDays,
    isTradingDay,
    cacheStaticInfo,
  };
}
