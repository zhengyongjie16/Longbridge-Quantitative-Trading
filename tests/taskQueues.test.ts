import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBuyTaskQueue, createSellTaskQueue } from '../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createMonitorTaskQueue } from '../src/main/asyncProgram/monitorTaskQueue/index.js';
import { createSignal } from './utils.js';

test('tradeTaskQueue dequeues FIFO and triggers callback', () => {
  const queue = createBuyTaskQueue();
  let callbackCount = 0;
  queue.onTaskAdded(() => {
    callbackCount += 1;
  });

  const signalA = createSignal({ symbol: 'BULL1.HK', action: 'BUYCALL' });
  const signalB = createSignal({ symbol: 'BULL2.HK', action: 'BUYCALL' });

  queue.push({ type: 'IMMEDIATE_BUY', data: signalA, monitorSymbol: 'HSI.HK' });
  queue.push({ type: 'VERIFIED_BUY', data: signalB, monitorSymbol: 'HSI.HK' });

  assert.equal(queue.size(), 2);
  assert.equal(callbackCount, 2);

  const first = queue.pop();
  const second = queue.pop();

  assert.equal(first?.data, signalA);
  assert.equal(second?.data, signalB);
  assert.equal(queue.isEmpty(), true);
});

test('tradeTaskQueue removes tasks by predicate', () => {
  const queue = createSellTaskQueue();
  const removed: string[] = [];

  const signalA = createSignal({ symbol: 'BEAR1.HK', action: 'SELLPUT' });
  const signalB = createSignal({ symbol: 'BEAR2.HK', action: 'SELLPUT' });

  queue.push({ type: 'IMMEDIATE_SELL', data: signalA, monitorSymbol: 'HSI.HK' });
  queue.push({ type: 'VERIFIED_SELL', data: signalB, monitorSymbol: 'HSI.HK' });

  const removedCount = queue.removeTasks(
    (task) => task.data.symbol === 'BEAR1.HK',
    (task) => removed.push(task.data.symbol),
  );

  assert.equal(removedCount, 1);
  assert.deepEqual(removed, ['BEAR1.HK']);
  assert.equal(queue.size(), 1);
  assert.equal(queue.peek()?.data.symbol, 'BEAR2.HK');
});

test('monitorTaskQueue scheduleLatest dedupes by key', () => {
  const queue = createMonitorTaskQueue<'TASK', { readonly index: number }>();
  let addedCount = 0;
  queue.onTaskAdded(() => {
    addedCount += 1;
  });

  queue.scheduleLatest({
    type: 'TASK',
    dedupeKey: 'M1:TASK',
    monitorSymbol: 'HSI.HK',
    data: { index: 1 },
  });

  queue.scheduleLatest({
    type: 'TASK',
    dedupeKey: 'M1:TASK',
    monitorSymbol: 'HSI.HK',
    data: { index: 2 },
  });

  assert.equal(queue.size(), 1);
  assert.equal(addedCount, 2);
  assert.equal(queue.peek()?.data.index, 2);
});
