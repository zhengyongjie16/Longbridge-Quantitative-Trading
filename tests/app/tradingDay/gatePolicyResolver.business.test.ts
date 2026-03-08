/**
 * gatePolicyResolver 业务测试
 *
 * 功能：
 * - 验证最终门禁快照由 resolver 单点生成并写入 runtime store
 * - 验证离开连续交易时段时，待验证信号清理与 legacy lastState 投影仍保持一致
 */
import { describe, expect, it } from 'bun:test';
import { createGatePolicyResolver } from '../../../src/app/tradingDay/gatePolicyResolver.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createPositionCacheDouble } from '../../helpers/testDoubles.js';
import type { GatePolicySnapshot } from '../../../src/app/runtime/types.js';
import type { LastState, MonitorContext } from '../../../src/types/state.js';

function createLastState(overrides: Partial<LastState> = {}): LastState {
  return {
    canTrade: null,
    isHalfDay: null,
    openProtectionActive: null,
    currentDayKey: '2026-03-08',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: createPositionCacheDouble(),
    cachedTradingDayInfo: null,
    monitorStates: new Map(),
    allTradingSymbols: new Set(),
    ...overrides,
  };
}

function createMonitorContext(params: {
  readonly monitorSymbol: string;
  readonly pendingCount: number;
  readonly onCancel: (symbol: string) => void;
}): MonitorContext {
  const { monitorSymbol, pendingCount, onCancel } = params;
  return {
    config: { monitorSymbol },
    monitorSymbolName: monitorSymbol,
    delayedSignalVerifier: {
      getPendingCount: () => pendingCount,
      cancelAllForSymbol: (symbol: string) => {
        onCancel(symbol);
      },
    },
  } as unknown as MonitorContext;
}

describe('gatePolicyResolver business flow', () => {
  it('writes final gate snapshot and clears delayed signals only during final resolution', async () => {
    const cancelledSymbols: string[] = [];
    const capturedSnapshots: GatePolicySnapshot[] = [];
    const tradingConfig = createTradingConfig({
      global: {
        ...createTradingConfig().global,
        openProtection: {
          morning: { enabled: true, minutes: 15 },
          afternoon: { enabled: true, minutes: 15 },
        },
      },
    });
    const lastState = createLastState({
      canTrade: true,
      isHalfDay: false,
      openProtectionActive: false,
      cachedTradingDayInfo: {
        isTradingDay: true,
        isHalfDay: false,
      },
    });
    const monitorContexts = new Map<string, MonitorContext>([
      [
        'HSI.HK',
        createMonitorContext({
          monitorSymbol: 'HSI.HK',
          pendingCount: 2,
          onCancel: (symbol) => {
            cancelledSymbols.push(symbol);
          },
        }),
      ],
    ]);

    const resolver = createGatePolicyResolver({
      marketDataClient: {
        isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
      },
      lastState,
      tradingConfig,
      monitorContexts,
      runtimeGateMode: 'strict',
      logger: {
        info: () => {},
        warn: () => {},
      },
      getHKDateKey: () => '2026-03-08',
      isInContinuousHKSession: () => false,
      isWithinMorningOpenProtection: () => false,
      isWithinAfternoonOpenProtection: () => false,
      systemRuntimeStateStore: {
        getState: () => {
          throw new Error('not needed in test');
        },
        setCanTrade: () => {},
        setIsHalfDay: () => {},
        setOpenProtectionActive: () => {},
        setCurrentDayKey: () => {},
        setLifecycleState: () => {},
        setPendingOpenRebuild: () => {},
        setTargetTradingDayKey: () => {},
        setIsTradingEnabled: () => {},
        setCachedAccount: () => {},
        setCachedPositions: () => {},
        setGatePolicySnapshot: (snapshot) => {
          if (snapshot) {
            capturedSnapshots.push(snapshot);
          }
        },
      },
    });

    const runtimeInputs = await resolver.resolveLifecycleInputs(new Date('2026-03-08T01:05:00.000Z'));

    expect(cancelledSymbols).toEqual([]);
    expect(lastState.canTrade).toBeTrue();

    const gatePolicy = resolver.resolveFinalPolicy({
      runtimeInputs,
      lifecycleState: 'ACTIVE',
      isTradingEnabled: true,
    });

    expect(gatePolicy.continuousSessionGateOpen).toBeFalse();
    expect(gatePolicy.executionGateOpen).toBeTrue();
    expect(cancelledSymbols).toEqual(['HSI.HK']);
    expect(lastState.canTrade).toBeFalse();
    expect(lastState.isHalfDay).toBeFalse();
    expect(lastState.openProtectionActive).toBeFalse();
    expect(capturedSnapshots).toEqual([gatePolicy]);
  });

  it('projects skip-mode final gate into legacy fields and runtime snapshot', async () => {
    const capturedSnapshots: GatePolicySnapshot[] = [];
    const tradingConfig = createTradingConfig({
      global: {
        ...createTradingConfig().global,
        openProtection: {
          morning: { enabled: true, minutes: 15 },
          afternoon: { enabled: true, minutes: 15 },
        },
      },
    });
    const lastState = createLastState({
      cachedTradingDayInfo: {
        isTradingDay: false,
        isHalfDay: false,
      },
    });

    const resolver = createGatePolicyResolver({
      marketDataClient: {
        isTradingDay: async () => ({ isTradingDay: false, isHalfDay: false }),
      },
      lastState,
      tradingConfig,
      monitorContexts: new Map(),
      runtimeGateMode: 'skip',
      logger: {
        info: () => {},
        warn: () => {},
      },
      getHKDateKey: () => '2026-03-08',
      isInContinuousHKSession: () => false,
      isWithinMorningOpenProtection: () => true,
      isWithinAfternoonOpenProtection: () => true,
      systemRuntimeStateStore: {
        getState: () => {
          throw new Error('not needed in test');
        },
        setCanTrade: () => {},
        setIsHalfDay: () => {},
        setOpenProtectionActive: () => {},
        setCurrentDayKey: () => {},
        setLifecycleState: () => {},
        setPendingOpenRebuild: () => {},
        setTargetTradingDayKey: () => {},
        setIsTradingEnabled: () => {},
        setCachedAccount: () => {},
        setCachedPositions: () => {},
        setGatePolicySnapshot: (snapshot) => {
          if (snapshot) {
            capturedSnapshots.push(snapshot);
          }
        },
      },
    });

    const runtimeInputs = await resolver.resolveLifecycleInputs(new Date('2026-03-08T01:35:00.000Z'));
    const gatePolicy = resolver.resolveFinalPolicy({
      runtimeInputs,
      lifecycleState: 'ACTIVE',
      isTradingEnabled: true,
    });

    expect(gatePolicy.runtimeGateMode).toBe('skip');
    expect(gatePolicy.continuousSessionGateOpen).toBeTrue();
    expect(gatePolicy.signalGenerationGateOpen).toBeTrue();
    expect(lastState.canTrade).toBeTrue();
    expect(lastState.isHalfDay).toBeFalse();
    expect(lastState.openProtectionActive).toBeFalse();
    expect(capturedSnapshots).toEqual([gatePolicy]);
  });
});
