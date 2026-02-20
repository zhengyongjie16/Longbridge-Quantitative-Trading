/**
 * 跨日清理与开盘重建全链路集成测试
 *
 * 验证：dayKey 变化 → 午夜清理按域顺序执行 → MIDNIGHT_CLEANED →
 * 待开盘重建且交易日可交易 → 开盘重建按域逆序执行 → ACTIVE，交易门禁恢复
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

describe('跨日清理与开盘重建全链路', () => {
  it('跨日：dayKey 变化触发午夜清理，按注册顺序执行各 domain.midnightClear，状态变为 MIDNIGHT_CLEANED', async () => {
    const mutableState = createMutableState({ currentDayKey: '2025-02-14' });
    const midnightOrder: string[] = [];
    const domains: ReadonlyArray<CacheDomain> = [
      {
        midnightClear: (ctx: LifecycleContext) => {
          midnightOrder.push(`A-${ctx.runtime.dayKey}`);
        },
        openRebuild: () => {
          midnightOrder.push('A-open');
        },
      },
      {
        midnightClear: (ctx: LifecycleContext) => {
          midnightOrder.push(`B-${ctx.runtime.dayKey}`);
        },
        openRebuild: () => {
          midnightOrder.push('B-open');
        },
      },
      {
        midnightClear: (ctx: LifecycleContext) => {
          midnightOrder.push(`C-${ctx.runtime.dayKey}`);
        },
        openRebuild: () => {
          midnightOrder.push('C-open');
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
    expect(mutableState.isTradingEnabled).toBe(false);
    expect(midnightOrder).toEqual(['A-2025-02-15', 'B-2025-02-15', 'C-2025-02-15']);
  });

  it('开盘重建：pendingOpenRebuild 且 isTradingDay 且 canTradeNow 时按域逆序执行 openRebuild，状态变为 ACTIVE', async () => {
    const mutableState = createMutableState({
      currentDayKey: '2025-02-15',
      pendingOpenRebuild: true,
      lifecycleState: 'MIDNIGHT_CLEANED',
      isTradingEnabled: false,
    });
    const openOrder: string[] = [];
    const domains: ReadonlyArray<CacheDomain> = [
      {
        midnightClear: () => {},
        openRebuild: () => {
          openOrder.push('first');
        },
      },
      {
        midnightClear: () => {},
        openRebuild: () => {
          openOrder.push('second');
        },
      },
      {
        midnightClear: () => {},
        openRebuild: () => {
          openOrder.push('third');
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
    expect(mutableState.isTradingEnabled).toBe(true);
    expect(openOrder).toEqual(['third', 'second', 'first']);
  });

  it('全链路：跨日后午夜清理完成，再 tick 满足开盘条件时执行开盘重建并恢复交易', async () => {
    const mutableState = createMutableState({ currentDayKey: '2025-02-14' });
    const steps: string[] = [];
    const domains: ReadonlyArray<CacheDomain> = [
      {
        midnightClear: () => {
          steps.push('midnight-1');
        },
        openRebuild: () => {
          steps.push('open-1');
        },
      },
      {
        midnightClear: () => {
          steps.push('midnight-2');
        },
        openRebuild: () => {
          steps.push('open-2');
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
    expect(steps).toEqual(['midnight-1', 'midnight-2']);

    await manager.tick(new Date(), createRuntime());
    expect(mutableState.lifecycleState).toBe('ACTIVE');
    expect(mutableState.isTradingEnabled).toBe(true);
    expect(steps).toEqual(['midnight-1', 'midnight-2', 'open-2', 'open-1']);
  });

  it('全链路边界：开盘重建未满足前（非交易日）多次 tick 不执行 openRebuild', async () => {
    const mutableState = createMutableState({
      currentDayKey: '2025-02-15',
      pendingOpenRebuild: true,
      lifecycleState: 'MIDNIGHT_CLEANED',
      isTradingEnabled: false,
    });
    let openRebuildCount = 0;
    const domains: ReadonlyArray<CacheDomain> = [
      {
        midnightClear: () => {},
        openRebuild: () => {
          openRebuildCount += 1;
        },
      },
    ];
    const manager = createDayLifecycleManager({
      mutableState,
      cacheDomains: domains,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await manager.tick(new Date(), createRuntime({ isTradingDay: false }));
    await manager.tick(new Date(), createRuntime({ isTradingDay: false }));

    expect(openRebuildCount).toBe(0);
    expect(mutableState.lifecycleState).toBe('MIDNIGHT_CLEANED');
  });
});
