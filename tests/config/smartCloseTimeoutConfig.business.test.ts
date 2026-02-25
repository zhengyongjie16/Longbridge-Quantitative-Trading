/**
 * smartCloseTimeout 配置业务测试
 *
 * 功能：
 * - 验证 SMART_CLOSE_TIMEOUT_MINUTES_N 的解析与校验行为
 */
import { describe, expect, it } from 'bun:test';
import { createMultiMonitorTradingConfig } from '../../src/config/config.trading.js';
import { validateAllConfig } from '../../src/config/config.validator.js';
import { createMonitorConfigDouble } from '../helpers/testDoubles.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';

function createBaseEnv(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    MONITOR_SYMBOL_1: 'HSI.HK',
    ...overrides,
  };
}

describe('smart close timeout config', () => {
  it('解析空值/null/0/正整数', () => {
    const missingConfig = createMultiMonitorTradingConfig({
      env: createBaseEnv(),
    });
    expect(missingConfig.monitors[0]?.smartCloseTimeoutMinutes).toBeNull();

    const emptyConfig = createMultiMonitorTradingConfig({
      env: createBaseEnv({
        SMART_CLOSE_TIMEOUT_MINUTES_1: '',
      }),
    });
    expect(emptyConfig.monitors[0]?.smartCloseTimeoutMinutes).toBeNull();

    const nullConfig = createMultiMonitorTradingConfig({
      env: createBaseEnv({
        SMART_CLOSE_TIMEOUT_MINUTES_1: 'null',
      }),
    });
    expect(nullConfig.monitors[0]?.smartCloseTimeoutMinutes).toBeNull();

    const zeroConfig = createMultiMonitorTradingConfig({
      env: createBaseEnv({
        SMART_CLOSE_TIMEOUT_MINUTES_1: '0',
      }),
    });
    expect(zeroConfig.monitors[0]?.smartCloseTimeoutMinutes).toBe(0);

    const validConfig = createMultiMonitorTradingConfig({
      env: createBaseEnv({
        SMART_CLOSE_TIMEOUT_MINUTES_1: '30',
      }),
    });
    expect(validConfig.monitors[0]?.smartCloseTimeoutMinutes).toBe(30);
  });

  it('非法值（负数/非整数/非法字符串）在配置校验阶段报错', async () => {
    const signalConfig = {
      conditionGroups: [
        {
          conditions: [{ indicator: 'K', operator: '>', threshold: 1 }],
          requiredCount: 1,
        },
      ],
    } as const;

    const monitorConfig = createMonitorConfigDouble({
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

    const invalidValues = ['-3', '1.5', 'abc'] as const;
    for (const invalidValue of invalidValues) {
      let caughtError: unknown = null;
      try {
        await validateAllConfig({
          env: {
            LONGPORT_APP_KEY: 'k',
            LONGPORT_APP_SECRET: 's',
            LONGPORT_ACCESS_TOKEN: 't',
            SMART_CLOSE_TIMEOUT_MINUTES_1: invalidValue,
          },
          tradingConfig,
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).not.toBeNull();
      const validationError = caughtError as { missingFields?: ReadonlyArray<string> };
      expect(validationError.missingFields).toContain('SMART_CLOSE_TIMEOUT_MINUTES_1');
    }
  });
});
