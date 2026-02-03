import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __test__ as monitorTaskProcessorTest } from '../src/main/asyncProgram/monitorTaskProcessor/index.js';
import { isSeatReady } from '../src/services/autoSymbolManager/utils.js';

import type { MonitorTaskContext } from '../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { SeatState } from '../src/types/index.js';

const createContext = (
  longSeat: SeatState,
  shortSeat: SeatState,
): MonitorTaskContext => {
  const symbolRegistry = {
    getSeatState: (_monitorSymbol: string, direction: 'LONG' | 'SHORT') => {
      return direction === 'LONG' ? longSeat : shortSeat;
    },
  };

  return {
    symbolRegistry,
  } as unknown as MonitorTaskContext;
};

test('resolveSeatSnapshotReadiness gates by snapshot validity and predicate', () => {
  const monitorSymbol = 'MONITOR.READINESS';
  const longSeat: SeatState = {
    symbol: 'LONG.SYMBOL',
    status: 'READY',
    lastSwitchAt: null,
    lastSearchAt: null,
  };
  const shortSeat: SeatState = {
    symbol: null,
    status: 'EMPTY',
    lastSwitchAt: null,
    lastSearchAt: null,
  };
  const context = createContext(longSeat, shortSeat);

  const result = monitorTaskProcessorTest.resolveSeatSnapshotReadiness({
    monitorSymbol,
    context,
    snapshotValidity: { longValid: true, shortValid: true },
    isSeatUsable: (seat: SeatState) =>
      typeof seat.symbol === 'string' && seat.symbol.length > 0,
  });

  assert.equal(result.isLongReady, true);
  assert.equal(result.longSymbol, 'LONG.SYMBOL');
  assert.equal(result.isShortReady, false);
  assert.equal(result.shortSymbol, '');
});

test('resolveSeatSnapshotReadiness respects readiness predicate', () => {
  const monitorSymbol = 'MONITOR.READY';
  const longSeat: SeatState = {
    symbol: 'LONG.SWITCHING',
    status: 'SWITCHING',
    lastSwitchAt: null,
    lastSearchAt: null,
  };
  const shortSeat: SeatState = {
    symbol: 'SHORT.READY',
    status: 'READY',
    lastSwitchAt: null,
    lastSearchAt: null,
  };
  const context = createContext(longSeat, shortSeat);

  const result = monitorTaskProcessorTest.resolveSeatSnapshotReadiness({
    monitorSymbol,
    context,
    snapshotValidity: { longValid: true, shortValid: true },
    isSeatUsable: isSeatReady,
  });

  assert.equal(result.isLongReady, false);
  assert.equal(result.longSymbol, '');
  assert.equal(result.isShortReady, true);
  assert.equal(result.shortSymbol, 'SHORT.READY');
});
