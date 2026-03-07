/**
 * autoSearchDistance 配置业务测试
 *
 * 功能：
 * - 验证自动寻标距离配置的运行时单位口径与降级区间校验行为。
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

function createAutoSearchMonitorConfig(
  overrides: {
    readonly autoSearchMinDistancePctBull?: number;
    readonly autoSearchMinDistancePctBear?: number;
    readonly switchDistanceRangeBull?: { readonly min: number; readonly max: number };
    readonly switchDistanceRangeBear?: { readonly min: number; readonly max: number };
  } = {},
) {
  const signalConfig = createSignalConfig();
  return createMonitorConfigDouble({
    autoSearchConfig: {
      autoSearchEnabled: true,
      autoSearchMinDistancePctBull: overrides.autoSearchMinDistancePctBull ?? 0.35,
      autoSearchMinDistancePctBear: overrides.autoSearchMinDistancePctBear ?? -0.35,
      autoSearchMinTurnoverPerMinuteBull: 100_000,
      autoSearchMinTurnoverPerMinuteBear: 100_000,
      autoSearchExpiryMinMonths: 3,
      autoSearchOpenDelayMinutes: 0,
      switchIntervalMinutes: 0,
      switchDistanceRangeBull: overrides.switchDistanceRangeBull ?? { min: 0.2, max: 1.5 },
      switchDistanceRangeBear: overrides.switchDistanceRangeBear ?? { min: -1.5, max: -0.2 },
    },
    orderOwnershipMapping: ['HSI'],
    signalConfig: {
      buycall: signalConfig,
      sellcall: signalConfig,
      buyput: signalConfig,
      sellput: signalConfig,
    },
  });
}

async function validateMonitorConfig(
  monitorConfig: ReturnType<typeof createAutoSearchMonitorConfig>,
): Promise<boolean> {
  try {
    await validateAllConfig({
      env: {
        LONGPORT_APP_KEY: 'k',
        LONGPORT_APP_SECRET: 's',
        LONGPORT_ACCESS_TOKEN: 't',
      },
      tradingConfig: createTradingConfig({
        monitors: [monitorConfig],
      }),
    });
    return true;
  } catch {
    return false;
  }
}

describe('auto search distance config business flow', () => {
  it('keeps AUTO_SEARCH_MIN_DISTANCE_PCT_* as percent-value runtime units', () => {
    const config = createMultiMonitorTradingConfig({
      env: createBaseEnv({
        AUTO_SEARCH_ENABLED_1: 'true',
        AUTO_SEARCH_MIN_DISTANCE_PCT_BULL_1: '0.35',
        AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR_1: '-0.35',
        SWITCH_DISTANCE_RANGE_BULL_1: '0.2,1.5',
        SWITCH_DISTANCE_RANGE_BEAR_1: '-1.5,-0.2',
      }),
    });

    expect(config.monitors[0]?.autoSearchConfig.autoSearchMinDistancePctBull).toBe(0.35);
    expect(config.monitors[0]?.autoSearchConfig.autoSearchMinDistancePctBear).toBe(-0.35);
    expect(config.monitors[0]?.autoSearchConfig.switchDistanceRangeBull).toEqual({
      min: 0.2,
      max: 1.5,
    });

    expect(config.monitors[0]?.autoSearchConfig.switchDistanceRangeBear).toEqual({
      min: -1.5,
      max: -0.2,
    });
  });

  it('accepts valid degraded-range relationships for bull and bear directions', async () => {
    const isValid = await validateMonitorConfig(createAutoSearchMonitorConfig());
    expect(isValid).toBe(true);
  });

  it('rejects bull degraded range when switchDistanceRange.min is equal to or above the primary threshold', async () => {
    const invalidEqual = await validateMonitorConfig(
      createAutoSearchMonitorConfig({
        autoSearchMinDistancePctBull: 0.35,
        switchDistanceRangeBull: { min: 0.35, max: 1.5 },
      }),
    );
    const invalidGreater = await validateMonitorConfig(
      createAutoSearchMonitorConfig({
        autoSearchMinDistancePctBull: 0.35,
        switchDistanceRangeBull: { min: 0.36, max: 1.5 },
      }),
    );

    expect(invalidEqual).toBe(false);
    expect(invalidGreater).toBe(false);
  });

  it('rejects bull degraded range when primary threshold is equal to or above switchDistanceRange.max', async () => {
    const invalidEqual = await validateMonitorConfig(
      createAutoSearchMonitorConfig({
        autoSearchMinDistancePctBull: 0.35,
        switchDistanceRangeBull: { min: 0.2, max: 0.35 },
      }),
    );
    const invalidGreater = await validateMonitorConfig(
      createAutoSearchMonitorConfig({
        autoSearchMinDistancePctBull: 0.35,
        switchDistanceRangeBull: { min: 0.2, max: 0.34 },
      }),
    );

    expect(invalidEqual).toBe(false);
    expect(invalidGreater).toBe(false);
  });

  it('rejects bear degraded range when switchDistanceRange.max is equal to or below the primary threshold', async () => {
    const invalidEqual = await validateMonitorConfig(
      createAutoSearchMonitorConfig({
        autoSearchMinDistancePctBear: -0.35,
        switchDistanceRangeBear: { min: -1.5, max: -0.35 },
      }),
    );
    const invalidLower = await validateMonitorConfig(
      createAutoSearchMonitorConfig({
        autoSearchMinDistancePctBear: -0.35,
        switchDistanceRangeBear: { min: -1.5, max: -0.36 },
      }),
    );

    expect(invalidEqual).toBe(false);
    expect(invalidLower).toBe(false);
  });

  it('rejects bear degraded range when switchDistanceRange.min is equal to or above the primary threshold', async () => {
    const invalidEqual = await validateMonitorConfig(
      createAutoSearchMonitorConfig({
        autoSearchMinDistancePctBear: -0.35,
        switchDistanceRangeBear: { min: -0.35, max: -0.2 },
      }),
    );
    const invalidGreater = await validateMonitorConfig(
      createAutoSearchMonitorConfig({
        autoSearchMinDistancePctBear: -0.35,
        switchDistanceRangeBear: { min: -0.34, max: -0.2 },
      }),
    );

    expect(invalidEqual).toBe(false);
    expect(invalidGreater).toBe(false);
  });
});
