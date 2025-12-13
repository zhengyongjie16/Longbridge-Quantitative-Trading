import {
  AdjustType,
  Period,
  QuoteContext,
  TradeSessions,
  Market,
  NaiveDate,
} from "longport";
import { createConfig } from "./config/config.js";
import { normalizeHKSymbol, decimalToNumber } from "./utils.js";
import { logger } from "./logger.js";

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
 * 交易日缓存类
 * 缓存交易日信息，避免频繁调用 API
 * 每天只需要获取一次交易日信息
 */
class TradingDayCache {
  constructor() {
    // 缓存格式: { date: "YYYY-MM-DD", isTradingDay: boolean, isHalfDay: boolean, timestamp: number }
    this._cache = new Map();
    // 缓存有效期：一天（单位：毫秒）
    this._ttl = 24 * 60 * 60 * 1000;
  }

  /**
   * 获取指定日期的交易日信息
   * @param {string} dateStr 日期字符串 "YYYY-MM-DD"
   * @returns {object|null} 交易日信息或 null
   */
  get(dateStr) {
    const entry = this._cache.get(dateStr);
    if (!entry) return null;

    // 检查缓存是否过期
    if (Date.now() - entry.timestamp > this._ttl) {
      this._cache.delete(dateStr);
      return null;
    }

    return {
      isTradingDay: entry.isTradingDay,
      isHalfDay: entry.isHalfDay,
    };
  }

  /**
   * 设置指定日期的交易日信息
   * @param {string} dateStr 日期字符串 "YYYY-MM-DD"
   * @param {boolean} isTradingDay 是否是交易日
   * @param {boolean} isHalfDay 是否是半日交易日
   */
  set(dateStr, isTradingDay, isHalfDay = false) {
    this._cache.set(dateStr, {
      isTradingDay,
      isHalfDay,
      timestamp: Date.now(),
    });
  }

  /**
   * 批量设置交易日信息
   * @param {Array<string>} tradingDays 交易日列表 ["YYYY-MM-DD", ...]
   * @param {Array<string>} halfTradingDays 半日交易日列表 ["YYYY-MM-DD", ...]
   */
  setBatch(tradingDays, halfTradingDays = []) {
    const halfDaySet = new Set(halfTradingDays);
    const allTradingDays = new Set([...tradingDays, ...halfTradingDays]);

    // 缓存所有交易日（包括全日和半日）
    for (const dateStr of allTradingDays) {
      const isHalfDay = halfDaySet.has(dateStr);
      this.set(dateStr, true, isHalfDay);
    }
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
    this._tradingDayCache = new TradingDayCache();
  }

  /**
   * 获取 QuoteContext 实例（供内部使用）
   * @returns {Promise<QuoteContext>}
   */
  async _getContext() {
    return this._ctxPromise;
  }

  async _withRetry(fn, { retries, delayMs } = DEFAULT_RETRY) {
    let lastErr;
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

  async getLatestQuote(symbol) {
    const ctx = await this._ctxPromise;
    // 规范化港股代码，自动添加 .HK 后缀
    const normalizedSymbol = normalizeHKSymbol(symbol);
    const cached = this._quoteCache.get(normalizedSymbol);
    if (cached) {
      return cached;
    }
    try {
      const [quotes, statics] = await this._withRetry(() =>
        Promise.all([
          ctx.quote([normalizedSymbol]),
          ctx.staticInfo([normalizedSymbol]),
        ])
      );
      const quote = quotes?.[0];
      const staticInfo = statics?.[0];
      if (!quote) {
        logger.warn(
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
      logger.error(
        `[行情获取] 获取标的 ${normalizedSymbol} (原始: ${symbol}) 行情时发生错误：`,
        err?.message ?? err
      );
      throw err;
    }
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
   * 获取指定日期范围的交易日信息
   * @param {Date} startDate 开始日期
   * @param {Date} endDate 结束日期
   * @param {Market} market 市场类型，默认为香港市场
   * @returns {Promise<{tradingDays: string[], halfTradingDays: string[]}>}
   */
  async getTradingDays(startDate, endDate, market = Market.HK) {
    const ctx = await this._ctxPromise;

    // 转换为 NaiveDate 格式
    const startNaive = new NaiveDate(
      startDate.getFullYear(),
      startDate.getMonth() + 1,
      startDate.getDate()
    );
    const endNaive = new NaiveDate(
      endDate.getFullYear(),
      endDate.getMonth() + 1,
      endDate.getDate()
    );

    try {
      const resp = await this._withRetry(() =>
        ctx.tradingDays(market, startNaive, endNaive)
      );

      // 将 NaiveDate 数组转换为字符串数组
      const tradingDays = (resp.tradingDays || []).map((date) =>
        date.toString()
      );
      const halfTradingDays = (resp.halfTradingDays || []).map((date) =>
        date.toString()
      );

      // 批量缓存交易日信息
      this._tradingDayCache.setBatch(tradingDays, halfTradingDays);

      return {
        tradingDays,
        halfTradingDays,
      };
    } catch (err) {
      // 获取交易日信息失败，抛出异常由上层处理
      throw err;
    }
  }

  /**
   * 判断指定日期是否是交易日
   * @param {Date} date 日期对象
   * @param {Market} market 市场类型，默认为香港市场
   * @returns {Promise<{isTradingDay: boolean, isHalfDay: boolean}>}
   */
  async isTradingDay(date, market = Market.HK) {
    // 格式化日期为 YYYY-MM-DD
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const dateStr = `${year}-${month}-${day}`;

    // 先检查缓存
    const cached = this._tradingDayCache.get(dateStr);
    if (cached !== null) {
      return cached;
    }

    // 如果缓存未命中，查询 API（查询当天）
    try {
      const result = await this.getTradingDays(date, date, market);

      // 检查返回的交易日列表中是否包含当天
      const isInTradingDays = result.tradingDays.includes(dateStr);
      const isInHalfTradingDays = result.halfTradingDays.includes(dateStr);

      // 半日交易日也算交易日
      const isTradingDay = isInTradingDays || isInHalfTradingDays;
      const isHalfDay = isInHalfTradingDays;

      // 缓存结果（无论是否是交易日都缓存）
      this._tradingDayCache.set(dateStr, isTradingDay, isHalfDay);

      return {
        isTradingDay,
        isHalfDay,
      };
    } catch (err) {
      // 如果 API 调用失败，返回保守结果（假设是交易日，避免漏掉交易机会）
      return {
        isTradingDay: true,
        isHalfDay: false,
      };
    }
  }
}
