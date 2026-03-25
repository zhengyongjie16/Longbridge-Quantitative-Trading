/**
 * tradingConfig fail-fast 业务测试
 *
 * 功能：
 * - 验证关键交易配置在显式非法/越界时立即失败。
 * - 验证关键配置缺失时仅保留业务允许的默认值。
 * - 验证解析层与校验层对关键配置的非法值判定一致。
 */
import { describe, expect, it } from 'bun:test';

import { createMultiMonitorTradingConfig } from '../../src/config/trading/index.js';
import { validateAllConfig } from '../../src/config/validator/index.js';
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

function createSignalConfig() {
  return {
    conditionGroups: [
      {
        conditions: [{ indicator: 'K', operator: '>', threshold: 1 }],
        requiredCount: 1,
      },
    ],
  } as const;
}

function createValidTradingConfigForValidation() {
  const signalConfig = createSignalConfig();
  const monitorConfig = createMonitorConfigDouble({
    orderOwnershipMapping: ['HSI'],
    signalConfig: {
      buycall: signalConfig,
      sellcall: signalConfig,
      buyput: signalConfig,
      sellput: signalConfig,
    },
  });

  return createTradingConfig({
    monitors: [monitorConfig],
  });
}

async function validateWithEnv(
  env: NodeJS.ProcessEnv,
  tradingConfig = createValidTradingConfigForValidation(),
): Promise<ReadonlyArray<string>> {
  try {
    await validateAllConfig({
      env,
      tradingConfig,
    });
    return [];
  } catch (error) {
    const validationError = error as { missingFields?: ReadonlyArray<string> };
    return validationError.missingFields ?? [];
  }
}

describe('trading config fail-fast parsing', () => {
  it('uses business defaults only when critical keys are missing', () => {
    const config = createMultiMonitorTradingConfig({
      env: createBaseEnv(),
    });

    const monitor = config.monitors[0];
    expect(monitor).toBeDefined();
    expect(monitor?.targetNotional).toBe(10_000);
    expect(monitor?.maxPositionNotional).toBe(100_000);
    expect(monitor?.buyIntervalSeconds).toBe(60);
    expect(monitor?.autoSearchConfig.switchIntervalMinutes).toBe(0);

    expect(config.global.buyOrderTimeout.timeoutSeconds).toBe(180);
    expect(config.global.sellOrderTimeout.timeoutSeconds).toBe(180);
    expect(config.global.orderMonitorPriceUpdateInterval).toBe(5);
  });

  it('accepts switchIntervalMinutes=0 as a valid business value', () => {
    const config = createMultiMonitorTradingConfig({
      env: createBaseEnv({
        AUTO_SEARCH_ENABLED_1: 'true',
        SWITCH_INTERVAL_MINUTES_1: '0',
      }),
    });

    expect(config.monitors[0]?.autoSearchConfig.switchIntervalMinutes).toBe(0);
  });

  it('ignores invalid switchIntervalMinutes when auto-search is disabled', async () => {
    const config = createMultiMonitorTradingConfig({
      env: createBaseEnv({
        AUTO_SEARCH_ENABLED_1: 'false',
        SWITCH_INTERVAL_MINUTES_1: '121',
      }),
    });

    expect(config.monitors[0]?.autoSearchConfig.switchIntervalMinutes).toBe(0);

    const disabledAutoSearchTradingConfig = createTradingConfig({
      monitors: [
        createMonitorConfigDouble({
          autoSearchConfig: {
            autoSearchEnabled: false,
            autoSearchMinDistancePctBull: null,
            autoSearchMinDistancePctBear: null,
            autoSearchMinTurnoverPerMinuteBull: null,
            autoSearchMinTurnoverPerMinuteBear: null,
            autoSearchExpiryMinMonths: 3,
            autoSearchOpenDelayMinutes: 5,
            switchIntervalMinutes: 0,
            switchDistanceRangeBull: null,
            switchDistanceRangeBear: null,
          },
          orderOwnershipMapping: ['HSI'],
          signalConfig: {
            buycall: createSignalConfig(),
            sellcall: createSignalConfig(),
            buyput: createSignalConfig(),
            sellput: createSignalConfig(),
          },
        }),
      ],
    });

    const missingFields = await validateWithEnv(
      createBaseEnv({
        AUTO_SEARCH_ENABLED_1: 'false',
        SWITCH_INTERVAL_MINUTES_1: '121',
      }),
      disabledAutoSearchTradingConfig,
    );
    expect(missingFields).not.toContain('SWITCH_INTERVAL_MINUTES_1');
  });

  it('ignores invalid timeout seconds when the corresponding timeout is disabled', async () => {
    const config = createMultiMonitorTradingConfig({
      env: createBaseEnv({
        BUY_ORDER_TIMEOUT_ENABLED: 'false',
        BUY_ORDER_TIMEOUT_SECONDS: '601',
        SELL_ORDER_TIMEOUT_ENABLED: 'false',
        SELL_ORDER_TIMEOUT_SECONDS: '29',
      }),
    });

    expect(config.global.buyOrderTimeout.timeoutSeconds).toBe(180);
    expect(config.global.sellOrderTimeout.timeoutSeconds).toBe(180);

    const validTradingConfig = createValidTradingConfigForValidation();
    const disabledTimeoutTradingConfig = {
      ...validTradingConfig,
      global: {
        ...validTradingConfig.global,
        buyOrderTimeout: {
          enabled: false,
          timeoutSeconds: 180,
        },
        sellOrderTimeout: {
          enabled: false,
          timeoutSeconds: 180,
        },
      },
    };
    expect(disabledTimeoutTradingConfig.global.buyOrderTimeout.enabled).toBe(false);
    expect(disabledTimeoutTradingConfig.global.sellOrderTimeout.enabled).toBe(false);

    const missingFields = await validateWithEnv(
      createBaseEnv({
        BUY_ORDER_TIMEOUT_ENABLED: 'false',
        BUY_ORDER_TIMEOUT_SECONDS: '601',
        SELL_ORDER_TIMEOUT_ENABLED: 'false',
        SELL_ORDER_TIMEOUT_SECONDS: '29',
      }),
      disabledTimeoutTradingConfig,
    );
    expect(missingFields).not.toContain('BUY_ORDER_TIMEOUT_SECONDS');
    expect(missingFields).not.toContain('SELL_ORDER_TIMEOUT_SECONDS');
  });

  it('throws ConfigValidationError directly from parser for critical monitor-level keys', () => {
    let caughtError: unknown = null;
    try {
      createMultiMonitorTradingConfig({
        env: createBaseEnv({
          TARGET_NOTIONAL_1: '0',
        }),
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).not.toBeNull();
    const validationError = caughtError as {
      readonly name?: string;
      readonly missingFields?: ReadonlyArray<string>;
      readonly message?: string;
    };
    expect(validationError.name).toBe('ConfigValidationError');
    expect(validationError.missingFields).toContain('TARGET_NOTIONAL_1');
    expect(validationError.message).toContain('TARGET_NOTIONAL_1');
  });

  it('throws ConfigValidationError directly for monitor index gaps', () => {
    let caughtError: unknown = null;
    try {
      createMultiMonitorTradingConfig({
        env: createBaseEnv({
          MONITOR_SYMBOL_3: 'HSCEI.HK',
        }),
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).not.toBeNull();
    const validationError = caughtError as {
      readonly name?: string;
      readonly missingFields?: ReadonlyArray<string>;
      readonly message?: string;
    };
    expect(validationError.name).toBe('ConfigValidationError');
    expect(validationError.missingFields).toContain('MONITOR_SYMBOL_2');
    expect(validationError.message).toContain('MONITOR_SYMBOL_2');
  });

  it('fails fast when critical monitor-level keys are explicitly invalid or out of range', () => {
    const invalidCases = [
      {
        envKey: 'TARGET_NOTIONAL_1',
        value: '0',
      },
      {
        envKey: 'TARGET_NOTIONAL_1',
        value: 'abc',
      },
      {
        envKey: 'MAX_POSITION_NOTIONAL_1',
        value: '-1',
      },
      {
        envKey: 'MAX_POSITION_NOTIONAL_1',
        value: 'abc',
      },
      {
        envKey: 'BUY_INTERVAL_SECONDS_1',
        value: '9',
      },
      {
        envKey: 'BUY_INTERVAL_SECONDS_1',
        value: '601',
      },
      {
        envKey: 'BUY_INTERVAL_SECONDS_1',
        value: 'abc',
      },
      {
        envKey: 'SWITCH_INTERVAL_MINUTES_1',
        value: '-1',
        extraEnv: {
          AUTO_SEARCH_ENABLED_1: 'true',
        },
      },
      {
        envKey: 'SWITCH_INTERVAL_MINUTES_1',
        value: '121',
        extraEnv: {
          AUTO_SEARCH_ENABLED_1: 'true',
        },
      },
      {
        envKey: 'SWITCH_INTERVAL_MINUTES_1',
        value: 'abc',
        extraEnv: {
          AUTO_SEARCH_ENABLED_1: 'true',
        },
      },
    ] as const;

    for (const testCase of invalidCases) {
      expect(() =>
        createMultiMonitorTradingConfig({
          env: createBaseEnv({
            ...('extraEnv' in testCase ? testCase.extraEnv : {}),
            [testCase.envKey]: testCase.value,
          }),
        }),
      ).toThrow(new RegExp(testCase.envKey));
    }
  });

  it('fails fast when critical global keys are explicitly invalid or out of range', () => {
    const invalidCases = [
      {
        envKey: 'BUY_ORDER_TIMEOUT_SECONDS',
        value: '29',
        extraEnv: {
          BUY_ORDER_TIMEOUT_ENABLED: 'true',
        },
      },
      {
        envKey: 'BUY_ORDER_TIMEOUT_SECONDS',
        value: '601',
        extraEnv: {
          BUY_ORDER_TIMEOUT_ENABLED: 'true',
        },
      },
      {
        envKey: 'BUY_ORDER_TIMEOUT_SECONDS',
        value: 'abc',
        extraEnv: {
          BUY_ORDER_TIMEOUT_ENABLED: 'true',
        },
      },
      {
        envKey: 'SELL_ORDER_TIMEOUT_SECONDS',
        value: '29',
        extraEnv: {
          SELL_ORDER_TIMEOUT_ENABLED: 'true',
        },
      },
      {
        envKey: 'SELL_ORDER_TIMEOUT_SECONDS',
        value: '601',
        extraEnv: {
          SELL_ORDER_TIMEOUT_ENABLED: 'true',
        },
      },
      {
        envKey: 'SELL_ORDER_TIMEOUT_SECONDS',
        value: 'abc',
        extraEnv: {
          SELL_ORDER_TIMEOUT_ENABLED: 'true',
        },
      },
      {
        envKey: 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL',
        value: '0',
      },
      {
        envKey: 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL',
        value: '61',
      },
      {
        envKey: 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL',
        value: 'abc',
      },
    ] as const;

    for (const testCase of invalidCases) {
      expect(() =>
        createMultiMonitorTradingConfig({
          env: createBaseEnv({
            ...('extraEnv' in testCase ? testCase.extraEnv : {}),
            [testCase.envKey]: testCase.value,
          }),
        }),
      ).toThrow(new RegExp(testCase.envKey));
    }
  });

  it('fails fast when monitor index has a gap (_1 and _3 exist while _2 is missing)', () => {
    expect(() =>
      createMultiMonitorTradingConfig({
        env: createBaseEnv({
          MONITOR_SYMBOL_3: 'HSCEI.HK',
        }),
      }),
    ).toThrow(/MONITOR_SYMBOL_2/);
  });
});

describe('trading config cross-monitor validator rules', () => {
  it('rejects ownership alias conflicts across monitors', async () => {
    const signalConfig = createSignalConfig();
    const tradingConfig = createTradingConfig({
      monitors: [
        createMonitorConfigDouble({
          originalIndex: 1,
          monitorSymbol: 'HSI.HK',
          longSymbol: 'BULL1.HK',
          shortSymbol: 'BEAR1.HK',
          orderOwnershipMapping: ['HSI'],
          signalConfig: {
            buycall: signalConfig,
            sellcall: signalConfig,
            buyput: signalConfig,
            sellput: signalConfig,
          },
        }),
        createMonitorConfigDouble({
          originalIndex: 2,
          monitorSymbol: 'HSCEI.HK',
          longSymbol: 'BULL2.HK',
          shortSymbol: 'BEAR2.HK',
          orderOwnershipMapping: ['HSI'],
          signalConfig: {
            buycall: signalConfig,
            sellcall: signalConfig,
            buyput: signalConfig,
            sellput: signalConfig,
          },
        }),
      ],
    });

    let caughtError: unknown = null;
    try {
      await validateAllConfig({
        env: createBaseEnv(),
        tradingConfig,
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).not.toBeNull();
    const validationError = caughtError as {
      message?: string;
      missingFields?: ReadonlyArray<string>;
    };
    expect(validationError.message).toContain('配置验证失败');
    expect(validationError.missingFields).toEqual([]);
  });

  it('rejects duplicated trading symbols across non-auto-search monitors', async () => {
    const signalConfig = createSignalConfig();
    const tradingConfig = createTradingConfig({
      monitors: [
        createMonitorConfigDouble({
          originalIndex: 1,
          monitorSymbol: 'HSI.HK',
          longSymbol: 'BULL.HK',
          shortSymbol: 'BEAR.HK',
          autoSearchConfig: {
            autoSearchEnabled: false,
            autoSearchMinDistancePctBull: null,
            autoSearchMinDistancePctBear: null,
            autoSearchMinTurnoverPerMinuteBull: null,
            autoSearchMinTurnoverPerMinuteBear: null,
            autoSearchExpiryMinMonths: 3,
            autoSearchOpenDelayMinutes: 5,
            switchIntervalMinutes: 0,
            switchDistanceRangeBull: null,
            switchDistanceRangeBear: null,
          },
          orderOwnershipMapping: ['HSI'],
          signalConfig: {
            buycall: signalConfig,
            sellcall: signalConfig,
            buyput: signalConfig,
            sellput: signalConfig,
          },
        }),
        createMonitorConfigDouble({
          originalIndex: 2,
          monitorSymbol: 'HSCEI.HK',
          longSymbol: 'BULL.HK',
          shortSymbol: 'BEAR2.HK',
          autoSearchConfig: {
            autoSearchEnabled: false,
            autoSearchMinDistancePctBull: null,
            autoSearchMinDistancePctBear: null,
            autoSearchMinTurnoverPerMinuteBull: null,
            autoSearchMinTurnoverPerMinuteBear: null,
            autoSearchExpiryMinMonths: 3,
            autoSearchOpenDelayMinutes: 5,
            switchIntervalMinutes: 0,
            switchDistanceRangeBull: null,
            switchDistanceRangeBear: null,
          },
          orderOwnershipMapping: ['HSCEI'],
          signalConfig: {
            buycall: signalConfig,
            sellcall: signalConfig,
            buyput: signalConfig,
            sellput: signalConfig,
          },
        }),
      ],
    });

    let caughtError: unknown = null;
    try {
      await validateAllConfig({
        env: createBaseEnv(),
        tradingConfig,
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).not.toBeNull();
    const validationError = caughtError as {
      message?: string;
      missingFields?: ReadonlyArray<string>;
    };
    expect(validationError.message).toContain('配置验证失败');
    expect(validationError.missingFields).toEqual([]);
  });

  it('skips duplicate trading-symbol checks for auto-search monitors', async () => {
    const signalConfig = createSignalConfig();
    const tradingConfig = createTradingConfig({
      monitors: [
        createMonitorConfigDouble({
          originalIndex: 1,
          monitorSymbol: 'HSI.HK',
          longSymbol: 'BULL.HK',
          shortSymbol: 'BEAR.HK',
          autoSearchConfig: {
            autoSearchEnabled: true,
            autoSearchMinDistancePctBull: 0.35,
            autoSearchMinDistancePctBear: -0.35,
            autoSearchMinTurnoverPerMinuteBull: 100_000,
            autoSearchMinTurnoverPerMinuteBear: 100_000,
            autoSearchExpiryMinMonths: 3,
            autoSearchOpenDelayMinutes: 5,
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
        }),
        createMonitorConfigDouble({
          originalIndex: 2,
          monitorSymbol: 'HSCEI.HK',
          longSymbol: 'BULL.HK',
          shortSymbol: 'BEAR.HK',
          autoSearchConfig: {
            autoSearchEnabled: true,
            autoSearchMinDistancePctBull: 0.35,
            autoSearchMinDistancePctBear: -0.35,
            autoSearchMinTurnoverPerMinuteBull: 100_000,
            autoSearchMinTurnoverPerMinuteBear: 100_000,
            autoSearchExpiryMinMonths: 3,
            autoSearchOpenDelayMinutes: 5,
            switchIntervalMinutes: 0,
            switchDistanceRangeBull: { min: 0.2, max: 1.5 },
            switchDistanceRangeBear: { min: -1.5, max: -0.2 },
          },
          orderOwnershipMapping: ['HSCEI'],
          signalConfig: {
            buycall: signalConfig,
            sellcall: signalConfig,
            buyput: signalConfig,
            sellput: signalConfig,
          },
        }),
      ],
    });

    const missingFields = await validateWithEnv(createBaseEnv(), tradingConfig);
    expect(missingFields).toEqual([]);
  });
});

describe('trading config fail-fast validator consistency', () => {
  it('matches parser semantics for critical monitor-level env keys', async () => {
    const autoSearchEnabledTradingConfig = createTradingConfig({
      monitors: [
        createMonitorConfigDouble({
          autoSearchConfig: {
            autoSearchEnabled: true,
            autoSearchMinDistancePctBull: 0.35,
            autoSearchMinDistancePctBear: -0.35,
            autoSearchMinTurnoverPerMinuteBull: 100_000,
            autoSearchMinTurnoverPerMinuteBear: 100_000,
            autoSearchExpiryMinMonths: 3,
            autoSearchOpenDelayMinutes: 5,
            switchIntervalMinutes: 0,
            switchDistanceRangeBull: { min: 0.2, max: 1.5 },
            switchDistanceRangeBear: { min: -1.5, max: -0.2 },
          },
          orderOwnershipMapping: ['HSI'],
          signalConfig: {
            buycall: createSignalConfig(),
            sellcall: createSignalConfig(),
            buyput: createSignalConfig(),
            sellput: createSignalConfig(),
          },
        }),
      ],
    });

    const invalidCases = [
      {
        envKey: 'TARGET_NOTIONAL_1',
        value: '0',
      },
      {
        envKey: 'TARGET_NOTIONAL_1',
        value: 'abc',
      },
      {
        envKey: 'MAX_POSITION_NOTIONAL_1',
        value: '-1',
      },
      {
        envKey: 'MAX_POSITION_NOTIONAL_1',
        value: 'abc',
      },
      {
        envKey: 'BUY_INTERVAL_SECONDS_1',
        value: '9',
      },
      {
        envKey: 'BUY_INTERVAL_SECONDS_1',
        value: '601',
      },
      {
        envKey: 'BUY_INTERVAL_SECONDS_1',
        value: 'abc',
      },
      {
        envKey: 'SWITCH_INTERVAL_MINUTES_1',
        value: '-1',
        extraEnv: {
          AUTO_SEARCH_ENABLED_1: 'true',
        },
      },
      {
        envKey: 'SWITCH_INTERVAL_MINUTES_1',
        value: '121',
        extraEnv: {
          AUTO_SEARCH_ENABLED_1: 'true',
        },
      },
      {
        envKey: 'SWITCH_INTERVAL_MINUTES_1',
        value: 'abc',
        extraEnv: {
          AUTO_SEARCH_ENABLED_1: 'true',
        },
      },
    ] as const;

    for (const testCase of invalidCases) {
      const missingFields = await validateWithEnv(
        createBaseEnv({
          ...('extraEnv' in testCase ? testCase.extraEnv : {}),
          [testCase.envKey]: testCase.value,
        }),
        'extraEnv' in testCase ? autoSearchEnabledTradingConfig : undefined,
      );
      expect(missingFields).toContain(testCase.envKey);
    }
  });

  it('matches parser semantics for critical global env keys', async () => {
    const invalidCases = [
      {
        envKey: 'BUY_ORDER_TIMEOUT_SECONDS',
        value: '29',
        extraEnv: {
          BUY_ORDER_TIMEOUT_ENABLED: 'true',
        },
      },
      {
        envKey: 'BUY_ORDER_TIMEOUT_SECONDS',
        value: '601',
        extraEnv: {
          BUY_ORDER_TIMEOUT_ENABLED: 'true',
        },
      },
      {
        envKey: 'BUY_ORDER_TIMEOUT_SECONDS',
        value: 'abc',
        extraEnv: {
          BUY_ORDER_TIMEOUT_ENABLED: 'true',
        },
      },
      {
        envKey: 'SELL_ORDER_TIMEOUT_SECONDS',
        value: '29',
        extraEnv: {
          SELL_ORDER_TIMEOUT_ENABLED: 'true',
        },
      },
      {
        envKey: 'SELL_ORDER_TIMEOUT_SECONDS',
        value: '601',
        extraEnv: {
          SELL_ORDER_TIMEOUT_ENABLED: 'true',
        },
      },
      {
        envKey: 'SELL_ORDER_TIMEOUT_SECONDS',
        value: 'abc',
        extraEnv: {
          SELL_ORDER_TIMEOUT_ENABLED: 'true',
        },
      },
      {
        envKey: 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL',
        value: '0',
      },
      {
        envKey: 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL',
        value: '61',
      },
      {
        envKey: 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL',
        value: 'abc',
      },
    ] as const;

    for (const testCase of invalidCases) {
      const missingFields = await validateWithEnv(
        createBaseEnv({
          ...('extraEnv' in testCase ? testCase.extraEnv : {}),
          [testCase.envKey]: testCase.value,
        }),
      );
      expect(missingFields).toContain(testCase.envKey);
    }
  });
});
