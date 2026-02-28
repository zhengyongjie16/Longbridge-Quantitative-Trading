/**
 * 行情数据客户端模块（WebSocket 订阅模式）
 *
 * 功能：
 * - 通过 WebSocket 订阅实时行情推送（报价 + K 线）
 * - 检查交易日信息
 *
 * 订阅机制：
 * - 创建客户端时不自动订阅，需显式调用 subscribeSymbols / subscribeCandlesticks
 * - 报价数据由推送实时更新到应用层 quoteCache
 * - K 线数据由 SDK 内部维护缓存，通过 realtimeCandlesticks 读取
 * - getQuotes() 从应用层 quoteCache 读取，无 HTTP 请求
 * - getRealtimeCandlesticks() 从 SDK 内部缓存读取，无 HTTP 请求
 *
 * 缓存机制：
 * - 行情数据：随订阅实时更新（退订会清理缓存）
 * - 昨收价：订阅后缓存（退订会清理缓存）
 * - K 线数据：SDK 内部自动维护（订阅后实时更新，退订后自动清理）
 * - 交易日信息：24 小时 TTL 缓存
 * - 静态信息（name、lotSize）：订阅时拉取并缓存，退订时在 unsubscribeSymbols 内清除
 *
 * 核心方法：
 * - getQuotes()：批量获取多个标的实时行情（从应用层 quoteCache 读取）
 * - subscribeCandlesticks()：订阅 K 线推送
 * - getRealtimeCandlesticks()：获取实时 K 线数据（从 SDK 内部缓存读取）
 * - isTradingDay()：检查是否为交易日
 */
import {
  QuoteContext,
  TradeSessions,
  Market,
  SubType,
  type Candlestick,
  type Period,
  type PushQuoteEvent,
  type PushCandlestickEvent,
} from 'longport';
import { decimalToNumber } from '../../utils/helpers/index.js';
import { isRecord } from '../../utils/primitives/index.js';
import { logger } from '../../utils/logger/index.js';
import { API } from '../../constants/index.js';
import type { Quote, QuoteStaticInfo } from '../../types/quote.js';
import type { TradingDayInfo, MarketDataClient, TradingDaysResult } from '../../types/services.js';
import type { RetryConfig, MarketDataClientDeps } from './types.js';
import { formatSymbolDisplay } from '../../utils/display/index.js';
import { formatError } from '../../utils/error/index.js';
import {
  extractLotSize,
  extractName,
  formatPeriodForLog,
  resolveHKDateKey,
  resolveHKNaiveDate,
} from './utils.js';
// 默认重试配置（使用统一常量）
const DEFAULT_RETRY: RetryConfig = {
  retries: API.DEFAULT_RETRY_COUNT,
  delayMs: API.DEFAULT_RETRY_DELAY_MS,
};
/**
 * 带重试的异步函数执行包装器
 * @param fn - 需要执行的异步函数
 * @param retries - 重试次数
 * @param delayMs - 重试间隔（毫秒）
 * @returns 函数执行结果
 * @throws 最后一次执行的错误
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
      if (i < retries && delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
    }
  }
  throw lastErr;
}
/**
 * 规范化标的代码数组，去重并过滤空值
 * @param symbols - 原始标的代码数组
 * @returns 去重后的标的代码数组
 */
function normalizeSymbols(symbols: ReadonlyArray<string>): ReadonlyArray<string> {
  const uniqueSymbols = new Set<string>();
  for (const symbol of symbols) {
    if (symbol) {
      uniqueSymbols.add(symbol);
    }
  }
  return [...uniqueSymbols];
}
/**
 * 将 unknown 静态信息标准化为 QuoteStaticInfo，字段类型不匹配时返回 null。
 *
 * @param staticInfo 原始静态信息
 * @returns 标准化后的 QuoteStaticInfo 或 null
 */
function normalizeQuoteStaticInfo(staticInfo: unknown): QuoteStaticInfo | null {
  if (!isRecord(staticInfo)) {
    return null;
  }
  const staticInfoRecord = staticInfo;
  function readNullableString(key: string): string | null | undefined {
    const fieldValue: unknown = staticInfoRecord[key];
    if (fieldValue === undefined || fieldValue === null || typeof fieldValue === 'string') {
      return fieldValue;
    }
    return undefined;
  }
  function readNullableNumber(key: string): number | null | undefined {
    const fieldValue: unknown = staticInfoRecord[key];
    if (fieldValue === undefined || fieldValue === null || typeof fieldValue === 'number') {
      return fieldValue;
    }
    return undefined;
  }
  function readWarrantType(): 'BULL' | 'BEAR' | null | undefined {
    const warrantTypeValue: unknown = staticInfoRecord['warrantType'];
    if (
      warrantTypeValue === undefined ||
      warrantTypeValue === null ||
      warrantTypeValue === 'BULL' ||
      warrantTypeValue === 'BEAR'
    ) {
      return warrantTypeValue;
    }
    return undefined;
  }
  const nameHk = readNullableString('nameHk');
  const nameCn = readNullableString('nameCn');
  const nameEn = readNullableString('nameEn');
  const lotSize = readNullableNumber('lotSize');
  const callPrice = readNullableNumber('callPrice');
  const expiryDate = readNullableString('expiryDate');
  const issuePrice = readNullableNumber('issuePrice');
  const conversionRatio = readNullableNumber('conversionRatio');
  const warrantType = readWarrantType();
  const underlyingSymbol = readNullableString('underlyingSymbol');
  if (
    nameHk === undefined ||
    nameCn === undefined ||
    nameEn === undefined ||
    lotSize === undefined ||
    callPrice === undefined ||
    expiryDate === undefined ||
    issuePrice === undefined ||
    conversionRatio === undefined ||
    warrantType === undefined ||
    underlyingSymbol === undefined
  ) {
    return null;
  }
  return {
    nameHk,
    nameCn,
    nameEn,
    lotSize,
    callPrice,
    expiryDate,
    issuePrice,
    conversionRatio,
    warrantType,
    underlyingSymbol,
  };
}
/**
 * 创建交易日缓存，支持按日期键读写、批量写入与 TTL 过期，供 isTradingDay 等复用以避免重复请求 API。
 *
 * @returns 含 get、set、setBatch、clear 的缓存对象
 */
function createTradingDayCache(): {
  get: (dateStr: string) => TradingDayInfo | null;
  set: (dateStr: string, isTradingDay: boolean, isHalfDay?: boolean) => void;
  setBatch: (tradingDays: string[], halfTradingDays?: string[]) => void;
  clear: () => void;
} {
  const cache = new Map<string, { isTradingDay: boolean; isHalfDay: boolean; timestamp: number }>();
  const ttl = API.TRADING_DAY_CACHE_TTL_MS;
  /**
   * 获取指定日期的交易日信息，过期条目返回 null 并删除。
   * @param dateStr 日期键（YYYY-MM-DD）
   * @returns 交易日信息，未命中或过期时返回 null
   */
  function get(dateStr: string): TradingDayInfo | null {
    const entry = cache.get(dateStr);
    if (!entry) return null;
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
   * 设置指定日期的交易日信息并写入时间戳用于 TTL 判断。
   * @param dateStr 日期键（YYYY-MM-DD）
   * @param isTradingDay 是否为交易日
   * @param isHalfDay 是否为半日市，默认 false
   * @returns void
   */
  function set(dateStr: string, isTradingDay: boolean, isHalfDay: boolean = false): void {
    cache.set(dateStr, {
      isTradingDay,
      isHalfDay,
      timestamp: Date.now(),
    });
  }
  /**
   * 批量设置交易日信息，将全日与半日列表合并后逐条写入缓存。
   * @param tradingDays 全日交易日日期键数组
   * @param halfTradingDays 半日交易日日期键数组，默认空数组
   * @returns void
   */
  function setBatch(tradingDays: string[], halfTradingDays: string[] = []): void {
    const halfDaySet = new Set(halfTradingDays);
    const allTradingDays = new Set([...tradingDays, ...halfTradingDays]);
    for (const dateStr of allTradingDays) {
      const isHalfDay = halfDaySet.has(dateStr);
      set(dateStr, true, isHalfDay);
    }
  }
  function clear(): void {
    cache.clear();
  }
  return {
    get,
    set,
    setBatch,
    clear,
  };
}
/**
 * 创建行情数据客户端（WebSocket 订阅模式）。创建时初始化 QuoteContext，getQuotes 从本地缓存读取。
 * @param deps - 依赖注入，包含 LongPort Config
 * @returns Promise<MarketDataClient>，提供 getQuotes、subscribeSymbols、subscribeCandlesticks、isTradingDay 等
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
  // 已订阅标的（报价推送）
  const subscribedSymbols = new Set<string>();
  // 已订阅 K 线跟踪（key: "symbol:period"）
  const subscribedCandlesticks = new Map<string, Period>();
  /**
   * 处理行情推送（WebSocket 回调）
   */
  function handleQuotePush(event: PushQuoteEvent): void {
    const symbol = event.symbol;
    const staticInfo = staticInfoCache.get(symbol);
    const prevClose = prevCloseCache.get(symbol) ?? 0;
    const lotSize = extractLotSize(staticInfo);
    const pushData = event.data;
    const lastDone = decimalToNumber(pushData.lastDone);
    if (!Number.isFinite(lastDone)) {
      const symbolName = extractName(staticInfo);
      logger.warn(
        `[行情推送] 标的 ${formatSymbolDisplay(symbol, symbolName)} lastDone 无效，忽略本次推送`,
      );
      return;
    }
    const quote: Quote = {
      symbol,
      name: extractName(staticInfo),
      price: lastDone,
      prevClose,
      timestamp: pushData.timestamp.getTime(),
      ...(lotSize === undefined ? {} : { lotSize }),
      raw: pushData,
      staticInfo: normalizeQuoteStaticInfo(staticInfo),
    };
    quoteCache.set(symbol, quote);
  }
  // 设置推送回调
  ctx.setOnQuote((err: Error | null, event: PushQuoteEvent) => {
    if (err) {
      logger.warn(`[行情推送] 接收推送时发生错误: ${formatError(err)}`);
      return;
    }
    handleQuotePush(event);
  });
  // K 线推送回调（错误监控）
  ctx.setOnCandlestick((err: Error | null, _event: PushCandlestickEvent) => {
    if (err) {
      logger.warn(`[K线推送] 接收推送时发生错误: ${formatError(err)}`);
    }
  });
  /**
   * 获取行情数据（从本地缓存读取）
   * 支持任意可迭代对象（Array、Set 等），调用方无需转换
   */
  function getQuotes(requestSymbols: Iterable<string>): Promise<Map<string, Quote | null>> {
    try {
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
          throw new Error(`[行情获取] 标的 ${reqSymbol} 未订阅，请先订阅`);
        }
      }
      return Promise.resolve(result);
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      return Promise.reject(normalizedError);
    }
  }
  /**
   * 动态订阅新增标的
   */
  async function subscribeSymbols(symbols: ReadonlyArray<string>): Promise<void> {
    const uniqueSymbols = normalizeSymbols(symbols);
    const newSymbols = uniqueSymbols.filter((symbol) => !subscribedSymbols.has(symbol));
    if (newSymbols.length === 0) {
      return;
    }
    await cacheStaticInfo(newSymbols);
    const initialQuotes = await withRetry(() => ctx.quote(newSymbols));
    for (const quote of initialQuotes) {
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
        staticInfo: normalizeQuoteStaticInfo(staticInfo),
      };
      quoteCache.set(quoteSymbol, quoteResult);
    }
    await withRetry(() => ctx.subscribe(newSymbols, [SubType.Quote]));
    for (const symbol of newSymbols) {
      subscribedSymbols.add(symbol);
    }
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
      staticInfoCache.delete(symbol);
    }
    logger.info(`[行情订阅] 已退订 ${removeSymbols.length} 个标的`);
  }
  /** 补充缓存静态信息，确保新增标的具备名称和 lotSize。 */
  async function cacheStaticInfo(newSymbols: ReadonlyArray<string>): Promise<void> {
    const uncachedSymbols = newSymbols.filter((s) => !staticInfoCache.has(s));
    if (uncachedSymbols.length === 0) return;
    const infoList = await withRetry(() => ctx.staticInfo(uncachedSymbols));
    for (const info of infoList) {
      staticInfoCache.set(info.symbol, info);
    }
    logger.debug(`[静态信息缓存] 新增缓存 ${infoList.length} 个标的的静态信息`);
  }
  /**
   * 获取 QuoteContext 实例（供内部使用）
   */
  async function getQuoteContext(): Promise<QuoteContext> {
    return await Promise.resolve(ctx);
  }
  /**
   * 订阅指定标的的 K 线推送
   */
  async function subscribeCandlesticks(
    symbol: string,
    period: Period,
    tradeSessions: TradeSessions = TradeSessions.All,
  ): Promise<Candlestick[]> {
    const key = `${symbol}:${period}`;
    if (subscribedCandlesticks.has(key)) {
      logger.debug(`[K线订阅] ${symbol} 周期 ${formatPeriodForLog(period)} 已订阅，跳过重复订阅`);
      return [];
    }
    const initialCandles = await withRetry(() =>
      ctx.subscribeCandlesticks(symbol, period, tradeSessions),
    );
    subscribedCandlesticks.set(key, period);
    logger.info(
      `[K线订阅] 已订阅 ${symbol} 周期 ${formatPeriodForLog(period)} K线，初始数据 ${initialCandles.length} 根`,
    );
    return initialCandles;
  }
  /**
   * 获取实时 K 线数据（从 SDK 内部缓存读取，无 HTTP 请求）
   */
  async function getRealtimeCandlesticks(
    symbol: string,
    period: Period,
    count: number,
  ): Promise<Candlestick[]> {
    return ctx.realtimeCandlesticks(symbol, period, count);
  }
  /**
   * 获取指定日期范围的交易日信息
   */
  async function getTradingDays(
    startDate: Date,
    endDate: Date,
    market: Market = Market.HK,
  ): Promise<TradingDaysResult> {
    // 使用港股日期键转换为 NaiveDate，避免本地时区偏移
    const startNaive = resolveHKNaiveDate(startDate);
    const endNaive = resolveHKNaiveDate(endDate);
    const resp = await withRetry(() => ctx.tradingDays(market, startNaive, endNaive));
    // 将 NaiveDate 数组转换为字符串数组
    const tradingDays = resp.tradingDays.map((date) => date.toString());
    const halfTradingDays = resp.halfTradingDays.map((date) => date.toString());
    // 批量缓存交易日信息
    tradingDayCache.setBatch(tradingDays, halfTradingDays);
    return {
      tradingDays,
      halfTradingDays,
    };
  }
  /**
   * 重置运行期订阅与缓存：退订所有 quote/kline 订阅，清空本地缓存。
   * Fail-safe 语义：任何退订失败均被汇总并最终抛出，不吞错。
   * 单个失败不提前返回，尽量完成全部清理尝试，再统一抛错。
   * 订阅集合状态：成功退订的移除，失败的保留，保证可重试。
   */
  async function resetRuntimeSubscriptionsAndCaches(): Promise<void> {
    const symbolsToUnsub = [...subscribedSymbols];
    const candlestickEntriesToUnsub = [...subscribedCandlesticks.entries()];
    const errors: unknown[] = [];
    // 1. 退订 quote（批量）
    if (symbolsToUnsub.length > 0) {
      try {
        await withRetry(() => ctx.unsubscribe(symbolsToUnsub, [SubType.Quote]));
        for (const symbol of symbolsToUnsub) {
          subscribedSymbols.delete(symbol);
          quoteCache.delete(symbol);
          prevCloseCache.delete(symbol);
          staticInfoCache.delete(symbol);
        }
      } catch (err) {
        errors.push(err);
      }
    }
    // 2. 退订 candlestick（逐个，失败不中断）
    for (const [key, periodValue] of candlestickEntriesToUnsub) {
      const colonIdx = key.lastIndexOf(':');
      if (colonIdx <= 0) {
        errors.push(new Error(`[行情重置] K线 key 格式无效: ${key}`));
        continue;
      }
      const symbol = key.slice(0, colonIdx);
      try {
        await withRetry(() => ctx.unsubscribeCandlesticks(symbol, periodValue));
        subscribedCandlesticks.delete(key);
      } catch (err) {
        errors.push(err);
      }
    }
    // 3. 运行期缓存统一清空（与订阅退订结果解耦，确保跨日不读旧缓存）
    quoteCache.clear();
    prevCloseCache.clear();
    staticInfoCache.clear();
    tradingDayCache.clear();
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `[行情重置] 退订失败 ${errors.length} 项，失败项已保留于订阅集合，可重试`,
      );
    }
  }
  /**
   * 判断指定日期是否是交易日
   */
  async function isTradingDay(date: Date, market: Market = Market.HK): Promise<TradingDayInfo> {
    // 格式化为港股日期键 YYYY-MM-DD
    const dateStr = resolveHKDateKey(date);
    // 先检查缓存
    const cached = tradingDayCache.get(dateStr);
    if (cached !== null) {
      return cached;
    }
    // 如果缓存未命中，查询 API（查询当天）
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
  }
  return {
    getQuoteContext,
    getQuotes,
    subscribeSymbols,
    unsubscribeSymbols,
    subscribeCandlesticks,
    getRealtimeCandlesticks,
    isTradingDay,
    getTradingDays,
    resetRuntimeSubscriptionsAndCaches,
  };
}
