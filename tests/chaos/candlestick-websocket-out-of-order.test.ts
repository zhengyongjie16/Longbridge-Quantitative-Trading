/**
 * candlestick-websocket-out-of-order 混沌测试
 *
 * 功能：
 * - 验证 K 线 websocket 乱序推送不会回退本地序列
 * - 验证同 timestamp confirmed 重复推送具备幂等版本语义
 */
import { describe, expect, it } from 'bun:test';
import { Period } from 'longbridge';

import { createPushCandlestickEvent } from '../../mock/factories/quoteFactory.js';
import { createQuoteContextMock } from '../../mock/longbridge/quoteContextMock.js';
import { createMarketDataClient } from '../../src/services/quoteClient/index.js';
import { createSdkConfigDouble } from '../helpers/testDoubles.js';

class TestDecimal {
  private readonly value: number;

  public constructor(value: number) {
    this.value = value;
  }

  public toString(): string {
    return String(this.value);
  }
}

function createCandle(close: number, timestampIso: string) {
  return {
    open: new TestDecimal(close),
    close: new TestDecimal(close),
    high: new TestDecimal(close + 0.2),
    low: new TestDecimal(close - 0.2),
    volume: 1_000,
    turnover: new TestDecimal(close * 1_000),
    timestamp: new Date(timestampIso),
    tradeSession: 0,
    toJSON: () => ({}),
  };
}

describe('chaos: candlestick websocket out-of-order pushes', () => {
  it('ignores out-of-order push and keeps confirmed replay idempotent', async () => {
    const quoteMock = createQuoteContextMock();
    quoteMock.seedCandlesticks('BULL.HK', Period.Min_1, [
      createCandle(100, '2026-03-20T01:00:00.000Z'),
      createCandle(101, '2026-03-20T01:01:00.000Z'),
    ]);

    const client = await createMarketDataClient({
      config: createSdkConfigDouble(),
      quoteContextFactory: async () => quoteMock,
    });
    await client.subscribeCandlesticks('BULL.HK', Period.Min_1);

    const seeded = client.getCandlestickSnapshot('BULL.HK', Period.Min_1);
    expect(seeded).not.toBeNull();
    if (seeded === null) {
      throw new Error('expected seeded candlestick snapshot');
    }

    quoteMock.emitCandlestick(
      createPushCandlestickEvent({
        symbol: 'BULL.HK',
        period: Period.Min_1,
        timestampMs: Date.parse('2026-03-20T00:59:00.000Z'),
        close: 88,
        isConfirmed: false,
      }),
    );
    quoteMock.flushAllEvents();

    const afterOutOfOrder = client.getCandlestickSnapshot('BULL.HK', Period.Min_1);
    expect(afterOutOfOrder).not.toBeNull();
    if (afterOutOfOrder === null) {
      throw new Error('expected snapshot after out-of-order push');
    }

    expect(afterOutOfOrder.version).toBe(seeded.version);
    expect(afterOutOfOrder.candles).toEqual(seeded.candles);
    expect(afterOutOfOrder.lastBarTimestamp).toBe(seeded.lastBarTimestamp);

    quoteMock.emitCandlestick(
      createPushCandlestickEvent({
        symbol: 'BULL.HK',
        period: Period.Min_1,
        timestampMs: Date.parse('2026-03-20T01:01:00.000Z'),
        close: 101,
        isConfirmed: true,
      }),
    );
    quoteMock.flushAllEvents();

    const confirmed = client.getCandlestickSnapshot('BULL.HK', Period.Min_1);
    expect(confirmed).not.toBeNull();
    if (confirmed === null) {
      throw new Error('expected confirmed snapshot');
    }

    const confirmedVersion = confirmed.version;
    expect(confirmed.lastBarConfirmed).toBe(true);

    quoteMock.emitCandlestick(
      createPushCandlestickEvent({
        symbol: 'BULL.HK',
        period: Period.Min_1,
        timestampMs: Date.parse('2026-03-20T01:01:00.000Z'),
        close: 101,
        isConfirmed: true,
      }),
    );
    quoteMock.flushAllEvents();

    const replayConfirmed = client.getCandlestickSnapshot('BULL.HK', Period.Min_1);
    expect(replayConfirmed).not.toBeNull();
    expect(replayConfirmed?.version).toBe(confirmedVersion);
    expect(replayConfirmed?.candles).toEqual(confirmed.candles);

    quoteMock.emitCandlestick(
      createPushCandlestickEvent({
        symbol: 'BULL.HK',
        period: Period.Min_1,
        timestampMs: Date.parse('2026-03-20T01:01:00.000Z'),
        close: 99,
        isConfirmed: false,
      }),
    );
    quoteMock.flushAllEvents();

    const staleRollback = client.getCandlestickSnapshot('BULL.HK', Period.Min_1);
    expect(staleRollback).not.toBeNull();
    expect(staleRollback?.version).toBe(confirmedVersion);
    expect(staleRollback?.lastBarConfirmed).toBe(true);
    expect(staleRollback?.candles).toEqual(confirmed.candles);
  });
});
