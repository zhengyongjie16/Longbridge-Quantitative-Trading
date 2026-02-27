/**
 * 行情数据 Mock 工厂
 *
 * 功能：
 * - 构造推送事件、K 线、轮证信息与交易日结果
 */
import {
  Decimal,
  type Candlestick,
  type MarketTradingDays,
  type PushCandlestickEvent,
  type PushQuoteEvent,
  type WarrantInfo,
  type WarrantQuote,
} from 'longport';
import { toMockDecimal } from '../longport/decimal.js';
import type {
  CandlestickParams,
  PushCandlestickEventParams,
  PushQuoteEventParams,
  TradingDaysResultParams,
  WarrantInfoParams,
  WarrantQuoteParams,
} from './types.js';

/**
 * 构造行情推送事件，用于模拟 QuoteContext 的 quote 推送。
 */
export function createPushQuoteEvent(params: PushQuoteEventParams): PushQuoteEvent {
  const timestampMs = params.timestampMs ?? Date.now();
  const event = {
    symbol: params.symbol,
    data: {
      lastDone: toMockDecimal(params.price),
      open: toMockDecimal(params.price),
      high: toMockDecimal(params.price),
      low: toMockDecimal(params.price),
      timestamp: new Date(timestampMs),
      volume: 1,
      turnover: Decimal.ZERO(),
      tradeStatus: 0,
      tradeSession: 0,
      currentVolume: 1,
      currentTurnover: Decimal.ZERO(),
    },
  };

  return event as unknown as PushQuoteEvent;
}

/**
 * 构造单根 K 线数据，供 K 线订阅或历史数据 Mock 使用。
 */
export function createCandlestick(params: CandlestickParams): Candlestick {
  const timestampMs = params.timestampMs ?? Date.now();
  const candle = {
    close: toMockDecimal(params.close),
    open: toMockDecimal(params.close),
    high: toMockDecimal(params.close),
    low: toMockDecimal(params.close),
    volume: 1,
    turnover: Decimal.ZERO(),
    timestamp: new Date(timestampMs),
    tradeSession: 0,
  };

  return candle as unknown as Candlestick;
}

/**
 * 构造 K 线推送事件，用于模拟 candlestick 订阅推送。
 */
export function createPushCandlestickEvent(
  params: PushCandlestickEventParams,
): PushCandlestickEvent {
  const timestampMs = params.timestampMs ?? Date.now();
  const event = {
    symbol: params.symbol,
    data: {
      close: toMockDecimal(params.close),
      open: toMockDecimal(params.close),
      high: toMockDecimal(params.close),
      low: toMockDecimal(params.close),
      volume: 1,
      turnover: Decimal.ZERO(),
      timestamp: new Date(timestampMs),
      tradeSession: 0,
    },
  };

  return event as unknown as PushCandlestickEvent;
}

/**
 * 构造轮证实时报价，供 warrantQuote Mock 使用；可指定 callPrice、category。
 */
export function createWarrantQuote(params: WarrantQuoteParams): WarrantQuote {
  const quote = {
    symbol: params.symbol,
    lastDone: toMockDecimal(0.05),
    prevClose: toMockDecimal(0.05),
    open: toMockDecimal(0.05),
    high: toMockDecimal(0.05),
    low: toMockDecimal(0.05),
    timestamp: new Date(),
    volume: 1000,
    turnover: toMockDecimal(1000),
    tradeStatus: 0,
    impliedVolatility: toMockDecimal(0.1),
    expiryDate: '2026-12-31',
    lastTradeDate: '2026-12-31',
    outstandingRatio: toMockDecimal(0.1),
    outstandingQuantity: 100000,
    conversionRatio: toMockDecimal(10000),
    category: params.category,
    strikePrice: toMockDecimal(20000),
    upperStrikePrice: toMockDecimal(21000),
    lowerStrikePrice: toMockDecimal(19000),
    callPrice: toMockDecimal(params.callPrice),
    underlyingSymbol: 'HSI.HK',
  };

  return quote as unknown as WarrantQuote;
}

/**
 * 构造轮证列表项，供 warrantList Mock 使用。
 */
export function createWarrantInfo(params: WarrantInfoParams): WarrantInfo {
  const info = {
    symbol: params.symbol,
    warrantType: params.warrantType,
    name: params.symbol,
    lastDone: toMockDecimal(0.05),
    changeRate: Decimal.ZERO(),
    changeValue: Decimal.ZERO(),
    volume: 100,
    turnover: toMockDecimal(1000),
    expiryDate: '2026-12-31',
    strikePrice: toMockDecimal(20000),
    upperStrikePrice: toMockDecimal(21000),
    lowerStrikePrice: toMockDecimal(19000),
    outstandingQty: 100000,
    outstandingRatio: Decimal.ZERO(),
    premium: Decimal.ZERO(),
    itmOtm: Decimal.ZERO(),
    impliedVolatility: Decimal.ZERO(),
    delta: Decimal.ZERO(),
    callPrice: toMockDecimal(params.callPrice),
    toCallPrice: Decimal.ZERO(),
    effectiveLeverage: Decimal.ZERO(),
    leverageRatio: Decimal.ZERO(),
    conversionRatio: toMockDecimal(10000),
    balancePoint: Decimal.ZERO(),
    status: 0,
  };

  return info as unknown as WarrantInfo;
}

/**
 * 构造交易日查询结果，供 tradingDays Mock 使用。
 */
export function createTradingDaysResult(days: TradingDaysResultParams): MarketTradingDays {
  const result = {
    tradingDays: days.tradingDays,
    halfTradingDays: days.halfTradingDays ?? [],
  };
  return result as unknown as MarketTradingDays;
}

/**
 * 构造证券实时行情最小结构，供 quote 查询链路测试使用。
 *
 * 仅填充策略流程会读取的关键字段，避免测试被无关字段噪音干扰。
 */
export function createSecurityQuote(symbol: string, price: number): unknown {
  return {
    symbol,
    lastDone: toMockDecimal(price),
    prevClose: toMockDecimal(price),
    timestamp: new Date(),
  };
}

/**
 * 构造证券静态信息最小结构，供 staticInfo 查询链路测试使用。
 *
 * 统一返回名称与手数信息，保证订阅初始化逻辑在测试中稳定复现。
 */
export function createSecurityStaticInfo(symbol: string, name: string, lotSize: number): unknown {
  return {
    symbol,
    nameCn: name,
    nameHk: name,
    nameEn: name,
    lotSize,
  };
}
