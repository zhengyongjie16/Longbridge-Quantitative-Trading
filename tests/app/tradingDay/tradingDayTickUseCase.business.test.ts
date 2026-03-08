/**
 * tradingDayTickUseCase 业务测试
 *
 * 功能：
 * - 验证单次 tick 固定遵循 lifecycle tick 后再解析最终 gate 的顺序
 * - 验证主循环后续分支只消费最终 gate，而不是再次基于运行模式做第二套判定
 */
import { describe, expect, it } from 'bun:test';
import { createTradingDayTickUseCase } from '../../../src/app/tradingDay/tradingDayTickUseCase.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createPositionCacheDouble } from '../../helpers/testDoubles.js';
import type { LastState } from '../../../src/types/state.js';
import type { TradingDayTickUseCaseDeps } from '../../../src/app/tradingDay/types.js';

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

describe('tradingDayTickUseCase business flow', () => {
  it('executes lifecycle tick before final gate resolution and then advances cooldown/doomsday flow', async () => {
    const steps: string[] = [];
    const lastState = createLastState({
      lifecycleState: 'MIDNIGHT_CLEANED',
      isTradingEnabled: false,
      cachedPositions: [{ symbol: 'BULL.HK' }] as never,
    });
    const deps: TradingDayTickUseCaseDeps = {
      gatePolicyResolver: {
        resolveLifecycleInputs: async (currentTime) => {
          steps.push('resolveLifecycleInputs');
          return {
            currentTime,
            dayKey: '2026-03-08',
            isTradingDay: true,
            isHalfDay: false,
            canTradeNow: true,
            openProtectionActive: false,
          };
        },
        resolveFinalPolicy: ({ runtimeInputs, isTradingEnabled, lifecycleState }) => {
          steps.push('resolveFinalPolicy');
          return {
            ...runtimeInputs,
            runtimeGateMode: 'strict',
            executionGateOpen: isTradingEnabled,
            continuousSessionGateOpen: runtimeInputs.canTradeNow,
            signalGenerationGateOpen:
              isTradingEnabled &&
              runtimeInputs.canTradeNow &&
              !runtimeInputs.openProtectionActive,
            lifecycleState,
          };
        },
      },
      lastState,
      marketDataClient: {
        isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
      } as never,
      tradingConfig: createTradingConfig({
        global: {
          ...createTradingConfig().global,
          doomsdayProtection: true,
        },
      }),
      monitorContexts: new Map(),
      trader: {} as never,
      doomsdayProtection: {
        cancelPendingBuyOrders: async () => {
          steps.push('cancelPendingBuyOrders');
          return { executed: true, cancelledCount: 1 };
        },
        executeClearance: async () => {
          steps.push('executeClearance');
          return { executed: false, signalCount: 0 };
        },
      } as never,
      lossOffsetLifecycleCoordinator: {
        sync: async () => {
          steps.push('sync');
        },
      },
      dayLifecycleManager: {
        tick: async () => {
          steps.push('tick');
          lastState.lifecycleState = 'ACTIVE';
          lastState.isTradingEnabled = true;
        },
      },
      logger: {
        info: () => {},
      },
    };

    const useCase = createTradingDayTickUseCase(deps);
    const result = await useCase.execute();

    expect(steps).toEqual([
      'resolveLifecycleInputs',
      'tick',
      'resolveFinalPolicy',
      'sync',
      'cancelPendingBuyOrders',
      'executeClearance',
    ]);
    expect(result.shouldProcessMainFlow).toBeTrue();
    expect(result.gatePolicy.executionGateOpen).toBeTrue();
    expect(result.gatePolicy.continuousSessionGateOpen).toBeTrue();
  });

  it('short-circuits before doomsday when final continuous-session gate is closed', async () => {
    const steps: string[] = [];
    const lastState = createLastState();
    const useCase = createTradingDayTickUseCase({
      gatePolicyResolver: {
        resolveLifecycleInputs: async (currentTime) => {
          steps.push('resolveLifecycleInputs');
          return {
            currentTime,
            dayKey: '2026-03-08',
            isTradingDay: true,
            isHalfDay: false,
            canTradeNow: false,
            openProtectionActive: false,
          };
        },
        resolveFinalPolicy: ({ runtimeInputs, isTradingEnabled, lifecycleState }) => {
          steps.push('resolveFinalPolicy');
          return {
            ...runtimeInputs,
            runtimeGateMode: 'strict',
            executionGateOpen: isTradingEnabled,
            continuousSessionGateOpen: false,
            signalGenerationGateOpen: false,
            lifecycleState,
          };
        },
      },
      lastState,
      marketDataClient: {} as never,
      tradingConfig: createTradingConfig({
        global: {
          ...createTradingConfig().global,
          doomsdayProtection: true,
        },
      }),
      monitorContexts: new Map(),
      trader: {} as never,
      doomsdayProtection: {
        cancelPendingBuyOrders: async () => {
          steps.push('cancelPendingBuyOrders');
          return { executed: true, cancelledCount: 1 };
        },
        executeClearance: async () => {
          steps.push('executeClearance');
          return { executed: true, signalCount: 1 };
        },
      } as never,
      lossOffsetLifecycleCoordinator: {
        sync: async () => {
          steps.push('sync');
        },
      },
      dayLifecycleManager: {
        tick: async () => {
          steps.push('tick');
        },
      },
      logger: {
        info: () => {},
      },
    });

    const result = await useCase.execute();

    expect(steps).toEqual(['resolveLifecycleInputs', 'tick', 'resolveFinalPolicy', 'sync']);
    expect(result.shouldProcessMainFlow).toBeFalse();
    expect(result.gatePolicy.continuousSessionGateOpen).toBeFalse();
  });
});
