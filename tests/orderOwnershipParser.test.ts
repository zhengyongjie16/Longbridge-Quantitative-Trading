import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderSide, OrderStatus, OrderType } from 'longport';

import type { RawOrderFromAPI } from '../src/types/index.js';
import {
  parseOrderOwnership,
  resolveOrderOwnership,
  getLatestTradedSymbol,
} from '../src/core/orderRecorder/orderOwnershipParser.js';

function createRawOrder(overrides: Partial<RawOrderFromAPI>): RawOrderFromAPI {
  return {
    orderId: overrides.orderId ?? 'ORDER-1',
    symbol: overrides.symbol ?? 'AAA.HK',
    stockName: overrides.stockName ?? 'HS#ALIBARP2807F',
    side: overrides.side ?? OrderSide.Buy,
    status: overrides.status ?? OrderStatus.Filled,
    orderType: overrides.orderType ?? OrderType.ELO,
    price: overrides.price ?? 0.12,
    quantity: overrides.quantity ?? 100,
    executedPrice: overrides.executedPrice ?? 0.12,
    executedQuantity: overrides.executedQuantity ?? 100,
    submittedAt: overrides.submittedAt ?? new Date('2026-02-02T00:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-02-02T00:00:00Z'),
  };
}

test('parseOrderOwnership resolves direction using ownership mapping', () => {
  const parseWithMapping = parseOrderOwnership as unknown as (
    stockName: string | null | undefined,
    mapping: ReadonlyArray<string>,
  ) => 'LONG' | 'SHORT' | null;

  const result = parseWithMapping('HS#ALIBARP2807F', ['ALIBA']);
  assert.equal(result, 'SHORT');
});

test('resolveOrderOwnership matches monitor by mapping', () => {
  const monitors = [
    { monitorSymbol: '9988.HK', orderOwnershipMapping: ['ALIBA'] },
    { monitorSymbol: '0700.HK', orderOwnershipMapping: ['TENC'] },
  ];
  const order = createRawOrder({ stockName: 'HS#ALIBARP2807F' });
  const result = resolveOrderOwnership(order, monitors);
  assert.equal(result?.monitorSymbol, '9988.HK');
  assert.equal(result?.direction, 'SHORT');
});

test('getLatestTradedSymbol uses mapping to pick latest fill', () => {
  const getLatestWithMapping = getLatestTradedSymbol as unknown as (
    orders: ReadonlyArray<RawOrderFromAPI>,
    mapping: ReadonlyArray<string>,
    direction: 'LONG' | 'SHORT',
  ) => string | null;

  const orders = [
    createRawOrder({
      orderId: 'ORDER-1',
      symbol: 'AAA.HK',
      stockName: 'HS#ALIBARC2301A',
      updatedAt: new Date('2026-02-02T00:00:00Z'),
    }),
    createRawOrder({
      orderId: 'ORDER-2',
      symbol: 'BBB.HK',
      stockName: 'HS#ALIBARP2807F',
      updatedAt: new Date('2026-02-02T01:00:00Z'),
    }),
  ];

  const result = getLatestWithMapping(orders, ['ALIBA'], 'SHORT');
  assert.equal(result, 'BBB.HK');
});
