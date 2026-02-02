import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveBeijingDayKey,
  sumOrderCost,
} from '../src/core/risk/utils.js';
import {
  isBeforeClose15Minutes,
  isBeforeClose5Minutes,
  isBeforeCloseMinutes,
} from '../src/utils/helpers/tradingTime.js';

import type { OrderRecord } from '../src/types/index.js';

test('resolveBeijingDayKey returns YYYY/MM/DD when input is valid', () => {
  const toIso = (): string => '2026/02/02/12:00:00';
  const result = resolveBeijingDayKey(toIso, new Date('2026-02-02T00:00:00.000Z'));
  assert.equal(result, '2026/02/02');
});

test('resolveBeijingDayKey returns null for invalid date or iso', () => {
  const invalid = new Date('invalid');
  const invalidResult = resolveBeijingDayKey(() => '2026/02/02 12:00:00', invalid);
  assert.equal(invalidResult, null);

  const badIsoResult = resolveBeijingDayKey(() => '2026/02', new Date('2026-02-02T00:00:00.000Z'));
  assert.equal(badIsoResult, null);
});

test('sumOrderCost ignores invalid or non-positive values', () => {
  const orders: OrderRecord[] = [
    {
      orderId: 'A',
      symbol: 'AAA',
      executedPrice: 2,
      executedQuantity: 10,
      executedTime: 1,
      submittedAt: undefined,
      updatedAt: undefined,
    },
    {
      orderId: 'B',
      symbol: 'AAA',
      executedPrice: 0,
      executedQuantity: 5,
      executedTime: 1,
      submittedAt: undefined,
      updatedAt: undefined,
    },
    {
      orderId: 'C',
      symbol: 'AAA',
      executedPrice: 3,
      executedQuantity: -1,
      executedTime: 1,
      submittedAt: undefined,
      updatedAt: undefined,
    },
  ];
  assert.equal(sumOrderCost(orders), 20);
});

test('isBeforeCloseMinutes matches close window for normal day', () => {
  const at1545 = new Date(Date.UTC(2026, 1, 2, 7, 45));
  const at1544 = new Date(Date.UTC(2026, 1, 2, 7, 44));
  const at1555 = new Date(Date.UTC(2026, 1, 2, 7, 55));

  assert.equal(isBeforeCloseMinutes(at1545, 15, false), true);
  assert.equal(isBeforeCloseMinutes(at1544, 15, false), false);
  assert.equal(isBeforeClose15Minutes(at1545, false), true);
  assert.equal(isBeforeClose5Minutes(at1555, false), true);
});

test('isBeforeCloseMinutes matches close window for half day', () => {
  const at1155 = new Date(Date.UTC(2026, 1, 2, 3, 55));
  const at1144 = new Date(Date.UTC(2026, 1, 2, 3, 44));

  assert.equal(isBeforeCloseMinutes(at1155, 5, true), true);
  assert.equal(isBeforeCloseMinutes(at1144, 15, true), false);
  assert.equal(isBeforeClose5Minutes(at1155, true), true);
});
