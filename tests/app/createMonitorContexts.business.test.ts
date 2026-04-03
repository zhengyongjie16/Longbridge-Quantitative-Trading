/**
 * createMonitorContexts 业务测试
 *
 * 覆盖：
 * - 默认策略工厂按 monitor 配置构造策略实例
 * - 支持注入自定义策略工厂并逐 monitor 调用
 */
import { describe, expect, it } from 'bun:test';
import type { MutableMonitorContextsPostGateRuntime, PreGateRuntime } from '../../src/app/types.js';
import { createMonitorContexts } from '../../src/app/createMonitorContexts.js';
import { parseSignalConfig } from '../../src/config/utils.js';
import type { TradingSignalStrategyFactory } from '../../src/core/strategy/types.js';
import { createWarrantListCache } from '../../src/services/autoSymbolFinder/utils.js';
import type { MonitorConfig, MultiMonitorTradingConfig } from '../../src/types/config.js';
import type { Quote } from '../../src/types/quote.js';
import type { MonitorState } from '../../src/types/state.js';
import {
  createDailyLossTrackerDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createPositionCacheDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createSdkConfigDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';

function createMonitorState(monitorSymbol: string): MonitorState {
  return {
    monitorSymbol,
    monitorPrice: null,
    longPrice: null,
    shortPrice: null,
    signal: null,
    pendingDelayedSignals: [],
    monitorValues: null,
    lastMonitorSnapshot: null,
    lastCandlestickCacheVersion: null,
    incrementalIndicatorRuntime: null,
  };
}

function requireSignalConfig(configText: string) {
  const signalConfig = parseSignalConfig(configText);
  if (signalConfig === null) {
    throw new Error(`failed to parse signal config: ${configText}`);
  }

  return signalConfig;
}

function createTradingConfig(monitors: ReadonlyArray<MonitorConfig>): MultiMonitorTradingConfig {
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
      allowBuyOrderTrackingAboveInitialPrice: true,
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

function createRuntime(monitors: ReadonlyArray<MonitorConfig>): {
  preGateRuntime: PreGateRuntime;
  postGateRuntime: MutableMonitorContextsPostGateRuntime;
  quotesMap: ReadonlyMap<string, Quote | null>;
} {
  const symbolRegistry = createSymbolRegistryDouble({
    monitorSymbol: monitors[0]?.monitorSymbol ?? 'HSI.HK',
  });

  const monitorStates = new Map<string, MonitorState>();
  for (const monitor of monitors) {
    monitorStates.set(monitor.monitorSymbol, createMonitorState(monitor.monitorSymbol));
  }

  const trader = createTraderDouble();
  const marketDataClient = createMarketDataClientDouble();

  const preGateRuntime: PreGateRuntime = {
    config: createSdkConfigDouble(),
    tradingConfig: createTradingConfig(monitors),
    symbolRegistry,
    warrantListCache: createWarrantListCache(),
    warrantListCacheConfig: {
      cache: createWarrantListCache(),
      ttlMs: 60_000,
      nowMs: () => Date.now(),
    },
    marketDataClient,
    runMode: 'prod',
    gatePolicies: {
      startupGate: 'strict',
      runtimeGate: 'strict',
    },
    startupTradingDayInfo: {
      isTradingDay: true,
      isHalfDay: false,
    },
    startupGate: {
      wait: async () => ({
        isTradingDay: true,
        isHalfDay: false,
      }),
    },
  };

  const postGateRuntime: MutableMonitorContextsPostGateRuntime = {
    liquidationCooldownTracker: {
      recordLiquidationTrigger: () => ({
        currentCount: 1,
        cooldownActivated: false,
      }),
      recordCooldown: () => {},
      restoreTriggerCount: () => {},
      getRemainingMs: () => 0,
      clearMidnightEligible: () => {},
      resetAllTriggerCounts: () => {},
    },
    dailyLossTracker: createDailyLossTrackerDouble(),
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    monitorContexts: new Map(),
    refreshGate: {
      markStale: () => 0,
      markFresh: () => {},
      waitForFresh: async () => {},
      getStatus: () => ({
        currentVersion: 1,
        staleVersion: 1,
      }),
    },
    lastState: {
      canTrade: true,
      isHalfDay: false,
      openProtectionActive: false,
      currentDayKey: '2026-03-23',
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      targetTradingDayKey: null,
      isTradingEnabled: true,
      cachedAccount: null,
      cachedPositions: [],
      positionCache: createPositionCacheDouble(),
      cachedTradingDayInfo: {
        isTradingDay: true,
        isHalfDay: false,
      },
      monitorStates,
      allTradingSymbols: new Set<string>(),
    },
    trader,
    tradeLogHydrator: {
      hydrate: () => new Map<string, number>(),
    },
    loadTradingDayRuntimeSnapshot: async () => ({
      allOrders: [],
      quotesMap: new Map(),
    }),
    marketMonitor: {
      monitorPriceChanges: () => false,
      monitorIndicatorChanges: () => false,
    },
    doomsdayProtection: {
      shouldRejectBuy: () => false,
      executeClearance: async () => ({
        executed: false,
        signalCount: 0,
      }),
      cancelPendingBuyOrders: async () => ({
        executed: false,
        cancelRequestAcceptedCount: 0,
      }),
    },
    signalProcessor: {
      processSellSignals: ({ signals }) => signals,
      applyRiskChecks: async (signals) => signals,
      resetRiskCheckCooldown: () => {},
    },
    indicatorCache: {
      push: () => {},
      getAt: () => null,
      clearAll: () => {},
    },
    buyTaskQueue: {
      push: () => {},
      pop: () => null,
      isEmpty: () => true,
      removeTasks: () => 0,
      clearAll: () => 0,
      onTaskAdded: () => () => {},
    },
    sellTaskQueue: {
      push: () => {},
      pop: () => null,
      isEmpty: () => true,
      removeTasks: () => 0,
      clearAll: () => 0,
      onTaskAdded: () => () => {},
    },
    monitorTaskQueue: {
      scheduleLatest: () => {},
      pop: () => null,
      isEmpty: () => true,
      removeTasks: () => 0,
      clearAll: () => 0,
      onTaskAdded: () => () => {},
    },
  };

  return {
    preGateRuntime,
    postGateRuntime,
    quotesMap: new Map<string, Quote | null>(),
  };
}

describe('createMonitorContexts strategy factory behavior', () => {
  it('uses the default strategy factory and wires per-monitor verification config into strategy output', () => {
    const monitors: ReadonlyArray<MonitorConfig> = [
      createMonitorConfigDouble({
        originalIndex: 1,
        monitorSymbol: 'HSI.HK',
        signalConfig: {
          buycall: requireSignalConfig('(K>80)'),
          sellcall: null,
          buyput: null,
          sellput: null,
        },
        verificationConfig: {
          buy: {
            delaySeconds: 0,
            indicators: ['K'],
          },
          sell: {
            delaySeconds: 0,
            indicators: ['K'],
          },
        },
      }),
      createMonitorConfigDouble({
        originalIndex: 2,
        monitorSymbol: 'HSCEI.HK',
        signalConfig: {
          buycall: requireSignalConfig('(K>80)'),
          sellcall: null,
          buyput: null,
          sellput: null,
        },
        verificationConfig: {
          buy: {
            delaySeconds: 15,
            indicators: ['K'],
          },
          sell: {
            delaySeconds: 15,
            indicators: ['K'],
          },
        },
      }),
    ];
    const { preGateRuntime, postGateRuntime, quotesMap } = createRuntime(monitors);

    createMonitorContexts({
      preGateRuntime,
      postGateRuntime,
      quotesMap,
    });

    const firstContext = postGateRuntime.monitorContexts.get('HSI.HK');
    const secondContext = postGateRuntime.monitorContexts.get('HSCEI.HK');

    expect(firstContext).toBeDefined();
    expect(secondContext).toBeDefined();

    if (!firstContext || !secondContext) {
      throw new Error('expected monitor contexts to be created');
    }

    const firstSignals = firstContext.strategy.generateSignals(
      {
        price: 1,
        changePercent: 0,
        ema: null,
        rsi: null,
        psy: null,
        mfi: null,
        kdj: {
          k: 90,
          d: 80,
          j: 95,
        },
        macd: null,
        adx: null,
      },
      'BULL.HK',
      'BEAR.HK',
      postGateRuntime.trader.orderRecorder,
      firstContext.indicatorProfile,
    );

    const secondSignals = secondContext.strategy.generateSignals(
      {
        price: 1,
        changePercent: 0,
        ema: null,
        rsi: null,
        psy: null,
        mfi: null,
        kdj: {
          k: 90,
          d: 80,
          j: 95,
        },
        macd: null,
        adx: null,
      },
      'BULL.HK',
      'BEAR.HK',
      postGateRuntime.trader.orderRecorder,
      secondContext.indicatorProfile,
    );

    expect(firstSignals.immediateSignals.length).toBeGreaterThan(0);
    expect(firstSignals.delayedSignals.length).toBe(0);
    expect(secondSignals.immediateSignals.length).toBe(0);
    expect(secondSignals.delayedSignals.length).toBeGreaterThan(0);
  });

  it('supports injected strategy factory and passes each monitor config subset to the factory', () => {
    const monitors: ReadonlyArray<MonitorConfig> = [
      createMonitorConfigDouble({
        originalIndex: 1,
        monitorSymbol: 'HSI.HK',
      }),
      createMonitorConfigDouble({
        originalIndex: 2,
        monitorSymbol: 'HSCEI.HK',
      }),
    ];
    const { preGateRuntime, postGateRuntime, quotesMap } = createRuntime(monitors);
    const factoryCalls: string[] = [];
    const strategyFactory: TradingSignalStrategyFactory = (strategyConfig) => {
      const buyIndicators = strategyConfig.verificationConfig.buy.indicators ?? [];
      factoryCalls.push(buyIndicators.join(','));
      return {
        generateSignals: () => ({
          immediateSignals: [
            {
              symbol: `${buyIndicators.join('|')}.INJECTED`,
              action: 'BUYCALL',
              symbolName: null,
              seatVersion: null,
              triggerTime: new Date('2026-03-23T09:30:00.000Z'),
            },
          ],
          delayedSignals: [],
        }),
      };
    };

    createMonitorContexts({
      preGateRuntime,
      postGateRuntime,
      quotesMap,
      strategyFactory,
    });

    expect(factoryCalls).toHaveLength(2);

    const firstContext = postGateRuntime.monitorContexts.get('HSI.HK');
    const secondContext = postGateRuntime.monitorContexts.get('HSCEI.HK');
    if (!firstContext || !secondContext) {
      throw new Error('expected monitor contexts to be created');
    }

    const firstOutput = firstContext.strategy.generateSignals(
      null,
      'BULL.HK',
      'BEAR.HK',
      postGateRuntime.trader.orderRecorder,
      firstContext.indicatorProfile,
    );
    const secondOutput = secondContext.strategy.generateSignals(
      null,
      'BULL.HK',
      'BEAR.HK',
      postGateRuntime.trader.orderRecorder,
      secondContext.indicatorProfile,
    );

    expect(firstOutput.immediateSignals[0]?.symbol).toBe('K|MACD.INJECTED');
    expect(secondOutput.immediateSignals[0]?.symbol).toBe('K|MACD.INJECTED');
  });
});
