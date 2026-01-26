import assert from 'node:assert/strict';
import test from 'node:test';
import { createMultiMonitorTradingConfig } from '../dist/src/config/config.trading.js';

test('createMultiMonitorTradingConfig defaults liquidation cooldown minutes', () => {
  const config = createMultiMonitorTradingConfig({
    env: {
      MONITOR_SYMBOL_1: 'HSI.HK',
      LONG_SYMBOL_1: '68711.HK',
      SHORT_SYMBOL_1: '68712.HK',
    },
  });

  const [monitor] = config.monitors;
  assert.ok(monitor);
  assert.equal(monitor.liquidationCooldownMinutes, 30);
});
