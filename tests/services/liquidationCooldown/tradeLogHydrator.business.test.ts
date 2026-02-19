/**
 * tradeLogHydrator 业务测试
 *
 * 功能：
 * - 验证交易日志回放与清仓冷却恢复的场景与边界。
 */
import { describe, expect, it } from 'bun:test';

import { createTradingConfig, createMonitorConfig } from '../../../mock/factories/configFactory.js';
import { createTradeLogHydrator } from '../../../src/services/liquidationCooldown/tradeLogHydrator.js';

describe('tradeLogHydrator business flow', () => {
  it('skips hydration when today trade log does not exist', () => {
    const infoLogs: string[] = [];
    let recordCooldownCount = 0;

    const hydrator = createTradeLogHydrator({
      readFileSync: () => '[]',
      existsSync: () => false,
      cwd: () => 'D:/code/Longbridge-Quantitative-Trading',
      nowMs: () => Date.parse('2026-02-16T10:00:00+08:00'),
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
        recordCooldown: () => {
          recordCooldownCount += 1;
        },
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
      },
    });

    hydrator.hydrate({
      seatSymbols: [],
    });

    expect(recordCooldownCount).toBe(0);
    expect(infoLogs.some((line) => line.includes('当日成交日志不存在'))).toBe(true);
  });

  it('handles malformed json log without crashing', () => {
    let errorLogCount = 0;

    const hydrator = createTradeLogHydrator({
      readFileSync: () => '{invalid-json',
      existsSync: () => true,
      cwd: () => 'D:/code/Longbridge-Quantitative-Trading',
      nowMs: () => Date.parse('2026-02-16T10:00:00+08:00'),
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
        recordCooldown: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
      },
    });

    hydrator.hydrate({
      seatSymbols: [],
    });

    expect(errorLogCount).toBe(1);
  });

  it('restores latest protective-clearance cooldown by seat symbol and direction', () => {
    const recordCalls: Array<{
      symbol: string;
      direction: 'LONG' | 'SHORT';
      executedTimeMs: number;
    }> = [];
    let remainingQueryCount = 0;
    const infoLogs: string[] = [];

    const hydrator = createTradeLogHydrator({
      readFileSync: () => JSON.stringify([
        {
          symbol: 'BULL.HK',
          executedAtMs: 100,
          isProtectiveClearance: true,
        },
        {
          symbol: 'BULL.HK',
          executedAtMs: 200,
          isProtectiveClearance: true,
        },
        {
          symbol: 'BEAR.HK',
          executedAtMs: 150,
          isProtectiveClearance: false,
        },
        {
          symbol: 'OTHER.HK',
          executedAtMs: 300,
          isProtectiveClearance: true,
        },
      ]),
      existsSync: () => true,
      cwd: () => 'D:/code/Longbridge-Quantitative-Trading',
      nowMs: () => Date.parse('2026-02-16T10:00:00+08:00'),
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
          }),
        ],
      }),
      liquidationCooldownTracker: {
        recordCooldown: ({ symbol, direction, executedTimeMs }) => {
          recordCalls.push({ symbol, direction, executedTimeMs });
        },
        getRemainingMs: () => {
          remainingQueryCount += 1;
          return 10_000;
        },
        clearMidnightEligible: () => {},
      },
    });

    hydrator.hydrate({
      seatSymbols: [
        {
          monitorSymbol: 'HSI.HK',
          direction: 'LONG',
          symbol: 'BULL.HK',
        },
        {
          monitorSymbol: 'HSI.HK',
          direction: 'SHORT',
          symbol: 'BEAR.HK',
        },
      ],
    });

    expect(recordCalls).toEqual([
      {
        symbol: 'HSI.HK',
        direction: 'LONG',
        executedTimeMs: 200,
      },
    ]);
    expect(remainingQueryCount).toBe(1);
    expect(infoLogs.some((line) => line.includes('恢复冷却条数=1'))).toBe(true);
  });
});
