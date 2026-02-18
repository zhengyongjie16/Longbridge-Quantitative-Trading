/**
 * 行情数据 Mock 工厂
 *
 * 功能：
 * - 构造推送事件、K 线、轮证信息与交易日结果
 */
import { Decimal } from 'longport';
import type {
  Candlestick,
  MarketTradingDays,
  PushCandlestickEvent,
  PushQuoteEvent,
  WarrantInfo,
  WarrantQuote,
} from 'longport';
import { toMockDecimal } from '../longport/decimal.js';

export function createPushQuoteEvent(params: {
  readonly symbol: string;
  readonly price: number;
  readonly timestampMs?: number;
}): PushQuoteEvent {
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

export function createCandlestick(params: {
  readonly close: number;
  readonly timestampMs?: number;
}): Candlestick {
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

export function createPushCandlestickEvent(params: {
  readonly symbol: string;
  readonly close: number;
  readonly timestampMs?: number;
}): PushCandlestickEvent {
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

export function createWarrantQuote(params: {
  readonly symbol: string;
  readonly callPrice: number;
  readonly category: number;
}): WarrantQuote {
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

export function createWarrantInfo(params: {
  readonly symbol: string;
  readonly warrantType: string;
  readonly callPrice: number;
}): WarrantInfo {
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

export function createTradingDaysResult(days: {
  readonly tradingDays: ReadonlyArray<string>;
  readonly halfTradingDays?: ReadonlyArray<string>;
}): MarketTradingDays {
  const result = {
    tradingDays: days.tradingDays,
    halfTradingDays: days.halfTradingDays ?? [],
  };
  return result as unknown as MarketTradingDays;
}

export function createSecurityQuote(symbol: string, price: number): unknown {
  return {
    symbol,
    lastDone: toMockDecimal(price),
    prevClose: toMockDecimal(price),
    timestamp: new Date(),
  };
}

export function createSecurityStaticInfo(symbol: string, name: string, lotSize: number): unknown {
  return {
    symbol,
    nameCn: name,
    nameHk: name,
    nameEn: name,
    lotSize,
  };
}
