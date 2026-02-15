/**
 * 交易日生命周期管理器单元测试
 *
 * 覆盖：跨日检测、午夜清理顺序与失败重试、开盘重建触发条件与逆序执行、
 * 重试退避、边界（无 pendingOpenRebuild、非交易日、空 domains）
 */
import { describe, it, expect } from 'bun:test';
import type {
  CacheDomain,
  LifecycleContext,
  LifecycleMutableState,
  LifecycleRuntimeFlags,
} from '../../../src/main/lifecycle/types.js';
import { createDayLifecycleManager } from '../../../src/main/lifecycle/dayLifecycleManager.js';

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
            throw new Error('midnight clear fail');
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
            throw new Error('fail');
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

    it('pendingOpenRebuild 且 isTradingDay 且 canTradeNow 时按逆序执行 openRebuild，成功后 ACTIVE', async () => {
      const mutableState = createMutableState({
        currentDayKey: '2025-02-15',
        pendingOpenRebuild: true,
        lifecycleState: 'MIDNIGHT_CLEANED',
        isTradingEnabled: false,
      });
      const order: string[] = [];
      const domains: ReadonlyArray<CacheDomain> = [
        { midnightClear: () => {}, openRebuild: () => { order.push('A'); } },
        { midnightClear: () => {}, openRebuild: () => { order.push('B'); } },
        { midnightClear: () => {}, openRebuild: () => { order.push('C'); } },
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
        { midnightClear: () => {}, openRebuild: () => { order.push('A'); } },
        {
          midnightClear: () => {},
          openRebuild: () => {
            order.push('B');
            throw new Error('open rebuild fail');
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
            throw new Error('fail');
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
      expect(mutableState.lifecycleState as string).toBe('ACTIVE');
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
