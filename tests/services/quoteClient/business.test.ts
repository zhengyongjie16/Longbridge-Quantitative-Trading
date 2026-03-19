/**
 * quoteClient 业务测试
 *
 * 功能：
 * - 验证行情客户端相关场景意图、边界条件与业务期望。
 */
import { beforeEach, describe, expect, it } from 'bun:test';

class TestDecimal {
  private readonly value: number;

  public constructor(value: number | string) {
    this.value = Number(value);
  }

  public static ZERO(): TestDecimal {
    return new TestDecimal(0);
  }

  public toNumber(): number {
    return this.value;
  }

  public toString(): string {
    return String(this.value);
  }

  public equals(other: TestDecimal): boolean {
    return this.value === other.toNumber();
  }

  public add(other: TestDecimal): TestDecimal {
    return new TestDecimal(this.value + other.toNumber());
  }

  public sub(other: TestDecimal): TestDecimal {
    return new TestDecimal(this.value - other.toNumber());
  }

  public abs(): TestDecimal {
    return new TestDecimal(Math.abs(this.value));
  }

  public comparedTo(other: TestDecimal): number {
    const otherValue = other.toNumber();
    if (this.value < otherValue) {
      return -1;
    }

    if (this.value > otherValue) {
      return 1;
    }

    return 0;
  }
}

class TestNaiveDate {
  private readonly year: number;
  private readonly month: number;
  private readonly day: number;

  public constructor(year: number, month: number, day: number) {
    this.year = year;
    this.month = month;
    this.day = day;
  }

  public toString(): string {
    return `${String(this.year)}-${String(this.month).padStart(2, '0')}-${String(this.day).padStart(2, '0')}`;
  }
}

import { Market as RealMarket, Period as RealPeriod } from 'longbridge';

import { createQuoteContextMock } from '../../../mock/longbridge/quoteContextMock.js';
import { createMarketDataClient } from '../../../src/services/quoteClient/index.js';
import { createSdkConfigDouble } from '../../helpers/testDoubles.js';

let quoteMock: ReturnType<typeof createQuoteContextMock>;

function makeSeedQuote(
  symbol: string,
  lastDone: number,
  prevClose: number,
): {
  symbol: string;
  lastDone: TestDecimal;
  prevClose: TestDecimal;
  timestamp: Date;
} {
  return {
    symbol,
    lastDone: new TestDecimal(lastDone),
    prevClose: new TestDecimal(prevClose),
    timestamp: new Date('2026-02-16T01:00:00.000Z'),
  };
}

beforeEach(() => {
  quoteMock = createQuoteContextMock();
});

describe('quoteClient business flow', () => {
  it('subscribes symbols and serves realtime quotes with static info fields', async () => {
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
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock as never,
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
    expect(quoteMock.getCalls('realtimeQuote')).toHaveLength(1);
  });

  it('returns null for admitted symbol when realtime quote is not warmed', async () => {
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
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock as never,
    });

    await client.subscribeSymbols(['BULL.HK']);
    quoteMock.seedRealtimeQuotes([]);
    const quotes = await client.getQuotes(['BULL.HK']);

    expect(quotes.get('BULL.HK')).toBeNull();
    expect(quoteMock.getCalls('quote')).toHaveLength(1);
    expect(quoteMock.getCalls('realtimeQuote')).toHaveLength(1);
  });

  it('throws when getQuotes is called for an unsubscribed symbol', async () => {
    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock as never,
    });

    expect(client.getQuotes(['NOT_SUBSCRIBED.HK'])).rejects.toThrow('未订阅');
  });

  it('deduplicates candlestick subscription for the same symbol+period', async () => {
    quoteMock.seedCandlesticks('BULL.HK', RealPeriod.Min_1, [
      {
        open: new TestDecimal(1),
        close: new TestDecimal(1.1),
        high: new TestDecimal(1.2),
        low: new TestDecimal(0.9),
        volume: 1000,
        turnover: new TestDecimal(1000),
        timestamp: new Date('2026-02-16T01:00:00.000Z'),
      } as never,
    ]);

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock as never,
    });

    const first = await client.subscribeCandlesticks('BULL.HK', RealPeriod.Min_1);
    const second = await client.subscribeCandlesticks('BULL.HK', RealPeriod.Min_1);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(quoteMock.getCalls('subscribeCandlesticks')).toHaveLength(1);
  });

  it('caches trading-day result and avoids duplicate API calls within TTL', async () => {
    const date = new Date('2026-02-16T01:00:00.000Z');
    const naive = new TestNaiveDate(2026, 2, 16);
    quoteMock.seedTradingDays(`${String(RealMarket.HK)}:${naive.toString()}:${naive.toString()}`, {
      tradingDays: [naive],
      halfTradingDays: [],
    } as never);

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock as never,
    });

    const first = await client.isTradingDay(date, RealMarket.HK);
    const second = await client.isTradingDay(date, RealMarket.HK);

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
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock as never,
    });

    await client.subscribeSymbols(['BULL.HK']);
    await client.subscribeCandlesticks('BULL.HK', RealPeriod.Min_1);

    await client.resetRuntimeSubscriptionsAndCaches();

    expect(client.getQuotes(['BULL.HK'])).rejects.toThrow('未订阅');
    expect(quoteMock.getCalls('unsubscribe')).toHaveLength(1);
    expect(quoteMock.getCalls('unsubscribeCandlesticks')).toHaveLength(1);
  });

  it('restores quote metadata after unsubscribe failure during reset and a later subscribe', async () => {
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
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock as never,
    });

    await client.subscribeSymbols(['BULL.HK']);
    quoteMock.setFailureRule('unsubscribe', {
      failAtCalls: [1, 2, 3],
      maxFailures: 3,
      errorMessage: 'unsubscribe failed by rule',
    });

    expect(client.resetRuntimeSubscriptionsAndCaches()).rejects.toThrow('退订失败');

    quoteMock.clearFailureRules();

    await client.subscribeSymbols(['BULL.HK']);
    const quotes = await client.getQuotes(['BULL.HK']);
    const quote = quotes.get('BULL.HK');

    expect(quote?.name).toBe('测试牛证');
    expect(quote?.lotSize).toBe(500);
    expect(quote?.prevClose).toBeCloseTo(1.2);
  });
});
