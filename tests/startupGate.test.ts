import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStartupGate } from '../src/main/startup/gate.js';

test('createStartupGate returns immediately in skip mode', async () => {
  let resolveCalls = 0;
  let sleepCalls = 0;

  const gate = createStartupGate({
    now: () => new Date(),
    sleep: async () => {
      sleepCalls += 1;
    },
    resolveTradingDayInfo: async () => {
      resolveCalls += 1;
      return { isTradingDay: false, isHalfDay: false };
    },
    isInSession: () => false,
    isInOpenProtection: () => true,
    openProtection: { enabled: true, minutes: 5 },
    intervalMs: 1000,
    logger: { info: () => undefined, debug: () => undefined, warn: () => undefined, error: () => undefined },
  });

  const info = await gate.wait({ mode: 'skip' });
  assert.deepEqual(info, { isTradingDay: true, isHalfDay: false });
  assert.equal(resolveCalls, 0);
  assert.equal(sleepCalls, 0);
});

test('createStartupGate waits for conditions in strict mode', async () => {
  let resolveCalls = 0;
  let sleepCalls = 0;

  const gate = createStartupGate({
    now: () => new Date(),
    sleep: async () => {
      sleepCalls += 1;
    },
    resolveTradingDayInfo: async () => {
      resolveCalls += 1;
      return resolveCalls === 1
        ? { isTradingDay: false, isHalfDay: false }
        : { isTradingDay: true, isHalfDay: false };
    },
    isInSession: () => true,
    isInOpenProtection: () => false,
    openProtection: { enabled: true, minutes: 5 },
    intervalMs: 1000,
    logger: { info: () => undefined, debug: () => undefined, warn: () => undefined, error: () => undefined },
  });

  const info = await gate.wait({ mode: 'strict' });
  assert.deepEqual(info, { isTradingDay: true, isHalfDay: false });
  assert.equal(resolveCalls, 2);
  assert.equal(sleepCalls, 1);
});

test('createStartupGate waits until open protection ends', async () => {
  let sleepCalls = 0;
  let openChecks = 0;

  const gate = createStartupGate({
    now: () => new Date(),
    sleep: async () => {
      sleepCalls += 1;
    },
    resolveTradingDayInfo: async () => ({ isTradingDay: true, isHalfDay: false }),
    isInSession: () => true,
    isInOpenProtection: () => {
      openChecks += 1;
      return openChecks === 1;
    },
    openProtection: { enabled: true, minutes: 5 },
    intervalMs: 1000,
    logger: { info: () => undefined, debug: () => undefined, warn: () => undefined, error: () => undefined },
  });

  const info = await gate.wait({ mode: 'strict' });
  assert.deepEqual(info, { isTradingDay: true, isHalfDay: false });
  assert.equal(sleepCalls, 1);
});
