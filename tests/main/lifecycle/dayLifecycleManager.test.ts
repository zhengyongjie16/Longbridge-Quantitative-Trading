/**
 * 交易日生命周期管理器单元测试
 *
 * 覆盖：跨日检测、午夜清理顺序与失败重试、开盘重建触发条件与逆序执行、
 * 重试退避、边界（无 pendingOpenRebuild、非交易日、空 domains）
 */
import { describe, it, expect } from 'bun:test';
import type { Logger } from '../../../src/utils/logger/types.js';
import type {
  CacheDomain,
  LifecycleContext,
  LifecycleMutableState,
  LifecycleRuntimeFlags,
} from '../../../src/main/lifecycle/types.js';
import { createDayLifecycleManager } from '../../../src/main/lifecycle/dayLifecycleManager.js';
import { createRebuildTradingDayState } from '../../../src/main/lifecycle/rebuildTradingDayState.js';
import { createExternalApiRequestError } from '../../../src/utils/apiFailure/index.js';
import {
  createMonitorContextDouble,
  createQuoteDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';

function createMutableState(overrides?: Partial<LifecycleMutableState>): LifecycleMutableState {
  return {
    currentDayKey: null,
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    ...overrides,
  };
}

function createRuntime(overrides?: Partial<LifecycleRuntimeFlags>): LifecycleRuntimeFlags {
  return {
    dayKey: '2025-02-15',
    canTradeNow: true,
    isTradingDay: true,
    ...overrides,
  };
}

function createSilentLifecycleLogger(): Pick<Logger, 'info' | 'warn' | 'error'> {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

describe('createDayLifecycleManager', () => {
  describe('无跨日且无 pendingOpenRebuild', () => {
    it('保持 ACTIVE 且 isTradingEnabled 为 true', async () => {
      const mutableState = createMutableState({ currentDayKey: '2025-02-15' });
      const order: string[] = [];
      const domains: ReadonlyArray<CacheDomain> = [
        {
          midnightClear: () => {
            order.push('A-midnight');
          },
          openRebuild: () => {
            order.push('A-open');
          },
        },
      ];
      const manager = createDayLifecycleManager({
        mutableState,
        cacheDomains: domains,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });

      await manager.tick(new Date(), createRuntime({ dayKey: '2025-02-15' }));

      expect(mutableState.lifecycleState).toBe('ACTIVE');
      expect(mutableState.isTradingEnabled).toBe(true);
      expect(order).toHaveLength(0);
    });
  });

  describe('跨日触发午夜清理', () => {
    it('dayKey 变化时按注册顺序执行各 domain.midnightClear，成功后为 MIDNIGHT_CLEANED', async () => {
      const mutableState = createMutableState({ currentDayKey: '2025-02-14' });
      const order: string[] = [];
      const domains: ReadonlyArray<CacheDomain> = [
        {
          midnightClear: (ctx: LifecycleContext) => {
            order.push(`1-${ctx.runtime.dayKey}`);
          },
          openRebuild: () => {
            order.push('1-open');
          },
        },
        {
          midnightClear: (ctx: LifecycleContext) => {
            order.push(`2-${ctx.runtime.dayKey}`);
          },
          openRebuild: () => {
            order.push('2-open');
          },
        },
      ];
      const manager = createDayLifecycleManager({
        mutableState,
        cacheDomains: domains,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });

      await manager.tick(new Date(), createRuntime({ dayKey: '2025-02-15' }));

      expect(mutableState.lifecycleState).toBe('MIDNIGHT_CLEANED');
      expect(mutableState.pendingOpenRebuild).toBe(true);
      expect(mutableState.currentDayKey).toBe('2025-02-15');
      expect(mutableState.targetTradingDayKey).toBe('2025-02-15');
      expect(mutableState.isTradingEnabled).toBe(false);
      expect(order).toEqual(['1-2025-02-15', '2-2025-02-15']);
    });

    it('runtime.dayKey 为 null 时不触发午夜清理', async () => {
      const mutableState = createMutableState({ currentDayKey: '2025-02-14' });
      const order: string[] = [];
      const domains: ReadonlyArray<CacheDomain> = [
        {
          midnightClear: () => {
            order.push('midnight');
          },
          openRebuild: () => {},
        },
      ];
      const manager = createDayLifecycleManager({
        mutableState,
        cacheDomains: domains,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });

      await manager.tick(new Date(), createRuntime({ dayKey: null }));

      expect(mutableState.lifecycleState).toBe('ACTIVE');
      expect(order).toHaveLength(0);
    });

    it('午夜清理中某 domain 抛错时保持 MIDNIGHT_CLEANING 并安排重试', async () => {
      const mutableState = createMutableState({ currentDayKey: '2025-02-14' });
      const order: string[] = [];
      const domains: ReadonlyArray<CacheDomain> = [
        {
          midnightClear: () => {
            order.push('1');
          },
          openRebuild: () => {},
        },
        {
          midnightClear: () => {
            order.push('2');
            throw createExternalApiRequestError({
              operation: 'test.midnightClear',
              attempts: 1,
              cause: new Error('midnight clear fail'),
            });
          },
          openRebuild: () => {},
        },
      ];
      const manager = createDayLifecycleManager({
        mutableState,
        cacheDomains: domains,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        rebuildRetryDelayMs: 1000,
      });

      const now = new Date();
      await manager.tick(now, createRuntime({ dayKey: '2025-02-15' }));

      expect(mutableState.lifecycleState).toBe('MIDNIGHT_CLEANING');
      expect(mutableState.pendingOpenRebuild).toBe(false);
      expect(mutableState.currentDayKey).toBe('2025-02-14');
      expect(order).toEqual(['1', '2']);

      const later = new Date(now.getTime() + 2000);
      await manager.tick(later, createRuntime({ dayKey: '2025-02-15' }));
      expect(order).toEqual(['1', '2', '1', '2']);
    });

    it('重试时间未到时不再执行午夜清理', async () => {
      const mutableState = createMutableState({ currentDayKey: '2025-02-14' });
      const domains: ReadonlyArray<CacheDomain> = [
        {
          midnightClear: () => {
            throw createExternalApiRequestError({
              operation: 'test.lifecycle',
              attempts: 1,
              cause: new Error('fail'),
            });
          },
          openRebuild: () => {},
        },
      ];
      const manager = createDayLifecycleManager({
        mutableState,
        cacheDomains: domains,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        rebuildRetryDelayMs: 60_000,
      });

      const t0 = new Date();
      await manager.tick(t0, createRuntime({ dayKey: '2025-02-15' }));
      expect(mutableState.lifecycleState).toBe('MIDNIGHT_CLEANING');

      const t1 = new Date(t0.getTime() + 10_000);
      await manager.tick(t1, createRuntime({ dayKey: '2025-02-15' }));
      expect(mutableState.lifecycleState).toBe('MIDNIGHT_CLEANING');
    });

    it('跨失败交易日午夜清理时向 domain 传递 carryover 失效标记', async () => {
      const mutableState = createMutableState({
        currentDayKey: '2025-02-17',
        pendingOpenRebuild: true,
        lifecycleState: 'OPEN_REBUILD_FAILED',
        isTradingEnabled: false,
      });
      const flags: boolean[] = [];
      const domains: ReadonlyArray<CacheDomain> = [
        {
          midnightClear: (ctx: LifecycleContext) => {
            flags.push(ctx.invalidateSeatActivationCarryover === true);
          },
          openRebuild: () => {},
        },
      ];
      const manager = createDayLifecycleManager({
        mutableState,
        cacheDomains: domains,
        logger: createSilentLifecycleLogger(),
      });

      await manager.tick(
        new Date('2025-02-18T00:00:00.000+08:00'),
        createRuntime({ dayKey: '2025-02-18', isTradingDay: true, canTradeNow: false }),
      );

      expect(flags).toEqual([true]);
      expect(mutableState.lifecycleState).toBe('MIDNIGHT_CLEANED');
      expect(mutableState.pendingOpenRebuild).toBe(true);
    });

    it('跨失败交易日午夜清理首次失败后，重试时仍保留 carryover 失效标记', async () => {
      const mutableState = createMutableState({
        currentDayKey: '2025-02-17',
        pendingOpenRebuild: true,
        lifecycleState: 'OPEN_REBUILD_FAILED',
        isTradingEnabled: false,
      });
      let midnightAttemptCount = 0;
      const flags: boolean[] = [];
      const domains: ReadonlyArray<CacheDomain> = [
        {
          midnightClear: () => {
            midnightAttemptCount += 1;
            if (midnightAttemptCount === 1) {
              throw createExternalApiRequestError({
                operation: 'test.beforeSeatDomain',
                attempts: 1,
                cause: new Error('fail before seat domain'),
              });
            }
          },
          openRebuild: () => {},
        },
        {
          midnightClear: (ctx: LifecycleContext) => {
            flags.push(ctx.invalidateSeatActivationCarryover === true);
          },
          openRebuild: () => {},
        },
      ];
      const manager = createDayLifecycleManager({
        mutableState,
        cacheDomains: domains,
        logger: createSilentLifecycleLogger(),
        rebuildRetryDelayMs: 1_000,
      });

      const firstTick = await manager.tick(
        new Date('2025-02-18T00:00:00.000+08:00'),
        createRuntime({ dayKey: '2025-02-18', isTradingDay: true, canTradeNow: false }),
      );
      expect(firstTick.nextRetryAtMs).toBe(new Date('2025-02-18T00:00:01.000+08:00').getTime());
      expect(flags).toHaveLength(0);
      expect(mutableState.lifecycleState).toBe('MIDNIGHT_CLEANING');

      await manager.tick(
        new Date('2025-02-18T00:00:02.000+08:00'),
        createRuntime({ dayKey: '2025-02-18', isTradingDay: true, canTradeNow: false }),
      );

      expect(flags).toEqual([true]);
      expect(mutableState.lifecycleState).toBe('MIDNIGHT_CLEANED');
      expect(mutableState.pendingOpenRebuild).toBe(true);
    });
  });

  describe('pendingOpenRebuild 时开盘重建', () => {
    it('非交易日或不可交易时不执行开盘重建，保持门禁关闭', async () => {
      const mutableState = createMutableState({
        currentDayKey: '2025-02-15',
        pendingOpenRebuild: true,
        lifecycleState: 'MIDNIGHT_CLEANED',
        isTradingEnabled: false,
      });
      const order: string[] = [];
      const domains: ReadonlyArray<CacheDomain> = [
        {
          midnightClear: () => {},
          openRebuild: () => {
            order.push('open');
          },
        },
      ];
      const manager = createDayLifecycleManager({
        mutableState,
        cacheDomains: domains,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });

      await manager.tick(new Date(), createRuntime({ isTradingDay: false, canTradeNow: true }));
      expect(mutableState.lifecycleState).toBe('MIDNIGHT_CLEANED');
      expect(order).toHaveLength(0);

      await manager.tick(new Date(), createRuntime({ isTradingDay: true, canTradeNow: false }));
      expect(order).toHaveLength(0);
    });

    it('交易日状态未知时不执行开盘重建，保持门禁关闭', async () => {
      const mutableState = createMutableState({
        currentDayKey: '2025-02-15',
        pendingOpenRebuild: true,
        lifecycleState: 'MIDNIGHT_CLEANED',
        isTradingEnabled: false,
      });
      const order: string[] = [];
      const domains: ReadonlyArray<CacheDomain> = [
        {
          midnightClear: () => {},
          openRebuild: () => {
            order.push('open');
          },
        },
      ];
      const manager = createDayLifecycleManager({
        mutableState,
        cacheDomains: domains,
        logger: createSilentLifecycleLogger(),
      });

      await manager.tick(new Date(), createRuntime({ isTradingDay: null, canTradeNow: true }));

      expect(mutableState.lifecycleState).toBe('MIDNIGHT_CLEANED');
      expect(mutableState.isTradingEnabled).toBe(false);
      expect(order).toHaveLength(0);
    });

    it('pendingOpenRebuild 且 isTradingDay 且 canTradeNow 时按逆序执行 openRebuild，成功后 ACTIVE', async () => {
      const mutableState = createMutableState({
        currentDayKey: '2025-02-15',
        pendingOpenRebuild: true,
        lifecycleState: 'MIDNIGHT_CLEANED',
        isTradingEnabled: false,
      });
      const order: string[] = [];
      const domains: ReadonlyArray<CacheDomain> = [
        {
          midnightClear: () => {},
          openRebuild: () => {
            order.push('A');
          },
        },
        {
          midnightClear: () => {},
          openRebuild: () => {
            order.push('B');
          },
        },
        {
          midnightClear: () => {},
          openRebuild: () => {
            order.push('C');
          },
        },
      ];
      const manager = createDayLifecycleManager({
        mutableState,
        cacheDomains: domains,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });

      await manager.tick(new Date(), createRuntime());

      expect(mutableState.lifecycleState).toBe('ACTIVE');
      expect(mutableState.pendingOpenRebuild).toBe(false);
      expect(mutableState.targetTradingDayKey).toBe(null);
      expect(mutableState.isTradingEnabled).toBe(true);
      expect(order).toEqual(['C', 'B', 'A']);
    });

    it('开盘重建失败时转为 OPEN_REBUILD_FAILED 并安排重试', async () => {
      const mutableState = createMutableState({
        currentDayKey: '2025-02-15',
        pendingOpenRebuild: true,
        lifecycleState: 'MIDNIGHT_CLEANED',
        isTradingEnabled: false,
      });
      const order: string[] = [];
      const domains: ReadonlyArray<CacheDomain> = [
        {
          midnightClear: () => {},
          openRebuild: () => {
            order.push('A');
          },
        },
        {
          midnightClear: () => {},
          openRebuild: () => {
            order.push('B');
            throw createExternalApiRequestError({
              operation: 'test.openRebuild',
              attempts: 1,
              cause: new Error('open rebuild fail'),
            });
          },
        },
      ];
      const manager = createDayLifecycleManager({
        mutableState,
        cacheDomains: domains,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        rebuildRetryDelayMs: 1000,
      });

      await manager.tick(new Date(), createRuntime());

      expect(mutableState.lifecycleState).toBe('OPEN_REBUILD_FAILED');
      expect(mutableState.isTradingEnabled).toBe(false);
      expect(mutableState.pendingOpenRebuild).toBe(true);
      expect(order).toEqual(['B']);

      const later = new Date(Date.now() + 2000);
      await manager.tick(later, createRuntime());
      expect(order).toEqual(['B', 'B']);
    });

    it('开盘重建中的 warrant refresh ExternalApiRequestError 会进入 OPEN_REBUILD_FAILED 并安排重试', async () => {
      const mutableState = createMutableState({
        currentDayKey: '2025-02-15',
        pendingOpenRebuild: true,
        lifecycleState: 'MIDNIGHT_CLEANED',
        isTradingEnabled: false,
      });
      let warrantRefreshCalls = 0;
      const symbolRegistry = createSymbolRegistryDouble({
        monitorSymbol: 'HSI.HK',
      });
      const monitorContext = createMonitorContextDouble({
        symbolRegistry,
        riskChecker: {
          setWarrantInfoFromCallPrice: () => ({ status: 'ok', isWarrant: true }),
          refreshWarrantInfoForSymbol: async () => {
            warrantRefreshCalls += 1;
            throw createExternalApiRequestError({
              operation: 'QuoteContext.warrantQuote',
              attempts: 1,
              cause: new Error('warrant quote api down'),
            });
          },
          refreshUnrealizedLossData: async () => {},
        } as never,
      });
      const rebuildTradingDayState = createRebuildTradingDayState({
        marketDataClient: {
          getTradingDays: async () => ({
            tradingDays: ['2025-02-15'],
            halfTradingDays: [],
          }),
        } as never,
        trader: {
          recoverOrderTrackingFromSnapshot: async () => {},
        } as never,
        lastState: {
          tradingCalendarSnapshot: new Map(),
          cachedTradingDayInfo: null,
        } as never,
        symbolRegistry,
        monitorContexts: new Map([['HSI.HK', monitorContext]]),
        dailyLossTracker: {
          getLossOffset: () => 0,
        } as never,
        displayAccountAndPositions: async () => {},
      });
      const domains: ReadonlyArray<CacheDomain> = [
        {
          midnightClear: () => {},
          openRebuild: async () => {
            await rebuildTradingDayState({
              allOrders: [],
              quotesMap: new Map([
                ['HSI.HK', createQuoteDouble('HSI.HK', 20000)],
                ['BULL.HK', createQuoteDouble('BULL.HK', 1)],
              ]),
            });
          },
        },
      ];
      const manager = createDayLifecycleManager({
        mutableState,
        cacheDomains: domains,
        logger: createSilentLifecycleLogger(),
        rebuildRetryDelayMs: 1000,
      });

      await manager.tick(new Date(), createRuntime());

      expect(mutableState.lifecycleState).toBe('OPEN_REBUILD_FAILED');
      expect(mutableState.isTradingEnabled).toBe(false);
      expect(mutableState.pendingOpenRebuild).toBe(true);
      expect(warrantRefreshCalls).toBe(1);

      const later = new Date(Date.now() + 2000);
      await manager.tick(later, createRuntime());
      expect(warrantRefreshCalls).toBe(2);
    });

    it('开盘重建重试时间未到时不再执行', async () => {
      const mutableState = createMutableState({
        currentDayKey: '2025-02-15',
        pendingOpenRebuild: true,
        lifecycleState: 'MIDNIGHT_CLEANED',
        isTradingEnabled: false,
      });
      const domains: ReadonlyArray<CacheDomain> = [
        {
          midnightClear: () => {},
          openRebuild: () => {
            throw createExternalApiRequestError({
              operation: 'test.lifecycle',
              attempts: 1,
              cause: new Error('fail'),
            });
          },
        },
      ];
      const manager = createDayLifecycleManager({
        mutableState,
        cacheDomains: domains,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        rebuildRetryDelayMs: 60_000,
      });

      await manager.tick(new Date(), createRuntime());
      expect(mutableState.lifecycleState).toBe('OPEN_REBUILD_FAILED');

      await manager.tick(new Date(Date.now() + 10_000), createRuntime());
      expect(mutableState.lifecycleState).toBe('OPEN_REBUILD_FAILED');
    });

    it('开盘重建遇到非 API 错误时直接抛出且不进入 OPEN_REBUILD_FAILED retry', async () => {
      const mutableState = createMutableState({
        currentDayKey: '2025-02-15',
        pendingOpenRebuild: true,
        lifecycleState: 'MIDNIGHT_CLEANED',
        isTradingEnabled: false,
      });
      let openRebuildCalls = 0;
      const domains: ReadonlyArray<CacheDomain> = [
        {
          midnightClear: () => {},
          openRebuild: () => {
            openRebuildCalls += 1;
            throw new TypeError('open rebuild contract broken');
          },
        },
      ];
      const manager = createDayLifecycleManager({
        mutableState,
        cacheDomains: domains,
        logger: createSilentLifecycleLogger(),
        rebuildRetryDelayMs: 60_000,
      });

      let firstError: unknown = null;
      try {
        await manager.tick(new Date(), createRuntime());
      } catch (error) {
        firstError = error;
      }

      expect(firstError).toBeInstanceOf(TypeError);
      expect((firstError as Error).message).toBe('open rebuild contract broken');
      expect(mutableState.lifecycleState).not.toBe('OPEN_REBUILD_FAILED');
      expect(mutableState.pendingOpenRebuild).toBe(true);

      let secondError: unknown = null;
      try {
        await manager.tick(new Date(Date.now() + 10_000), createRuntime());
      } catch (error) {
        secondError = error;
      }

      expect(secondError).toBeInstanceOf(TypeError);
      expect((secondError as Error).message).toBe('open rebuild contract broken');
      expect(openRebuildCalls).toBe(2);
    });

    it('午夜清理成功进入新周期时清空上一轮开盘重建重试计划', async () => {
      const mutableState = createMutableState({
        currentDayKey: '2026-04-29',
        pendingOpenRebuild: true,
        lifecycleState: 'MIDNIGHT_CLEANED',
        targetTradingDayKey: '2026-04-29',
        isTradingEnabled: false,
      });
      const order: string[] = [];
      let openRebuildCallCount = 0;
      const domains: ReadonlyArray<CacheDomain> = [
        {
          midnightClear: () => {
            order.push('midnight');
          },
          openRebuild: () => {
            openRebuildCallCount += 1;
            order.push('open');
            if (openRebuildCallCount === 1) {
              throw createExternalApiRequestError({
                operation: 'test.openRebuild',
                attempts: 1,
                cause: new Error('open rebuild fail'),
              });
            }
          },
        },
      ];
      const manager = createDayLifecycleManager({
        mutableState,
        cacheDomains: domains,
        logger: createSilentLifecycleLogger(),
        rebuildRetryDelayMs: 86_400_000,
      });

      const failedRebuildResult = await manager.tick(
        new Date('2026-04-29T15:59:00.000+08:00'),
        createRuntime({ dayKey: '2026-04-29', isTradingDay: true, canTradeNow: true }),
      );
      expect(failedRebuildResult.nextRetryAtMs).toBe(
        new Date('2026-04-30T15:59:00.000+08:00').getTime(),
      );
      expect(mutableState.lifecycleState).toBe('OPEN_REBUILD_FAILED');

      const midnightResult = await manager.tick(
        new Date('2026-04-30T00:00:00.000+08:00'),
        createRuntime({ dayKey: '2026-04-30', isTradingDay: true, canTradeNow: false }),
      );
      expect(midnightResult.nextRetryAtMs).toBeNull();
      expect(midnightResult.pendingOpenRebuild).toBe(true);
      expect(mutableState.lifecycleState).toBe('MIDNIGHT_CLEANED');

      const openResult = await manager.tick(
        new Date('2026-04-30T09:30:00.000+08:00'),
        createRuntime({ dayKey: '2026-04-30', isTradingDay: true, canTradeNow: true }),
      );
      expect(openResult.nextRetryAtMs).toBeNull();
      expect(openResult.pendingOpenRebuild).toBe(false);
      expect(mutableState.lifecycleState).toBe('ACTIVE');
      expect(mutableState.isTradingEnabled).toBe(true);
      expect(order).toEqual(['open', 'midnight', 'open']);
    });
  });

  describe('tick 返回值', () => {
    it('午夜清理失败时返回下一次重试时间且不恢复交易门禁', async () => {
      const mutableState = createMutableState({ currentDayKey: '2026-04-28' });
      const manager = createDayLifecycleManager({
        mutableState,
        rebuildRetryDelayMs: 1_000,
        cacheDomains: [
          {
            midnightClear: () => {
              throw createExternalApiRequestError({
                operation: 'test.clear',
                attempts: 1,
                cause: new Error('clear failed'),
              });
            },
            openRebuild: () => {},
          },
        ],
        logger: createSilentLifecycleLogger(),
      });

      const now = new Date('2026-04-29T00:00:00.000+08:00');
      const result = await manager.tick(now, {
        dayKey: '2026-04-29',
        canTradeNow: false,
        isTradingDay: true,
      });

      expect(result.nextRetryAtMs).toBe(now.getTime() + 1_000);
      expect(result.pendingOpenRebuild).toBe(false);
      expect(mutableState.isTradingEnabled).toBe(false);
    });

    it('开盘重建失败时返回下一次重试时间', async () => {
      const mutableState = createMutableState({
        currentDayKey: '2026-04-29',
        lifecycleState: 'MIDNIGHT_CLEANED',
        pendingOpenRebuild: true,
        targetTradingDayKey: '2026-04-29',
        isTradingEnabled: false,
      });
      const manager = createDayLifecycleManager({
        mutableState,
        rebuildRetryDelayMs: 2_000,
        cacheDomains: [
          {
            midnightClear: () => {},
            openRebuild: () => {
              throw createExternalApiRequestError({
                operation: 'test.rebuild',
                attempts: 1,
                cause: new Error('rebuild failed'),
              });
            },
          },
        ],
        logger: createSilentLifecycleLogger(),
      });

      const now = new Date('2026-04-29T09:30:00.000+08:00');
      const result = await manager.tick(now, {
        dayKey: '2026-04-29',
        canTradeNow: true,
        isTradingDay: true,
      });

      expect(result.nextRetryAtMs).toBe(now.getTime() + 2_000);
      expect(result.pendingOpenRebuild).toBe(true);
      expect(mutableState.lifecycleState).toBe('OPEN_REBUILD_FAILED');
      expect(mutableState.isTradingEnabled).toBe(false);
    });

    it('无待重建时收敛到 ACTIVE 并返回无重试计划', async () => {
      const mutableState = createMutableState({
        currentDayKey: '2026-04-29',
        lifecycleState: 'OPEN_REBUILD_FAILED',
        pendingOpenRebuild: false,
        targetTradingDayKey: null,
        isTradingEnabled: false,
      });
      const manager = createDayLifecycleManager({
        mutableState,
        rebuildRetryDelayMs: 1_000,
        cacheDomains: [],
        logger: createSilentLifecycleLogger(),
      });

      const result = await manager.tick(new Date('2026-04-29T10:00:00.000+08:00'), {
        dayKey: '2026-04-29',
        canTradeNow: true,
        isTradingDay: true,
      });

      expect(result.nextRetryAtMs).toBeNull();
      expect(result.pendingOpenRebuild).toBe(false);
      expect(mutableState.lifecycleState).toBe('ACTIVE');
      expect(mutableState.isTradingEnabled).toBe(true);
    });
  });

  describe('边界', () => {
    it('domains 为空数组时午夜清理与开盘重建均不抛错', async () => {
      const mutableState = createMutableState({ currentDayKey: '2025-02-14' });
      const manager = createDayLifecycleManager({
        mutableState,
        cacheDomains: [],
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });

      await manager.tick(new Date(), createRuntime({ dayKey: '2025-02-15' }));
      expect(mutableState.lifecycleState).toBe('MIDNIGHT_CLEANED');
      expect(mutableState.pendingOpenRebuild).toBe(true);

      mutableState.currentDayKey = '2025-02-15';
      await manager.tick(new Date(), createRuntime());
      expect(mutableState.lifecycleState).toBe('ACTIVE');
    });

    it('支持 async midnightClear', async () => {
      const mutableState = createMutableState({ currentDayKey: '2025-02-14' });
      let resolved = false;
      const domains: ReadonlyArray<CacheDomain> = [
        {
          midnightClear: async () => {
            await Promise.resolve();
            resolved = true;
          },
          openRebuild: () => {},
        },
      ];
      const manager = createDayLifecycleManager({
        mutableState,
        cacheDomains: domains,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });

      await manager.tick(new Date(), createRuntime({ dayKey: '2025-02-15' }));
      expect(resolved).toBe(true);
      expect(mutableState.lifecycleState).toBe('MIDNIGHT_CLEANED');
    });

    it('支持 async openRebuild', async () => {
      const mutableState = createMutableState({
        currentDayKey: '2025-02-15',
        pendingOpenRebuild: true,
        lifecycleState: 'MIDNIGHT_CLEANED',
        isTradingEnabled: false,
      });
      let resolved = false;
      const domains: ReadonlyArray<CacheDomain> = [
        {
          midnightClear: () => {},
          openRebuild: async () => {
            await Promise.resolve();
            resolved = true;
          },
        },
      ];
      const manager = createDayLifecycleManager({
        mutableState,
        cacheDomains: domains,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });

      await manager.tick(new Date(), createRuntime());
      expect(resolved).toBe(true);
      expect(mutableState.lifecycleState).toBe('ACTIVE');
    });
  });
});
