import type { MonitorConfig, MultiMonitorTradingConfig } from '../../src/types/config.js';

export function createMonitorConfig(overrides: Partial<MonitorConfig> = {}): MonitorConfig {
  return {
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
      switchDistanceRangeBull: null,
      switchDistanceRangeBear: null,
    },
    orderOwnershipMapping: [],
    targetNotional: 5000,
    maxPositionNotional: 50000,
    maxDailyLoss: 3000,
    maxUnrealizedLossPerSymbol: 2000,
    buyIntervalSeconds: 60,
    liquidationCooldown: null,
    verificationConfig: {
      buy: {
        delaySeconds: 60,
        indicators: ['K', 'MACD'],
      },
      sell: {
        delaySeconds: 60,
        indicators: ['K', 'MACD'],
      },
    },
    signalConfig: {
      buycall: null,
      sellcall: null,
      buyput: null,
      sellput: null,
    },
    smartCloseEnabled: true,
    ...overrides,
  };
}

export function createTradingConfig(overrides: Partial<MultiMonitorTradingConfig> = {}): MultiMonitorTradingConfig {
  return {
    monitors: [createMonitorConfig()],
    global: {
      doomsdayProtection: true,
      debug: false,
      openProtection: {
        morning: {
          enabled: false,
          minutes: null,
        },
        afternoon: {
          enabled: false,
          minutes: null,
        },
      },
      orderMonitorPriceUpdateInterval: 1,
      tradingOrderType: 'ELO',
      liquidationOrderType: 'MO',
      buyOrderTimeout: {
        enabled: true,
        timeoutSeconds: 180,
      },
      sellOrderTimeout: {
        enabled: true,
        timeoutSeconds: 180,
      },
    },
    ...overrides,
  };
}
