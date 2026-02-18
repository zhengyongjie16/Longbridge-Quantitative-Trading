/**
 * quoteClient 业务测试
 *
 * 功能：
 * - 围绕 business.test.ts 场景验证 tests/services/quoteClient 相关业务行为与边界条件。
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

class TestDecimal {
  private readonly value: number;

  constructor(value: number | string) {
    this.value = Number(value);
  }

  static ZERO(): TestDecimal {
    return new TestDecimal(0);
  }

  toNumber(): number {
    return this.value;
  }

  toString(): string {
    return String(this.value);
  }

  equals(other: TestDecimal): boolean {
    return this.value === other.toNumber();
  }
}

class TestNaiveDate {
  private readonly year: number;
  private readonly month: number;
  private readonly day: number;

  constructor(year: number, month: number, day: number) {
    this.year = year;
    this.month = month;
    this.day = day;
  }

  toString(): string {
    return `${String(this.year)}-${String(this.month).padStart(2, '0')}-${String(this.day).padStart(2, '0')}`;
  }
}

const Period = {
  Unknown: 0,
  Min_1: 1,
  Min_2: 2,
  Min_3: 3,
  Min_5: 5,
  Min_10: 10,
  Min_15: 15,
  Min_20: 20,
  Min_30: 30,
  Min_45: 45,
  Min_60: 60,
  Min_120: 120,
  Min_180: 180,
  Min_240: 240,
  Day: 1000,
  Week: 1001,
  Month: 1002,
  Quarter: 1003,
  Year: 1004,
} as const;

const SubType = {
  Quote: 1,
} as const;

const TradeSessions = {
  All: 0,
} as const;

const Market = {
  HK: 'HK',
} as const;

const OrderStatus = {
  New: 'New',
  PartialFilled: 'PartialFilled',
  WaitToNew: 'WaitToNew',
  WaitToReplace: 'WaitToReplace',
  PendingReplace: 'PendingReplace',
} as const;

const OrderType = {
  MO: 'MO',
} as const;

const WarrantType = {
  Bull: 3,
  Bear: 4,
} as const;

let activeQuoteContext: unknown = null;

class QuoteContext {
  static async new(): Promise<unknown> {
    if (!activeQuoteContext) {
      throw new Error('QuoteContext mock is not initialized');
    }
    return activeQuoteContext;
  }
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- bun:test mock.module 为同步注册
mock.module('longport', () => ({
  Decimal: TestDecimal,
  NaiveDate: TestNaiveDate,
  Period,
  SubType,
  TradeSessions,
  Market,
  OrderStatus,
  OrderType,
  WarrantType,
  QuoteContext,
}));

import { Decimal, Market as MockMarket, NaiveDate, Period as MockPeriod } from 'longport';

import { createQuoteContextMock } from '../../../mock/longport/quoteContextMock.js';
import { createMarketDataClient } from '../../../src/services/quoteClient/index.js';

let quoteMock: ReturnType<typeof createQuoteContextMock>;

function makeSeedQuote(symbol: string, lastDone: number, prevClose: number): {
  symbol: string;
  lastDone: TestDecimal;
  prevClose: TestDecimal;
  timestamp: Date;
} {
  return {
    symbol,
    lastDone: new Decimal(lastDone) as unknown as TestDecimal,
    prevClose: new Decimal(prevClose) as unknown as TestDecimal,
    timestamp: new Date('2026-02-16T01:00:00.000Z'),
  };
}

beforeEach(() => {
  quoteMock = createQuoteContextMock();
  activeQuoteContext = quoteMock;
});

describe('quoteClient business flow', () => {
  it('subscribes symbols and serves cached quotes with static info fields', async () => {
    quoteMock.seedStaticInfo([
      {
        symbol: 'BULL.HK',
        info: {
          symbol: 'BULL.HK',
          nameHk: '测试牛证',
          lotSize: 500,
        },
      },
    ]);
    quoteMock.seedQuotes([
      {
        symbol: 'BULL.HK',
        quote: makeSeedQuote('BULL.HK', 1.23, 1.2),
      },
    ]);

    const client = await createMarketDataClient({
      config: {} as never,
    });

    await client.subscribeSymbols(['BULL.HK']);
    const quotes = await client.getQuotes(['BULL.HK']);

    const quote = quotes.get('BULL.HK');
    expect(quote?.name).toBe('测试牛证');
    expect(quote?.lotSize).toBe(500);
    expect(quote?.price).toBeCloseTo(1.23);

    expect(quoteMock.getCalls('staticInfo')).toHaveLength(1);
    expect(quoteMock.getCalls('quote')).toHaveLength(1);
    expect(quoteMock.getCalls('subscribe')).toHaveLength(1);
  });

  it('throws when getQuotes is called for an unsubscribed symbol', async () => {
    const client = await createMarketDataClient({
      config: {} as never,
    });

    expect(client.getQuotes(['NOT_SUBSCRIBED.HK'])).rejects.toThrow('未订阅');
  });

  it('deduplicates candlestick subscription for the same symbol+period', async () => {
    quoteMock.seedCandlesticks('BULL.HK', MockPeriod.Min_1, [
      {
        open: new Decimal(1),
        close: new Decimal(1.1),
        high: new Decimal(1.2),
        low: new Decimal(0.9),
        volume: 1000,
        turnover: new Decimal(1000),
        timestamp: new Date('2026-02-16T01:00:00.000Z'),
      } as never,
    ]);

    const client = await createMarketDataClient({
      config: {} as never,
    });

    const first = await client.subscribeCandlesticks('BULL.HK', MockPeriod.Min_1);
    const second = await client.subscribeCandlesticks('BULL.HK', MockPeriod.Min_1);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(quoteMock.getCalls('subscribeCandlesticks')).toHaveLength(1);
  });

  it('caches trading-day result and avoids duplicate API calls within TTL', async () => {
    const date = new Date('2026-02-16T01:00:00.000Z');
    const naive = new NaiveDate(2026, 2, 16);
    quoteMock.seedTradingDays(`${String(MockMarket.HK)}:${naive.toString()}:${naive.toString()}`, {
      tradingDays: [naive],
      halfTradingDays: [],
    } as never);

    const client = await createMarketDataClient({
      config: {} as never,
    });

    const first = await client.isTradingDay(date, MockMarket.HK);
    const second = await client.isTradingDay(date, MockMarket.HK);

    expect(first.isTradingDay).toBeTrue();
    expect(second.isTradingDay).toBeTrue();
    expect(quoteMock.getCalls('tradingDays')).toHaveLength(1);
  });

  it('resetRuntimeSubscriptionsAndCaches clears runtime caches and quote subscriptions', async () => {
    quoteMock.seedStaticInfo([
      {
        symbol: 'BULL.HK',
        info: {
          symbol: 'BULL.HK',
          nameHk: '测试牛证',
          lotSize: 500,
        },
      },
    ]);
    quoteMock.seedQuotes([
      {
        symbol: 'BULL.HK',
        quote: makeSeedQuote('BULL.HK', 1.23, 1.2),
      },
    ]);

    const client = await createMarketDataClient({
      config: {} as never,
    });

    await client.subscribeSymbols(['BULL.HK']);
    await client.subscribeCandlesticks('BULL.HK', MockPeriod.Min_1);

    await client.resetRuntimeSubscriptionsAndCaches();

    expect(client.getQuotes(['BULL.HK'])).rejects.toThrow('未订阅');
    expect(quoteMock.getCalls('unsubscribe')).toHaveLength(1);
    expect(quoteMock.getCalls('unsubscribeCandlesticks')).toHaveLength(1);
  });
});
