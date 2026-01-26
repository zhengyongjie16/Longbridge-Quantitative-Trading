import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiquidationCooldownTracker } from '../dist/src/core/liquidationCooldown/index.js';

test('recordCooldown exposes remaining time in range', () => {
  const nowMs = 1_000_000;
  const symbol = 'HK.00001';
  const direction = 'LONG';
  const executedTimeMs = nowMs - 30_000;
  const cooldownMinutes = 1;
  const expectedRemainingMs = 30_000;
  const tracker = createLiquidationCooldownTracker({ nowMs: () => nowMs });

  tracker.recordCooldown({
    symbol,
    direction,
    executedTimeMs,
  });

  const remainingMs = tracker.getRemainingMs({
    symbol,
    direction,
    cooldownMinutes,
  });

  assert.equal(remainingMs, expectedRemainingMs);
});
