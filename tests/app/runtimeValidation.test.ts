/**
 * app/runtimeValidation 单元测试
 *
 * 覆盖：
 * - 运行时标的收集会对监控标的、席位标的与持仓标的去重
 * - 自动寻标关闭时席位标的为 required，开启时为可选
 */
import { describe, expect, it } from 'bun:test';
import { collectRuntimeValidationSymbols } from '../../src/app/runtimeValidation.js';
import type { MultiMonitorTradingConfig } from '../../src/types/config.js';
import {
  createMonitorConfigDouble,
  createPositionDouble,
  createSymbolRegistryDouble,
} from '../helpers/testDoubles.js';

function createTradingConfig(
  monitors: MultiMonitorTradingConfig['monitors'],
): MultiMonitorTradingConfig {
  return {
    monitors,
    global: {
      doomsdayProtection: true,
      debug: false,
      openProtection: {
        morning: {
          enabled: true,
          minutes: 3,
        },
        afternoon: {
          enabled: true,
          minutes: 3,
        },
      },
      orderMonitorPriceUpdateInterval: 3,
      tradingOrderType: 'LO',
      liquidationOrderType: 'ELO',
      buyOrderTimeout: {
        enabled: true,
        timeoutSeconds: 30,
      },
      sellOrderTimeout: {
        enabled: true,
        timeoutSeconds: 30,
      },
    },
  };
}

describe('app runtimeValidation', () => {
  it('deduplicates monitor, seat and position symbols while keeping required seat symbols', () => {
    const tradingConfig = createTradingConfig([
      createMonitorConfigDouble({
        originalIndex: 1,
        monitorSymbol: 'HSI.HK',
        autoSearchConfig: {
          autoSearchEnabled: false,
          autoSearchMinDistancePctBull: null,
          autoSearchMinDistancePctBear: null,
          autoSearchMinTurnoverPerMinuteBull: null,
          autoSearchMinTurnoverPerMinuteBear: null,
          autoSearchOpenDelayMinutes: 0,
          autoSearchExpiryMinMonths: 0,
          switchIntervalMinutes: 0,
          switchDistanceRangeBull: null,
          switchDistanceRangeBear: null,
        },
      }),
    ]);
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'BULL.HK',
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'BEAR.HK',
        status: 'READY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatReadyAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });

    const collector = collectRuntimeValidationSymbols({
      tradingConfig,
      symbolRegistry,
      positions: [
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 100,
          availableQuantity: 100,
        }),
        createPositionDouble({
          symbol: 'EXTRA.HK',
          quantity: 100,
          availableQuantity: 100,
        }),
      ],
    });

    expect(collector.runtimeValidationInputs).toEqual([
      {
        symbol: 'HSI.HK',
        label: '监控标的 1',
        requireLotSize: false,
        required: true,
      },
      {
        symbol: 'BULL.HK',
        label: '做多席位标的 1',
        requireLotSize: true,
        required: true,
      },
      {
        symbol: 'BEAR.HK',
        label: '做空席位标的 1',
        requireLotSize: true,
        required: true,
      },
      {
        symbol: 'EXTRA.HK',
        label: '持仓标的',
        requireLotSize: false,
        required: false,
      },
    ]);
    expect([...collector.requiredSymbols]).toEqual(['HSI.HK', 'BULL.HK', 'BEAR.HK']);
  });

  it('marks seat symbols as optional when auto search is enabled', () => {
    const tradingConfig = createTradingConfig([
      createMonitorConfigDouble({
        originalIndex: 2,
        monitorSymbol: 'HSCEI.HK',
        autoSearchConfig: {
          autoSearchEnabled: true,
          autoSearchMinDistancePctBull: 0.35,
          autoSearchMinDistancePctBear: -0.35,
          autoSearchMinTurnoverPerMinuteBull: 1_000_000,
          autoSearchMinTurnoverPerMinuteBear: 1_000_000,
          autoSearchOpenDelayMinutes: 0,
          autoSearchExpiryMinMonths: 0,
          switchIntervalMinutes: 0,
          switchDistanceRangeBull: {
            min: 0.35,
            max: 0.8,
          },
          switchDistanceRangeBear: {
            min: -0.8,
            max: -0.35,
          },
        },
      }),
    ]);
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSCEI.HK',
    });

    const collector = collectRuntimeValidationSymbols({
      tradingConfig,
      symbolRegistry,
      positions: [],
    });

    expect(collector.runtimeValidationInputs[1]).toEqual({
      symbol: 'BULL.HK',
      label: '做多席位标的 2',
      requireLotSize: true,
      required: false,
    });

    expect(collector.runtimeValidationInputs[2]).toEqual({
      symbol: 'BEAR.HK',
      label: '做空席位标的 2',
      requireLotSize: true,
      required: false,
    });

    expect([...collector.requiredSymbols]).toEqual(['HSCEI.HK']);
  });
});
