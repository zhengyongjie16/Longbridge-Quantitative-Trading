/**
 * tradeLogHydrator 业务测试
 *
 * 功能：
 * - 验证交易日志回放时对触发计数器与冷却状态的恢复行为。
 */
import { describe, expect, it } from 'bun:test';
import path from 'node:path';

import type {
  RecordCooldownParams,
  RestoreTriggerCountParams,
} from '../../../src/services/liquidationCooldown/types.js';
import { createTradingConfig, createMonitorConfig } from '../../../mock/factories/configFactory.js';
import { createLiquidationCooldownTracker } from '../../../src/services/liquidationCooldown/index.js';
import { createTradeLogHydrator } from '../../../src/services/liquidationCooldown/tradeLogHydrator.js';

const TEST_LOG_ROOT_DIR = path.join(process.cwd(), 'tests', 'logs');

describe('tradeLogHydrator business flow', () => {
  it('skips hydration when today trade log does not exist', () => {
    const infoLogs: string[] = [];
    let recordCooldownCount = 0;
    let restoreTriggerCount = 0;

    const hydrator = createTradeLogHydrator({
      readFileSync: () => '[]',
      existsSync: () => false,
      resolveLogRootDir: () => TEST_LOG_ROOT_DIR,
      nowMs: () => 1_000,
      logger: {
        info: (message: string) => {
          infoLogs.push(message);
        },
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: () => {
          recordCooldownCount += 1;
        },
        restoreTriggerCount: () => {
          restoreTriggerCount += 1;
        },
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        sweepExpired: () => [],
        resetAllTriggerCounts: () => {},
      },
    });

    const result = hydrator.hydrate();

    expect(recordCooldownCount).toBe(0);
    expect(restoreTriggerCount).toBe(0);
    expect(result.segmentStartByDirection.size).toBe(0);
    expect(infoLogs.some((line) => line.includes('当日成交日志不存在'))).toBe(true);
  });

  it('handles malformed json log without crashing', () => {
    let errorLogCount = 0;

    const hydrator = createTradeLogHydrator({
      readFileSync: () => '{invalid-json',
      existsSync: () => true,
      resolveLogRootDir: () => TEST_LOG_ROOT_DIR,
      nowMs: () => 1_000,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {
          errorLogCount += 1;
        },
        debug: () => {},
      },
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        sweepExpired: () => [],
        resetAllTriggerCounts: () => {},
      },
    });

    const result = hydrator.hydrate();

    expect(errorLogCount).toBe(1);
    expect(result.segmentStartByDirection.size).toBe(0);
  });

  it('restores trigger count without activating cooldown when trigger limit is not reached', () => {
    const restoreCalls: RestoreTriggerCountParams[] = [];
    const recordCooldownCalls: RecordCooldownParams[] = [];

    const hydrator = createTradeLogHydrator({
      readFileSync: () =>
        JSON.stringify([
          {
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs: 100,
            isProtectiveClearance: true,
          },
          {
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs: 200,
            isProtectiveClearance: true,
          },
        ]),
      existsSync: () => true,
      resolveLogRootDir: () => TEST_LOG_ROOT_DIR,
      nowMs: () => 6_500_000,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      tradingConfig: createTradingConfig({
        monitors: [
          createMonitorConfig({
            monitorSymbol: 'HSI.HK',
            liquidationCooldown: { mode: 'minutes', minutes: 30 },
            liquidationTriggerLimit: 3,
          }),
        ],
      }),
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: (params) => {
          recordCooldownCalls.push(params);
        },
        restoreTriggerCount: (params) => {
          restoreCalls.push(params);
        },
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        sweepExpired: () => [],
        resetAllTriggerCounts: () => {},
      },
    });

    const result = hydrator.hydrate();

    expect(restoreCalls).toEqual([
      {
        symbol: 'HSI.HK',
        direction: 'LONG',
        count: 2,
      },
    ]);
    expect(recordCooldownCalls.length).toBe(0);
    expect(result.segmentStartByDirection.size).toBe(0);
  });

  it('restores cooldown when current cycle reached trigger limit and cooldown is still active', () => {
    const restoreCalls: RestoreTriggerCountParams[] = [];
    const recordCooldownCalls: RecordCooldownParams[] = [];
    let getRemainingMsCalls = 0;
    const infoLogs: string[] = [];

    const hydrator = createTradeLogHydrator({
      readFileSync: () =>
        JSON.stringify([
          {
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs: 100,
            isProtectiveClearance: true,
          },
          {
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs: 200,
            isProtectiveClearance: true,
          },
          {
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs: 300,
            isProtectiveClearance: true,
          },
        ]),
      existsSync: () => true,
      resolveLogRootDir: () => TEST_LOG_ROOT_DIR,
      nowMs: () => 1_000,
      logger: {
        info: (message: string) => {
          infoLogs.push(message);
        },
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      tradingConfig: createTradingConfig({
        monitors: [
          createMonitorConfig({
            monitorSymbol: 'HSI.HK',
            liquidationCooldown: { mode: 'minutes', minutes: 30 },
            liquidationTriggerLimit: 3,
          }),
        ],
      }),
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: (params) => {
          recordCooldownCalls.push(params);
        },
        restoreTriggerCount: (params) => {
          restoreCalls.push(params);
        },
        getRemainingMs: () => {
          getRemainingMsCalls += 1;
          return 10_000;
        },
        clearMidnightEligible: () => {},
        sweepExpired: () => [],
        resetAllTriggerCounts: () => {},
      },
    });

    const result = hydrator.hydrate();

    expect(restoreCalls).toEqual([
      {
        symbol: 'HSI.HK',
        direction: 'LONG',
        count: 3,
      },
    ]);

    expect(recordCooldownCalls).toEqual([
      {
        symbol: 'HSI.HK',
        direction: 'LONG',
        executedTimeMs: 300,
      },
    ]);
    expect(getRemainingMsCalls).toBe(0);
    expect(result.segmentStartByDirection.size).toBe(0);
    expect(infoLogs.some((line) => line.includes('当前周期触发 3/3'))).toBe(true);
  });

  it('restores only current cycle count after previous cooldown window expired', () => {
    const restoreCalls: RestoreTriggerCountParams[] = [];
    const recordCooldownCalls: RecordCooldownParams[] = [];

    const hydrator = createTradeLogHydrator({
      readFileSync: () =>
        JSON.stringify([
          {
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs: 10 * 60_000,
            isProtectiveClearance: true,
          },
          {
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs: 15 * 60_000,
            isProtectiveClearance: true,
          },
          {
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs: 30 * 60_000,
            isProtectiveClearance: true,
          },
          {
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs: 75 * 60_000,
            isProtectiveClearance: true,
          },
          {
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs: 90 * 60_000,
            isProtectiveClearance: true,
          },
        ]),
      existsSync: () => true,
      resolveLogRootDir: () => TEST_LOG_ROOT_DIR,
      nowMs: () => 6_500_000,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      tradingConfig: createTradingConfig({
        monitors: [
          createMonitorConfig({
            monitorSymbol: 'HSI.HK',
            liquidationCooldown: { mode: 'minutes', minutes: 30 },
            liquidationTriggerLimit: 3,
          }),
        ],
      }),
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: (params) => {
          recordCooldownCalls.push(params);
        },
        restoreTriggerCount: (params) => {
          restoreCalls.push(params);
        },
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        sweepExpired: () => [],
        resetAllTriggerCounts: () => {},
      },
    });

    const result = hydrator.hydrate();

    expect(restoreCalls).toEqual([
      {
        symbol: 'HSI.HK',
        direction: 'LONG',
        count: 2,
      },
    ]);
    expect(recordCooldownCalls.length).toBe(0);
    expect(result.segmentStartByDirection.get('HSI.HK:LONG')).toBe(3_600_000);
  });

  it('keeps latest expired segment boundary when a new-cycle cooldown is currently active', () => {
    const restoreCalls: RestoreTriggerCountParams[] = [];
    const recordCooldownCalls: RecordCooldownParams[] = [];

    const hydrator = createTradeLogHydrator({
      readFileSync: () =>
        JSON.stringify([
          {
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs: 0,
            isProtectiveClearance: true,
          },
          {
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs: 900_000,
            isProtectiveClearance: true,
          },
          {
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs: 1_800_000,
            isProtectiveClearance: true,
          },
          {
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs: 4_500_000,
            isProtectiveClearance: true,
          },
          {
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs: 5_400_000,
            isProtectiveClearance: true,
          },
          {
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs: 6_300_000,
            isProtectiveClearance: true,
          },
        ]),
      existsSync: () => true,
      resolveLogRootDir: () => TEST_LOG_ROOT_DIR,
      nowMs: () => 6_500_000,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      tradingConfig: createTradingConfig({
        monitors: [
          createMonitorConfig({
            monitorSymbol: 'HSI.HK',
            liquidationCooldown: { mode: 'minutes', minutes: 30 },
            liquidationTriggerLimit: 3,
          }),
        ],
      }),
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: (params) => {
          recordCooldownCalls.push(params);
        },
        restoreTriggerCount: (params) => {
          restoreCalls.push(params);
        },
        getRemainingMs: () => 10_000,
        clearMidnightEligible: () => {},
        sweepExpired: () => [],
        resetAllTriggerCounts: () => {},
      },
    });

    const result = hydrator.hydrate();

    expect(restoreCalls).toEqual([
      {
        symbol: 'HSI.HK',
        direction: 'LONG',
        count: 3,
      },
    ]);

    expect(recordCooldownCalls).toEqual([
      {
        symbol: 'HSI.HK',
        direction: 'LONG',
        executedTimeMs: 6_300_000,
      },
    ]);
    expect(result.segmentStartByDirection.get('HSI.HK:LONG')).toBe(3_600_000);
  });

  it('does not restore expired cooldown into tracker when the last cooldown window has already ended', () => {
    const restoreCalls: RestoreTriggerCountParams[] = [];
    const recordCooldownCalls: RecordCooldownParams[] = [];

    const hydrator = createTradeLogHydrator({
      readFileSync: () =>
        JSON.stringify([
          {
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs: 0,
            isProtectiveClearance: true,
          },
          {
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs: 900_000,
            isProtectiveClearance: true,
          },
          {
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs: 1_800_000,
            isProtectiveClearance: true,
          },
        ]),
      existsSync: () => true,
      resolveLogRootDir: () => TEST_LOG_ROOT_DIR,
      nowMs: () => 3_700_000,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      tradingConfig: createTradingConfig({
        monitors: [
          createMonitorConfig({
            monitorSymbol: 'HSI.HK',
            liquidationCooldown: { mode: 'minutes', minutes: 30 },
            liquidationTriggerLimit: 3,
          }),
        ],
      }),
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: (params) => {
          recordCooldownCalls.push(params);
        },
        restoreTriggerCount: (params) => {
          restoreCalls.push(params);
        },
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        sweepExpired: () => [],
        resetAllTriggerCounts: () => {},
      },
    });

    const result = hydrator.hydrate();

    expect(restoreCalls).toEqual([]);
    expect(recordCooldownCalls).toEqual([]);
    expect(result.segmentStartByDirection.get('HSI.HK:LONG')).toBe(3_600_000);
  });

  it('restores active cooldown into the real tracker before startup risk checks', () => {
    const liquidationCooldownTracker = createLiquidationCooldownTracker({
      nowMs: () => 2_000_000,
    });

    const hydrator = createTradeLogHydrator({
      readFileSync: () =>
        JSON.stringify([
          {
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs: 600_000,
            isProtectiveClearance: true,
          },
          {
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs: 1_200_000,
            isProtectiveClearance: true,
          },
          {
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs: 1_800_000,
            isProtectiveClearance: true,
          },
        ]),
      existsSync: () => true,
      resolveLogRootDir: () => TEST_LOG_ROOT_DIR,
      nowMs: () => 2_000_000,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      tradingConfig: createTradingConfig({
        monitors: [
          createMonitorConfig({
            monitorSymbol: 'HSI.HK',
            liquidationCooldown: { mode: 'minutes', minutes: 30 },
            liquidationTriggerLimit: 3,
          }),
        ],
      }),
      liquidationCooldownTracker,
    });

    const result = hydrator.hydrate();
    const remainingMs = liquidationCooldownTracker.getRemainingMs({
      symbol: 'HSI.HK',
      direction: 'LONG',
      cooldownConfig: { mode: 'minutes', minutes: 30 },
      currentTimeMs: 2_000_000,
    });

    expect(remainingMs).toBe(1_600_000);
    expect(result.segmentStartByDirection.size).toBe(0);
  });
});
