/**
 * periodicSwitch 配置业务测试
 *
 * 功能：
 * - 验证周期换标间隔配置的解析边界与配置校验行为。
 */
import { describe, expect, it } from 'bun:test';

import { createMultiMonitorTradingConfig } from '../../src/config/config.trading.js';
import { validateAllConfig } from '../../src/config/config.validator.js';
import { createMonitorConfigDouble } from '../helpers/testDoubles.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';

function createBaseEnv(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    LONGBRIDGE_AUTH_MODE: 'oauth',
    LONGBRIDGE_CLIENT_ID: 'client-id',
    MONITOR_SYMBOL_1: 'HSI.HK',
    ...overrides,
  };
}

describe('periodic switch config business flow', () => {
  it('parses SWITCH_INTERVAL_MINUTES_1 with feature-gated fail-fast rules', () => {
    const missingConfig = createMultiMonitorTradingConfig({
      env: createBaseEnv(),
    });
    expect(missingConfig.monitors[0]?.autoSearchConfig.switchIntervalMinutes).toBe(0);

    const disabledConfig = createMultiMonitorTradingConfig({
      env: createBaseEnv({
        AUTO_SEARCH_ENABLED_1: 'false',
        SWITCH_INTERVAL_MINUTES_1: '999',
      }),
    });
    expect(disabledConfig.monitors[0]?.autoSearchConfig.switchIntervalMinutes).toBe(0);

    const validConfig = createMultiMonitorTradingConfig({
      env: createBaseEnv({
        AUTO_SEARCH_ENABLED_1: 'true',
        SWITCH_INTERVAL_MINUTES_1: '15',
      }),
    });
    expect(validConfig.monitors[0]?.autoSearchConfig.switchIntervalMinutes).toBe(15);

    expect(() =>
      createMultiMonitorTradingConfig({
        env: createBaseEnv({
          AUTO_SEARCH_ENABLED_1: 'true',
          SWITCH_INTERVAL_MINUTES_1: '-5',
        }),
      }),
    ).toThrow(/SWITCH_INTERVAL_MINUTES_1/);

    expect(() =>
      createMultiMonitorTradingConfig({
        env: createBaseEnv({
          AUTO_SEARCH_ENABLED_1: 'true',
          SWITCH_INTERVAL_MINUTES_1: '999',
        }),
      }),
    ).toThrow(/SWITCH_INTERVAL_MINUTES_1/);

    expect(() =>
      createMultiMonitorTradingConfig({
        env: createBaseEnv({
          AUTO_SEARCH_ENABLED_1: 'true',
          SWITCH_INTERVAL_MINUTES_1: 'invalid-number',
        }),
      }),
    ).toThrow(/SWITCH_INTERVAL_MINUTES_1/);
  });

  it('flags invalid SWITCH_INTERVAL_MINUTES_1 during config validation when auto-search is enabled', async () => {
    const signalConfig = {
      conditionGroups: [
        {
          conditions: [{ indicator: 'K', operator: '>', threshold: 1 }],
          requiredCount: 1,
        },
      ],
    } as const;

    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: 0.35,
        autoSearchMinDistancePctBear: -0.35,
        autoSearchMinTurnoverPerMinuteBull: 100_000,
        autoSearchMinTurnoverPerMinuteBear: 100_000,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: 0.2, max: 1.5 },
        switchDistanceRangeBear: { min: -1.5, max: -0.2 },
      },
      orderOwnershipMapping: ['HSI'],
      signalConfig: {
        buycall: signalConfig,
        sellcall: signalConfig,
        buyput: signalConfig,
        sellput: signalConfig,
      },
    });

    const tradingConfig = createTradingConfig({
      monitors: [monitorConfig],
    });

    const invalidValues = ['not-a-number', '-1', '121'] as const;
    for (const invalidValue of invalidValues) {
      let caughtError: unknown = null;
      try {
        await validateAllConfig({
          env: {
            LONGBRIDGE_AUTH_MODE: 'oauth',
            LONGBRIDGE_CLIENT_ID: 'client-id',
            AUTO_SEARCH_ENABLED_1: 'true',
            SWITCH_INTERVAL_MINUTES_1: invalidValue,
          },
          tradingConfig,
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).not.toBeNull();
      const validationError = caughtError as { missingFields?: ReadonlyArray<string> };
      expect(validationError.missingFields).toContain('SWITCH_INTERVAL_MINUTES_1');
    }
  });
});
