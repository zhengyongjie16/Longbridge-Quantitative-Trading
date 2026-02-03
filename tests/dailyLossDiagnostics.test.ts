import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderSide, OrderStatus, OrderType } from 'longport';

import type { RawOrderFromAPI } from '../src/types/index.js';
import { collectOrderOwnershipDiagnostics } from '../src/core/risk/utils.js';
import { resolveOrderOwnership } from '../src/core/orderRecorder/orderOwnershipParser.js';
import { toBeijingTimeIso } from '../src/utils/helpers/index.js';

function createRawOrder(overrides: Partial<RawOrderFromAPI>): RawOrderFromAPI {
  return {
    orderId: overrides.orderId ?? 'ORDER-1',
    symbol: overrides.symbol ?? 'AAA.HK',
    stockName: overrides.stockName ?? 'HS#HSIRC2807F',
    side: overrides.side ?? OrderSide.Buy,
    status: overrides.status ?? OrderStatus.Filled,
    orderType: overrides.orderType ?? OrderType.ELO,
    price: overrides.price ?? 0.12,
    quantity: overrides.quantity ?? 100,
    executedPrice: overrides.executedPrice ?? 0.12,
    executedQuantity: overrides.executedQuantity ?? 100,
    submittedAt: overrides.submittedAt ?? new Date('2026-02-03T00:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-02-03T00:00:00Z'),
  };
}

test('collectOrderOwnershipDiagnostics counts unmatched filled orders', () => {
  const monitors = [
    { monitorSymbol: 'HSI.HK', orderOwnershipMapping: ['HSI'] },
    { monitorSymbol: '9988.HK', orderOwnershipMapping: ['ALIBA'] },
  ];
  const now = new Date('2026-02-03T02:00:00Z');
  const orders = [
    createRawOrder({
      orderId: 'ORDER-1',
      stockName: 'HS#HSIRC2807F',
      updatedAt: new Date('2026-02-03T01:00:00Z'),
    }),
    createRawOrder({
      orderId: 'ORDER-2',
      stockName: '\u6052\u6307\u718a\u8bc1',
      updatedAt: new Date('2026-02-03T01:10:00Z'),
    }),
    createRawOrder({
      orderId: 'ORDER-3',
      stockName: 'HS#ALIBARP2807F',
      updatedAt: new Date('2026-02-02T01:00:00Z'),
    }),
  ];

  const diagnostics = collectOrderOwnershipDiagnostics({
    orders,
    monitors,
    now,
    resolveOrderOwnership,
    toBeijingTimeIso,
    maxSamples: 2,
  });

  assert.ok(diagnostics);
  assert.equal(diagnostics.totalFilled, 3);
  assert.equal(diagnostics.inDayFilled, 2);
  assert.equal(diagnostics.unmatchedFilled, 1);
  assert.equal(diagnostics.unmatchedSamples.length, 1);
  assert.equal(diagnostics.unmatchedSamples[0]?.orderId, 'ORDER-2');
});
