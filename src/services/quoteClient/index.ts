/**
 * 行情数据客户端模块（WebSocket 订阅模式）
 *
 * 功能：
 * - 通过 WebSocket 订阅实时行情推送（报价 + K 线）
 * - 检查交易日信息
 *
 * 订阅机制：
 * - 创建客户端时不自动订阅，需显式调用 subscribeSymbols / subscribeCandlesticks
 * - Quote 当前价由 SDK realtime 状态提供，标准化 quote push 事件由应用层按订阅与缓存状态派发
 * - K 线数据采用「subscribe 初始 seed + setOnCandlestick push 更新」的应用层本地缓存，并在 push 后发布标准化更新事件
 * - getQuotes() 只读取 SDK realtimeQuote 状态，无 HTTP 请求
 *
 * 缓存机制：
 * - 动态 Quote：不在应用层缓存，按次从 SDK realtime 状态读取
 * - 昨收价：订阅后缓存（退订会清理缓存）
 * - K 线数据：应用层本地缓存（订阅 seed + push 增量更新）
 * - 交易日信息：24 小时 TTL 缓存
 * - 静态信息（name、lotSize）：订阅时拉取并缓存，退订时在 unsubscribeSymbols 内清除
 *
 * 核心方法：
 * - getQuotes()：批量获取多个标的实时行情（从 SDK realtimeQuote 状态读取）
 * - subscribeCandlesticks()：订阅 K 线推送
 * - isTradingDay()：检查是否为交易日
 */
import {
  QuoteContext,
  TradeSessions,
  Market,
  SubType,
  type Candlestick,
  type Period,
} from 'longbridge';
import { decimalToNumber, isRecord, isValidPositiveNumber } from '../../utils/helpers/index.js';
import {
  createExternalApiAggregateRequestError,
  isAllExternalApiRequestErrors,
  wrapExternalApiRequest,
} from '../../utils/apiFailure/index.js';
import type { DecimalLike } from '../../utils/helpers/types.js';
import { logger } from '../../utils/logger/index.js';
import { API, TRADING } from '../../constants/index.js';
import type { Quote } from '../../types/quote.js';
import type {
  TradingDayInfo,
  MarketDataClient,
  MarketQuoteContext,
  TradingDaysResult,
  CandlestickUpdatedEvent,
  QuoteUpdatedEvent,
} from '../../types/services.js';
import type {
  CandlestickUpdatedListener,
  MarketDataClientDeps,
  QuoteContextLike,
  PushQuoteEventLike,
} from './types.js';
import { formatSymbolDisplay } from '../../utils/display/index.js';
import { getRequiredHKDateKey } from '../../utils/time/index.js';
import { extractLotSize, extractName, formatPeriodForLog, resolveHKNaiveDate } from './utils.js';
import {
  applyCandlestickPush,
  clearCandlestickSnapshots,
  createCandlestickCacheStore,
  getCandlestickSnapshot,
  seedCandlestickSeries,
} from './candlestickCache.js';

/**
 * 带重试的异步函数执行包装器，将外部 API 调用委托给 apiFailure 模块的统一重试逻辑。
 *
 * @param operation 外部 API 操作名
 * @param fn 需要执行的异步函数
 * @returns 函数执行结果
 * @throws 最后一次执行的错误（经 wrapExternalApiRequest 分类）
 */
async function withRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  return wrapExternalApiRequest({
    operation,
    request: fn,
  });
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

function isDecimalLikeValue(value: unknown): value is DecimalLike {
  return isRecord(value) && typeof value['toNumber'] === 'function';
}

function normalizeDecimalLikeInput(
  value: unknown,
): DecimalLike | number | string | null | undefined {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'string' ||
    isDecimalLikeValue(value)
  ) {
    return value;
  }

  return undefined;
}

function isCandlestickLike(value: unknown): value is Candlestick {
  return isRecord(value) && 'close' in value && 'timestamp' in value;
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
 * 将 SDK realtime quote 与元数据拼装为内部 Quote。
 *
 * @param symbol 标的代码
 * @param realtimeQuote SDK realtimeQuote 返回项
 * @param staticInfo 静态信息缓存项
 * @param prevClose 昨收价缓存项
 * @returns 内部 Quote 结构；当 realtime 必需字段无效时返回 null
 */
function buildQuoteFromRealtime(params: {
  readonly symbol: string;
  readonly realtimeQuote: unknown;
  readonly staticInfo: unknown;
  readonly prevClose: number;
}): Quote | null {
  const { symbol, realtimeQuote, staticInfo, prevClose } = params;
  if (!isRecord(realtimeQuote)) {
    return null;
  }

  const lastDone = decimalToNumber(normalizeDecimalLikeInput(realtimeQuote['lastDone']));
  if (!Number.isFinite(lastDone)) {
    return null;
  }

  const timestampValue = realtimeQuote['timestamp'];
  const timestamp = timestampValue instanceof Date ? timestampValue.getTime() : Date.now();
  const lotSize = extractLotSize(staticInfo);
  return {
    symbol,
    name: extractName(staticInfo),
    price: lastDone,
    prevClose,
    timestamp,
    ...(lotSize === undefined ? {} : { lotSize }),
  };
}

/**
 * 将 quote push 事件标准化为内部 Quote。
 *
 * 仅使用 lastDone 作为有效价格来源；当价格无效或非正数时返回 null。
 * 不向 SDK 追补查询，也不使用其他行情字段兜底。
 *
 * @param params 标准化所需参数
 * @returns 标准化后的 Quote；价格无效时返回 null
 */
function buildQuoteFromPushEvent(params: {
  readonly symbol: string;
  readonly pushEvent: PushQuoteEventLike;
  readonly staticInfo: unknown;
  readonly prevClose: number;
}): Quote | null {
  const { symbol, pushEvent, staticInfo, prevClose } = params;
  const lastDone = decimalToNumber(normalizeDecimalLikeInput(pushEvent.data.lastDone));
  if (!isValidPositiveNumber(lastDone)) {
    return null;
  }

  const timestamp =
    pushEvent.data.timestamp instanceof Date ? pushEvent.data.timestamp.getTime() : Date.now();
  const lotSize = extractLotSize(staticInfo);
  return {
    symbol,
    name: extractName(staticInfo),
    price: lastDone,
    prevClose,
    timestamp,
    ...(lotSize === undefined ? {} : { lotSize }),
  };
}

/**
 * 创建行情数据客户端（WebSocket 订阅模式）。创建时初始化 QuoteContext，getQuotes 从 SDK realtime 状态读取。
 * @param deps - 依赖注入，包含 Longbridge Config
 * @returns Promise<MarketDataClient>，提供 getQuotes、subscribeSymbols、subscribeCandlesticks、isTradingDay 等
 */
export async function createMarketDataClient(
  deps: MarketDataClientDeps,
): Promise<MarketDataClient> {
  const { config, quoteContextFactory } = deps;
  // SDK 返回的 QuoteContext 能力面覆盖当前仓库的 QuoteContextLike；这里在第三方边界集中收口一次断言。
  const ctx: QuoteContextLike = quoteContextFactory
    ? await quoteContextFactory(config)
    : (QuoteContext.new(config) as QuoteContextLike);
  const tradingDayCache = createTradingDayCache();

  // 昨收价缓存（用于 realtime quote 组装 prevClose）
  const prevCloseCache = new Map<string, number>();

  // 静态信息缓存
  const staticInfoCache = new Map<string, unknown>();

  // 已订阅标的（报价推送）
  const subscribedSymbols = new Set<string>();

  // 标准化行情更新监听器
  const quoteUpdatedListeners = new Set<(event: QuoteUpdatedEvent) => void>();

  // 标准化 K 线更新监听器
  const candlestickUpdatedListeners = new Set<CandlestickUpdatedListener>();

  // 已订阅 K 线跟踪（key: "symbol:period"）
  const subscribedCandlesticks = new Map<string, Period>();
  const candlestickCacheStore = createCandlestickCacheStore({
    maxCandles: TRADING.CANDLE_COUNT,
  });

  ctx.setOnCandlestick((err, event) => {
    if (err) {
      logger.error('[K线推送] push 事件异常', err);
      return;
    }

    const symbol = event.symbol;
    if (!symbol) {
      return;
    }

    const pushData = event.data;

    const key = `${symbol}:${String(pushData.period)}`;
    if (!subscribedCandlesticks.has(key)) {
      return;
    }

    const currentSnapshot = candlestickCacheStore.snapshots.get(key) ?? null;
    const updatedSnapshot = applyCandlestickPush({
      store: candlestickCacheStore,
      symbol,
      period: pushData.period,
      candlestick: pushData.candlestick,
      isConfirmed: pushData.isConfirmed,
    });

    if (updatedSnapshot === null || updatedSnapshot === currentSnapshot) {
      return;
    }

    const standardizedEvent: CandlestickUpdatedEvent = {
      symbol,
      period: pushData.period,
      snapshot: updatedSnapshot,
    };

    for (const listener of candlestickUpdatedListeners) {
      listener(standardizedEvent);
    }
  });

  ctx.setOnQuote((err, event) => {
    if (err) {
      logger.error('[行情推送] push 事件异常', err);
      return;
    }

    const symbol = event.symbol;
    if (typeof symbol !== 'string' || symbol.length === 0) {
      return;
    }

    if (!subscribedSymbols.has(symbol)) {
      return;
    }

    const quote = buildQuoteFromPushEvent({
      symbol,
      pushEvent: event,
      staticInfo: staticInfoCache.get(symbol),
      prevClose: prevCloseCache.get(symbol) ?? 0,
    });
    if (quote === null) {
      return;
    }

    const standardizedEvent: QuoteUpdatedEvent = {
      symbol,
      quote,
    };

    for (const listener of quoteUpdatedListeners) {
      listener(standardizedEvent);
    }
  });

  /**
   * 获取行情数据（从 SDK realtime 状态读取）。支持任意可迭代对象（Array、Set 等）。
   *
   * @param requestSymbols 请求的标的代码集合（可迭代）
   * @returns 标的 -> Quote 或 null 的 Map；已接入但 realtime 未 warm 的标的返回 null
   * @throws Error 若 requestSymbols 中包含尚未通过 subscribeSymbols 接入的标的，将抛出错误以暴露配置问题
   */
  async function getQuotes(requestSymbols: Iterable<string>): Promise<Map<string, Quote | null>> {
    const requestedSymbols = [...requestSymbols];
    for (const reqSymbol of requestedSymbols) {
      if (!subscribedSymbols.has(reqSymbol)) {
        throw new Error(`[行情获取] 标的 ${reqSymbol} 未订阅，请先订阅`);
      }
    }

    const realtimeQuotes = await wrapExternalApiRequest({
      operation: 'QuoteContext.realtimeQuote',
      request: () => ctx.realtimeQuote(requestedSymbols),
      retryConfig: {
        retries: 0,
        delayMs: 0,
      },
    });
    const realtimeQuoteBySymbol = new Map<string, unknown>();
    for (const realtimeQuote of realtimeQuotes) {
      if (!isRecord(realtimeQuote)) {
        continue;
      }

      const symbolValue = realtimeQuote['symbol'];
      if (typeof symbolValue === 'string' && symbolValue.length > 0) {
        realtimeQuoteBySymbol.set(symbolValue, realtimeQuote);
      }
    }

    const result = new Map<string, Quote | null>();
    for (const reqSymbol of requestedSymbols) {
      const realtimeQuote = realtimeQuoteBySymbol.get(reqSymbol);
      if (!realtimeQuote) {
        const staticInfo = staticInfoCache.get(reqSymbol);
        const symbolName = extractName(staticInfo);
        logger.warn(
          `[行情获取] 标的 ${formatSymbolDisplay(reqSymbol, symbolName)} 无 realtime 数据`,
        );
        result.set(reqSymbol, null);
        continue;
      }

      const quote = buildQuoteFromRealtime({
        symbol: reqSymbol,
        realtimeQuote,
        staticInfo: staticInfoCache.get(reqSymbol),
        prevClose: prevCloseCache.get(reqSymbol) ?? 0,
      });
      result.set(reqSymbol, quote);
    }

    return result;
  }

  /**
   * 动态订阅新增标的。先补齐 metadata，再对未接入标的建立订阅，并统一恢复已订阅标的的 metadata 完整性。
   *
   * @param symbols 待订阅的标的代码列表
   * @returns Promise<void>
   * 副作用：更新 staticInfoCache、prevCloseCache、subscribedSymbols
   */
  async function subscribeSymbols(symbols: ReadonlyArray<string>): Promise<void> {
    const uniqueSymbols = normalizeSymbols(symbols);
    const symbolsNeedingMetadata = uniqueSymbols.filter(
      (symbol) => !staticInfoCache.has(symbol) || !prevCloseCache.has(symbol),
    );
    const newSymbols = uniqueSymbols.filter((symbol) => !subscribedSymbols.has(symbol));
    if (symbolsNeedingMetadata.length === 0 && newSymbols.length === 0) {
      return;
    }

    try {
      await cacheStaticInfo(symbolsNeedingMetadata);
      const missingStaticInfoSymbols = symbolsNeedingMetadata.filter(
        (symbol) => !staticInfoCache.has(symbol),
      );
      if (missingStaticInfoSymbols.length > 0) {
        throw new Error(
          `[行情订阅] 静态信息初始化不完整，拒绝接入: ${missingStaticInfoSymbols.join(',')}`,
        );
      }

      const symbolsNeedingPrevClose = symbolsNeedingMetadata.filter(
        (symbol) => !prevCloseCache.has(symbol),
      );
      if (symbolsNeedingPrevClose.length > 0) {
        const initialQuotes = await withRetry('QuoteContext.quote', () =>
          ctx.quote(symbolsNeedingPrevClose),
        );
        const initializedPrevCloseBySymbol = new Map<string, number>();
        for (const quote of initialQuotes) {
          if (!isRecord(quote)) {
            continue;
          }

          const quoteSymbolValue = quote['symbol'];
          if (typeof quoteSymbolValue !== 'string' || quoteSymbolValue.length === 0) {
            continue;
          }

          const prevCloseValue = decimalToNumber(normalizeDecimalLikeInput(quote['prevClose']));
          if (!Number.isFinite(prevCloseValue)) {
            continue;
          }

          initializedPrevCloseBySymbol.set(quoteSymbolValue, prevCloseValue);
        }

        const missingPrevCloseSymbols = symbolsNeedingPrevClose.filter(
          (symbol) => !initializedPrevCloseBySymbol.has(symbol),
        );
        if (missingPrevCloseSymbols.length > 0) {
          throw new Error(
            `[行情订阅] prevClose 初始化不完整，拒绝接入: ${missingPrevCloseSymbols.join(',')}`,
          );
        }

        for (const symbol of symbolsNeedingPrevClose) {
          const prevCloseValue = initializedPrevCloseBySymbol.get(symbol);
          if (prevCloseValue === undefined) {
            throw new Error(`[行情订阅] prevClose 读取失败，拒绝接入: ${symbol}`);
          }

          prevCloseCache.set(symbol, prevCloseValue);
        }
      }

      if (newSymbols.length > 0) {
        await withRetry('QuoteContext.subscribe.quote', () =>
          ctx.subscribe(newSymbols, [SubType.Quote]),
        );

        for (const symbol of newSymbols) {
          subscribedSymbols.add(symbol);
        }

        logger.debug(`[行情订阅] 新增订阅 ${newSymbols.length} 个标的`);
      }
    } catch (error) {
      for (const symbol of newSymbols) {
        subscribedSymbols.delete(symbol);
      }

      for (const symbol of uniqueSymbols) {
        if (!subscribedSymbols.has(symbol)) {
          prevCloseCache.delete(symbol);
          staticInfoCache.delete(symbol);
        }
      }

      throw error;
    }
  }

  /**
   * 动态取消订阅标的。退订并清理本地元数据缓存中的 prevClose、staticInfo。
   *
   * @param symbols 待退订的标的代码列表
   * @returns Promise<void>
   * 副作用：从 subscribedSymbols 移除、清理 prevCloseCache/staticInfoCache
   */
  async function unsubscribeSymbols(symbols: ReadonlyArray<string>): Promise<void> {
    const uniqueSymbols = normalizeSymbols(symbols);
    const removeSymbols = uniqueSymbols.filter((symbol) => subscribedSymbols.has(symbol));
    if (removeSymbols.length === 0) {
      return;
    }

    await withRetry('QuoteContext.unsubscribe.quote', () =>
      ctx.unsubscribe(removeSymbols, [SubType.Quote]),
    );

    for (const symbol of removeSymbols) {
      subscribedSymbols.delete(symbol);
      prevCloseCache.delete(symbol);
      staticInfoCache.delete(symbol);
    }

    logger.debug(`[行情订阅] 已退订 ${removeSymbols.length} 个标的`);
  }

  /**
   * 补充缓存静态信息，确保新增标的具备名称和 lotSize。
   *
   * @param newSymbols 待缓存的标的代码列表（已存在缓存的会跳过）
   * @returns Promise<void>
   * 副作用：写入 staticInfoCache
   */
  async function cacheStaticInfo(newSymbols: ReadonlyArray<string>): Promise<void> {
    const uncachedSymbols = newSymbols.filter((s) => !staticInfoCache.has(s));
    if (uncachedSymbols.length === 0) return;

    const infoList = await withRetry('QuoteContext.staticInfo', () =>
      ctx.staticInfo(uncachedSymbols),
    );
    for (const info of infoList) {
      if (!isRecord(info)) {
        continue;
      }

      const symbolValue = info['symbol'];
      if (typeof symbolValue !== 'string' || symbolValue.length === 0) {
        continue;
      }

      staticInfoCache.set(symbolValue, info);
    }

    logger.debug(`[静态信息缓存] 新增缓存 ${infoList.length} 个标的的静态信息`);
  }

  /**
   * 获取轮证查询上下文（供内部或下游使用）。
   *
   * @returns Promise<MarketQuoteContext> 当前行情上下文的业务边界
   */
  function getQuoteContext(): Promise<MarketQuoteContext> {
    return Promise.resolve({
      warrantQuote: (symbols) =>
        withRetry('QuoteContext.warrantQuote', () => ctx.warrantQuote([...symbols])),
      warrantList: async (request) =>
        withRetry('QuoteContext.warrantList', () =>
          ctx.warrantList(
            request.symbol,
            request.sortBy,
            request.sortOrder,
            [...request.types],
            request.issuerIds ? [...request.issuerIds] : request.issuerIds,
            request.expiryFilters ? [...request.expiryFilters] : request.expiryFilters,
            request.inOutBoundsTypes ? [...request.inOutBoundsTypes] : request.inOutBoundsTypes,
            request.status ? [...request.status] : request.status,
          ),
        ),
    });
  }

  /**
   * 订阅标准化行情更新事件。
   *
   * 监听器仅接收已经通过 quoteClient 标准化、且当前仍处于已订阅状态的标的更新。
   * 返回的取消订阅函数只移除当前监听器，不影响底层 quote 订阅。
   *
   * @param listener 行情更新监听器
   * @returns 取消订阅函数
   */
  function onQuoteUpdated(listener: (event: QuoteUpdatedEvent) => void): () => void {
    quoteUpdatedListeners.add(listener);
    return () => {
      quoteUpdatedListeners.delete(listener);
    };
  }

  /**
   * 订阅标准化 K 线更新事件。
   *
   * 监听器仅接收已经通过 quoteClient 标准化、且当前仍处于已订阅状态的 K 线更新。
   * 返回的取消订阅函数只移除当前监听器，不影响底层 K 线订阅。
   *
   * @param listener K 线更新监听器
   * @returns 取消订阅函数
   */
  function onCandlestickUpdated(listener: CandlestickUpdatedListener): () => void {
    candlestickUpdatedListeners.add(listener);
    return () => {
      candlestickUpdatedListeners.delete(listener);
    };
  }

  /**
   * 订阅指定标的的 K 线推送，并返回初始 K 线数据。
   *
   * @param symbol 标的代码
   * @param period K 线周期
   * @param tradeSessions 交易时段，默认 Intraday
   * @returns 初始 K 线数组；已订阅过则返回空数组
   * 副作用：写入 subscribedCandlesticks、拉取并返回初始 K 线
   */
  async function subscribeCandlesticks(
    symbol: string,
    period: Period,
    tradeSessions: TradeSessions = TradeSessions.Intraday,
  ): Promise<ReadonlyArray<Candlestick>> {
    const key = `${symbol}:${period}`;
    if (subscribedCandlesticks.has(key)) {
      logger.debug(`[K线订阅] ${symbol} 周期 ${formatPeriodForLog(period)} 已订阅，跳过重复订阅`);
      return [];
    }

    const initialCandles = await withRetry('QuoteContext.subscribeCandlesticks', () =>
      ctx.subscribeCandlesticks(symbol, period, tradeSessions),
    );
    const returnedCandles = initialCandles.filter(isCandlestickLike);
    subscribedCandlesticks.set(key, period);
    seedCandlestickSeries({
      store: candlestickCacheStore,
      symbol,
      period,
      candles: initialCandles,
    });

    logger.debug(
      `[K线订阅] 已订阅 ${symbol} 周期 ${formatPeriodForLog(period)} K线，初始数据 ${initialCandles.length} 根`,
    );
    return returnedCandles;
  }

  function readLocalCandlestickSnapshot(symbol: string, period: Period) {
    return getCandlestickSnapshot({
      store: candlestickCacheStore,
      symbol,
      period,
    });
  }

  /**
   * 获取指定日期范围的交易日信息。
   *
   * @param startDate 起始日期
   * @param endDate 结束日期
   * @param market 市场，默认 HK
   * @returns 交易日与半日交易日字符串数组
   * 副作用：批量写入 tradingDayCache
   */
  async function getTradingDays(
    startDate: Date,
    endDate: Date,
    market: Market = Market.HK,
  ): Promise<TradingDaysResult> {
    // 使用港股日期键转换为 NaiveDate，避免本地时区偏移
    const startNaive = resolveHKNaiveDate(startDate);
    const endNaive = resolveHKNaiveDate(endDate);
    const resp = await withRetry('QuoteContext.tradingDays', () =>
      ctx.tradingDays(market, startNaive, endNaive),
    );

    // 将 NaiveDate 数组转换为字符串数组
    const tradingDays = resp.tradingDays.map(String);
    const halfTradingDays = resp.halfTradingDays.map(String);

    // 批量缓存交易日信息
    tradingDayCache.setBatch(tradingDays, halfTradingDays);
    return {
      tradingDays,
      halfTradingDays,
    };
  }

  /**
   * 重置运行期订阅与缓存：退订所有 quote/kline 订阅，并保持已订阅标的与 metadata 缓存的一致性。
   * Fail-safe 语义：任何退订失败均被汇总并最终抛出，不吞错。
   * 单个失败不提前返回，尽量完成全部清理尝试，再统一抛错。
   * 订阅集合状态：成功退订的移除，失败的保留；保留的已订阅标的不清 metadata，避免半状态。
   * K 线本地缓存：仅清理成功退订的 key，失败 key 保留缓存，避免“订阅保留但缓存丢失”。
   */
  async function resetRuntimeSubscriptionsAndCaches(): Promise<void> {
    const symbolsToUnsub = [...subscribedSymbols];
    const candlestickEntriesToUnsub = [...subscribedCandlesticks.entries()];
    const errors: unknown[] = [];
    const successfulCandlestickClears: Array<{ symbol: string; period: Period }> = [];

    // 1. 退订 quote（批量）
    if (symbolsToUnsub.length > 0) {
      try {
        await withRetry('QuoteContext.unsubscribe.quote.reset', () =>
          ctx.unsubscribe(symbolsToUnsub, [SubType.Quote]),
        );

        for (const symbol of symbolsToUnsub) {
          subscribedSymbols.delete(symbol);
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
        await withRetry('QuoteContext.unsubscribeCandlesticks.reset', () =>
          ctx.unsubscribeCandlesticks(symbol, periodValue),
        );
        subscribedCandlesticks.delete(key);
        successfulCandlestickClears.push({
          symbol,
          period: periodValue,
        });
      } catch (err) {
        errors.push(err);
      }
    }

    if (successfulCandlestickClears.length > 0) {
      clearCandlestickSnapshots({
        store: candlestickCacheStore,
        keys: successfulCandlestickClears,
      });
    }

    // 3. 交易日缓存始终清空；quote metadata 仅在 symbol 真正退订后清理，避免订阅状态与 metadata 失配。
    tradingDayCache.clear();
    if (errors.length > 0) {
      if (isAllExternalApiRequestErrors(errors)) {
        throw createExternalApiAggregateRequestError({
          operation: 'QuoteContext.resetRuntimeSubscriptionsAndCaches',
          attempts: 1,
          causes: errors,
        });
      }

      throw new AggregateError(
        errors,
        `[行情重置] 退订失败 ${errors.length} 项，失败项已保留于订阅集合，可重试`,
      );
    }
  }

  /**
   * 判断指定日期是否是交易日。先查缓存，未命中则请求 getTradingDays 并写缓存。
   *
   * @param date 待判断日期
   * @param market 市场，默认 HK
   * @returns 是否交易日、是否半日等信息
   * 副作用：缓存未命中时会写入 tradingDayCache
   */
  async function isTradingDay(date: Date, market: Market = Market.HK): Promise<TradingDayInfo> {
    // 格式化为港股日期键 YYYY-MM-DD
    const dateStr = getRequiredHKDateKey(date);

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
    onQuoteUpdated,
    onCandlestickUpdated,
    subscribeCandlesticks,
    getCandlestickSnapshot: readLocalCandlestickSnapshot,
    isTradingDay,
    getTradingDays,
    resetRuntimeSubscriptionsAndCaches,
  };
}
