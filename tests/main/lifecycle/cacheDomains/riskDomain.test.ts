/**
 * 风控缓存域单元测试
 *
 * 覆盖：midnightClear 调用 resetRiskCheckCooldown、dailyLossTracker.resetAll、
 * clearMidnightEligible（仅非 minutes 模式）、clearRiskCaches；openRebuild 为空操作
 */
import { describe, it, expect } from 'bun:test';
import { createRiskDomain } from '../../../../src/main/lifecycle/cacheDomains/riskDomain.js';
import type { MonitorContext } from '../../../../src/types/state.js';
import type { SignalProcessor } from '../../../../src/core/signalProcessor/types.js';
import type { DailyLossTracker } from '../../../../src/core/riskController/types.js';
import type { LiquidationCooldownTracker } from '../../../../src/services/liquidationCooldown/types.js';

describe('createRiskDomain', () => {
  it('midnightClear 调用 signalProcessor.resetRiskCheckCooldown、dailyLossTracker.resetAll、clearMidnightEligible、各 riskChecker 清理', () => {
    let resetRiskCheckCooldownCalled = false;
    let resetAllCalled = false;
    let resetAllNow: Date | null = null as Date | null;
    let clearMidnightEligibleKeys: Set<string> | null = null as Set<string> | null;
    let clearUnrealizedCount = 0;
    let clearLongCount = 0;
    let clearShortCount = 0;

    const monitorContexts = new Map<string, MonitorContext>([
      [
        'HSI.HK',
        {
          config: {
            monitorSymbol: 'HSI.HK',
            liquidationCooldown: { mode: 'half-day' },
          },
          riskChecker: {
            clearUnrealizedLossData: () => {
              clearUnrealizedCount += 1;
            },
            clearLongWarrantInfo: () => {
              clearLongCount += 1;
            },
            clearShortWarrantInfo: () => {
              clearShortCount += 1;
            },
          },
        } as unknown as MonitorContext,
      ],
    ]);
    const signalProcessor: SignalProcessor = {
      resetRiskCheckCooldown: () => {
        resetRiskCheckCooldownCalled = true;
      },
    } as unknown as SignalProcessor;
    const dailyLossTracker: DailyLossTracker = {
      resetAll: (now: Date) => {
        resetAllCalled = true;
        resetAllNow = now;
      },
    } as unknown as DailyLossTracker;
    const liquidationCooldownTracker: LiquidationCooldownTracker = {
      recordCooldown: () => {},
      getRemainingMs: () => 0,
      clearMidnightEligible: (params) => {
        clearMidnightEligibleKeys = new Set(params.keysToClear);
      },
    };

    const domain = createRiskDomain({
      signalProcessor,
      dailyLossTracker,
      monitorContexts,
      liquidationCooldownTracker,
    });
    const now = new Date('2025-02-15T00:00:00Z');
    void domain.midnightClear({
      now,
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });

    expect(resetRiskCheckCooldownCalled).toBe(true);
    expect(resetAllCalled).toBe(true);
    expect(resetAllNow?.getTime()).toBe(now.getTime());
    expect(clearMidnightEligibleKeys).not.toBe(null);
    expect(clearMidnightEligibleKeys?.has('HSI.HK:LONG')).toBe(true);
    expect(clearMidnightEligibleKeys?.has('HSI.HK:SHORT')).toBe(true);
    expect(clearUnrealizedCount).toBe(1);
    expect(clearLongCount).toBe(1);
    expect(clearShortCount).toBe(1);
  });

  it('liquidationCooldown 为 minutes 模式时不向 keysToClear 添加该监控标的 key', () => {
    let clearMidnightEligibleKeys: Set<string> | null = null as Set<string> | null;
    const monitorContexts = new Map<string, MonitorContext>([
      [
        'HSI.HK',
        {
          config: {
            monitorSymbol: 'HSI.HK',
            liquidationCooldown: { mode: 'minutes' },
          },
          riskChecker: {
            clearUnrealizedLossData: () => {},
            clearLongWarrantInfo: () => {},
            clearShortWarrantInfo: () => {},
          },
        } as unknown as MonitorContext,
      ],
    ]);
    const liquidationCooldownTracker: LiquidationCooldownTracker = {
      recordCooldown: () => {},
      getRemainingMs: () => 0,
      clearMidnightEligible: (params) => {
        clearMidnightEligibleKeys = new Set(params.keysToClear);
      },
    };

    const domain = createRiskDomain({
      signalProcessor: { resetRiskCheckCooldown: () => {} } as unknown as SignalProcessor,
      dailyLossTracker: { resetAll: () => {} } as unknown as DailyLossTracker,
      monitorContexts,
      liquidationCooldownTracker,
    });
    void domain.midnightClear({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });

    expect(clearMidnightEligibleKeys === null ? 0 : clearMidnightEligibleKeys.size).toBe(0);
  });

  it('openRebuild 为空操作，不抛错', () => {
    const domain = createRiskDomain({
      signalProcessor: { resetRiskCheckCooldown: () => {} } as unknown as SignalProcessor,
      dailyLossTracker: { resetAll: () => {} } as unknown as DailyLossTracker,
      monitorContexts: new Map(),
      liquidationCooldownTracker: {
        recordCooldown: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
      },
    });
    expect(() => {
      void domain.openRebuild({
        now: new Date(),
        runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
      });
    }).not.toThrow();
  });
});
