import { AdjustType, Period, QuoteContext, TradeSessions } from "longport";
import { createConfig } from "./config.js";

const decimalToNumber = (decimalLike) =>
  decimalLike && typeof decimalLike.toNumber === "function"
    ? decimalLike.toNumber()
    : Number(decimalLike ?? 0);

/**
 * 规范化港股代码，自动添加 .HK 后缀（如果还没有）
 * @param {string} symbol 标的代码，例如 "68547" 或 "68547.HK"
 * @returns {string} 规范化后的代码，例如 "68547.HK"
 */
function normalizeHKSymbol(symbol) {
  if (!symbol || typeof symbol !== "string") {
    return symbol;
  }
  // 如果已经包含 .HK、.US 等后缀，直接返回
  if (symbol.includes(".")) {
    return symbol;
  }
  // 否则添加 .HK 后缀
  return `${symbol}.HK`;
}

const DEFAULT_RETRY = {
  retries: 2,
  delayMs: 300,
};

class QuoteCache {
  constructor(ttlMs = 1000) {
    this.ttlMs = ttlMs;
    this._map = new Map();
  }

  get(key) {
    const entry = this._map.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.ttlMs) {
      this._map.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value) {
    this._map.set(key, { value, ts: Date.now() });
  }
}

/**
 * 行情数据客户端，封装 LongPort QuoteContext 常用调用。
 * 参考：
 * - 快速开始：https://open.longbridge.com/zh-CN/docs/getting-started
 * - Node SDK：https://longportapp.github.io/openapi/nodejs/modules.html
 */
export class MarketDataClient {
  constructor(config = null) {
    this._config = config ?? createConfig();
    this._ctxPromise = QuoteContext.new(this._config);
    this._quoteCache = new QuoteCache();
  }

  async _withRetry(fn, desc, { retries, delayMs } = DEFAULT_RETRY) {
    let lastErr;
    for (let i = 0; i <= retries; i += 1) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i < retries) {
          console.warn(
            `[QuoteRetry] ${desc} 失败，第 ${i + 1} 次重试：`,
            err?.message ?? err
          );
          if (delayMs > 0) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }
      }
    }
    throw lastErr;
  }

  /**
   * 获取多个标的的实时行情
   * @param {string[]} symbols 标的代码数组
   * @returns {Promise<import("longport").SecurityQuote[]>}
   */
  async getQuotes(symbols) {
    const ctx = await this._ctxPromise;
    // 确保 symbols 是数组格式
    if (!Array.isArray(symbols)) {
      throw new TypeError("getQuotes 需要传入数组格式的标的代码");
    }
    // 规范化港股代码
    const normalizedSymbols = symbols.map((s) => normalizeHKSymbol(s));
    return ctx.quote(normalizedSymbols);
  }

  async getLatestQuote(symbol) {
    const ctx = await this._ctxPromise;
    // 规范化港股代码，自动添加 .HK 后缀
    const normalizedSymbol = normalizeHKSymbol(symbol);
    const cached = this._quoteCache.get(normalizedSymbol);
    if (cached) {
      return cached;
    }
    try {
      const [quotes, statics] = await this._withRetry(
        () =>
          Promise.all([
            ctx.quote([normalizedSymbol]),
            ctx.staticInfo([normalizedSymbol]),
          ]),
        `获取 ${normalizedSymbol} 行情`
      );
      const quote = quotes?.[0];
      const staticInfo = statics?.[0];
      if (!quote) {
        console.warn(
          `[行情获取] 标的 ${normalizedSymbol} (原始: ${symbol}) 未返回行情数据。quotes.length=${
            quotes?.length ?? 0
          }`
        );
        return null;
      }
      const name =
        staticInfo?.nameHk ?? staticInfo?.nameCn ?? staticInfo?.nameEn ?? null;
      // 从 staticInfo 中提取最小买卖单位（lotSize）
      // LongPort API 的 staticInfo 应该包含 lotSize 字段
      let lotSize = null;
      if (staticInfo) {
        // 尝试多种可能的字段名
        const lotSizeValue =
          staticInfo.lotSize ?? staticInfo.lot_size ?? staticInfo.lot ?? null;
        if (lotSizeValue !== null && lotSizeValue !== undefined) {
          const parsed = Number(lotSizeValue);
          if (Number.isFinite(parsed) && parsed > 0) {
            lotSize = parsed;
          }
        }
      }
      const result = {
        symbol: quote.symbol,
        name,
        price: decimalToNumber(quote.lastDone),
        prevClose: decimalToNumber(quote.prevClose),
        timestamp: quote.timestamp,
        lotSize: Number.isFinite(lotSize) && lotSize > 0 ? lotSize : null,
        raw: quote,
        staticInfo,
      };
      this._quoteCache.set(normalizedSymbol, result);
      return result;
    } catch (err) {
      console.error(
        `[行情获取] 获取标的 ${normalizedSymbol} (原始: ${symbol}) 行情时发生错误：`,
        err?.message ?? err
      );
      throw err;
    }
  }

  /**
   * 获取期权实时行情
   * https://open.longbridge.com/zh-CN/docs/quote/pull/option-quote
   * @param {string[]} symbols 期权标的代码数组
   * @returns {Promise<import("longport").OptionQuote[]>}
   */
  /**
   * 获取期权实时行情
   * https://open.longbridge.com/zh-CN/docs/quote/pull/option-quote
   * @param {string[]} symbols 期权标的代码数组
   * @returns {Promise<import("longport").OptionQuote[]>}
   */
  async getOptionQuotes(symbols) {
    const ctx = await this._ctxPromise;
    // 确保 symbols 是数组格式
    if (!Array.isArray(symbols)) {
      throw new TypeError("getOptionQuotes 需要传入数组格式的标的代码");
    }
    return ctx.optionQuote(symbols);
  }

  /**
   * 获取指定标的的 K 线数据，用于计算 RSI/KDJ/均价。
   * @param {string} symbol 例如 "HSI.HK"
   * @param {"1m"|"5m"|"15m"|"1h"|"1d"|Period} period 周期
   * @param {number} count 返回的 K 线数量
   * @returns {Promise<import("longport").Candlestick[]>}
   */
  async getCandlesticks(
    symbol,
    period = "1m",
    count = 200,
    adjustType = AdjustType.NoAdjust,
    tradeSessions = TradeSessions.All
  ) {
    const ctx = await this._ctxPromise;
    const periodEnum = this._normalizePeriod(period);
    return ctx.candlesticks(
      symbol,
      periodEnum,
      count,
      adjustType,
      tradeSessions
    );
  }

  _normalizePeriod(period) {
    if (typeof period === "number") {
      return period;
    }
    const map = {
      "1m": Period.Min_1,
      "5m": Period.Min_5,
      "15m": Period.Min_15,
      "1h": Period.Min_60,
      "1d": Period.Day,
    };
    return map[period] ?? Period.Min_1;
  }

  /**
   * 判断标的是否为牛熊证（窝轮）
   * 使用 warrantQuote API 获取牛熊证信息
   * @param {string} symbol 标的代码
   * @returns {Promise<{isWarrant: boolean, warrantType: "BULL"|"BEAR"|null, strikePrice: number|null, underlyingSymbol: string|null}>}
   */
  async checkWarrantInfo(symbol) {
    const ctx = await this._ctxPromise;
    const normalizedSymbol = normalizeHKSymbol(symbol);

    try {
      // 使用 warrantQuote API 获取轮证信息
      const warrantQuotes = await this._withRetry(
        () => ctx.warrantQuote([normalizedSymbol]),
        `获取 ${normalizedSymbol} 牛熊证信息`
      );

      // warrantQuote 返回数组，取第一个
      const warrantQuote =
        Array.isArray(warrantQuotes) && warrantQuotes.length > 0
          ? warrantQuotes[0]
          : null;

      if (!warrantQuote) {
        // 如果 warrantQuote 返回空，可能不是轮证，尝试从 staticInfo 获取基本信息
        try {
          const statics = await this._withRetry(
            () => ctx.staticInfo([normalizedSymbol]),
            `获取 ${normalizedSymbol} 静态信息`
          );
          const staticInfo = statics?.[0];

          // 如果 staticInfo 也没有，返回非轮证
          if (!staticInfo) {
            return {
              isWarrant: false,
              warrantType: null,
              strikePrice: null,
              underlyingSymbol: null,
            };
          }

          // 尝试从 staticInfo 获取相关资产代码
          const underlyingSymbol =
            staticInfo.underlyingSymbol ??
            staticInfo.underlying_symbol ??
            staticInfo.underlying ??
            null;

          return {
            isWarrant: false,
            warrantType: null,
            strikePrice: null,
            underlyingSymbol: underlyingSymbol
              ? String(underlyingSymbol)
              : null,
          };
        } catch (error) {
          // 如果获取 staticInfo 失败，返回非轮证
          return {
            isWarrant: false,
            warrantType: null,
            strikePrice: null,
            underlyingSymbol: null,
          };
        }
      }

      // 从 warrantQuote 中获取 category 字段判断牛熊证类型
      const category = warrantQuote.category;
      let isWarrant = false;
      let warrantType = null;

      if (category === "Bull" || category === "BULL") {
        isWarrant = true;
        warrantType = "BULL";
      } else if (category === "Bear" || category === "BEAR") {
        isWarrant = true;
        warrantType = "BEAR";
      }

      // 获取回收价（call_price 字段）
      let strikePrice = null;
      if (isWarrant) {
        const callPrice =
          warrantQuote.call_price ?? warrantQuote.callPrice ?? null;
        if (callPrice !== null && callPrice !== undefined) {
          const parsed = decimalToNumber(callPrice);
          if (Number.isFinite(parsed) && parsed > 0) {
            strikePrice = parsed;
          }
        }
      }

      // 获取相关资产代码（underlying symbol）
      // warrantQuote 可能包含 underlying_symbol 或 underlying 字段
      let underlyingSymbol = null;
      if (isWarrant) {
        const underlying =
          warrantQuote.underlying_symbol ??
          warrantQuote.underlyingSymbol ??
          warrantQuote.underlying ??
          null;
        if (underlying) {
          underlyingSymbol = String(underlying);
        } else {
          // 如果 warrantQuote 中没有，尝试从 staticInfo 获取
          try {
            const statics = await this._withRetry(
              () => ctx.staticInfo([normalizedSymbol]),
              `获取 ${normalizedSymbol} 相关资产代码`
            );
            const staticInfo = statics?.[0];
            if (staticInfo) {
              const underlyingFromStatic =
                staticInfo.underlyingSymbol ??
                staticInfo.underlying_symbol ??
                staticInfo.underlying ??
                null;
              if (underlyingFromStatic) {
                underlyingSymbol = String(underlyingFromStatic);
              }
            }
          } catch (error) {
            // 如果获取 staticInfo 失败，忽略错误，继续使用 null
          }
        }
      }

      return {
        isWarrant,
        warrantType,
        strikePrice,
        underlyingSymbol,
        warrantQuote, // 返回完整的 warrantQuote 以便调试
      };
    } catch (err) {
      console.error(
        `[牛熊证检查] 获取标的 ${normalizedSymbol} 牛熊证信息时发生错误：`,
        err?.message ?? err
      );
      // 出错时返回非牛熊证，避免阻止交易
      return {
        isWarrant: false,
        warrantType: null,
        strikePrice: null,
        underlyingSymbol: null,
      };
    }
  }

  /**
   * 获取牛熊证距离回收价的百分比
   * @param {string} symbol 标的代码
   * @param {number} underlyingPrice 相关资产的最新价格（如果为null，会尝试自动获取）
   * @returns {Promise<{isWarrant: boolean, distanceToStrikePercent: number|null, warrantType: "BULL"|"BEAR"|null, strikePrice: number|null, underlyingPrice: number|null}>}
   */
  async getWarrantDistanceToStrike(symbol, underlyingPrice = null) {
    const warrantInfo = await this.checkWarrantInfo(symbol);

    if (!warrantInfo.isWarrant || !warrantInfo.strikePrice) {
      return {
        isWarrant: false,
        distanceToStrikePercent: null,
        warrantType: null,
        strikePrice: null,
        underlyingPrice: null,
      };
    }

    // 如果没有提供相关资产价格，尝试获取
    let actualUnderlyingPrice = underlyingPrice;
    if (actualUnderlyingPrice === null && warrantInfo.underlyingSymbol) {
      try {
        const underlyingQuote = await this.getLatestQuote(
          warrantInfo.underlyingSymbol
        );
        actualUnderlyingPrice = underlyingQuote?.price ?? null;
      } catch (err) {
        console.warn(
          `[牛熊证检查] 无法获取相关资产 ${warrantInfo.underlyingSymbol} 的价格：`,
          err?.message ?? err
        );
      }
    }

    if (
      actualUnderlyingPrice === null ||
      !Number.isFinite(actualUnderlyingPrice)
    ) {
      return {
        isWarrant: true,
        distanceToStrikePercent: null,
        warrantType: warrantInfo.warrantType,
        strikePrice: warrantInfo.strikePrice,
        underlyingPrice: null,
      };
    }

    // 计算距离回收价的百分比
    let distanceToStrikePercent = null;
    // 确保回收价不为0且有效
    if (
      !Number.isFinite(warrantInfo.strikePrice) ||
      warrantInfo.strikePrice <= 0
    ) {
      return {
        isWarrant: true,
        distanceToStrikePercent: null,
        warrantType: warrantInfo.warrantType,
        strikePrice: warrantInfo.strikePrice,
        underlyingPrice: actualUnderlyingPrice,
      };
    }

    if (warrantInfo.warrantType === "BULL") {
      // 牛证：距离回收价百分比 = (相关资产现价 - 回收价) / 回收价 * 100%
      distanceToStrikePercent =
        ((actualUnderlyingPrice - warrantInfo.strikePrice) /
          warrantInfo.strikePrice) *
        100;
    } else if (warrantInfo.warrantType === "BEAR") {
      // 熊证：距离回收价百分比 = (回收价 - 相关资产现价) / 回收价 * 100%
      distanceToStrikePercent =
        ((warrantInfo.strikePrice - actualUnderlyingPrice) /
          warrantInfo.strikePrice) *
        100;
    }

    return {
      isWarrant: true,
      distanceToStrikePercent: Number.isFinite(distanceToStrikePercent)
        ? distanceToStrikePercent
        : null,
      warrantType: warrantInfo.warrantType,
      strikePrice: warrantInfo.strikePrice,
      underlyingPrice: actualUnderlyingPrice,
    };
  }
}
