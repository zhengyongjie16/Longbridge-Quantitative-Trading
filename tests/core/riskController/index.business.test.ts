/**
 * riskController/index 业务测试
 *
 * 功能：
 * - 验证风控组合（日内亏损/持仓/浮亏）场景意图与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import { createRiskChecker } from '../../../src/core/riskController/index.js';
import type {
  PositionLimitChecker,
  UnrealizedLossChecker,
  WarrantRiskChecker,
} from '../../../src/core/riskController/types.js';
import { createAccountSnapshotDouble, createSignalDouble } from '../../helpers/testDoubles.js';

function createWarrantCheckerStub(): WarrantRiskChecker {
  return {
    setWarrantInfoFromCallPrice: () => ({ status: 'ok', isWarrant: true }),
    refreshWarrantInfoForSymbol: async () => ({ status: 'ok', isWarrant: true }),
    checkRisk: () => ({ allowed: true }),
    checkWarrantDistanceLiquidation: () => ({ shouldLiquidate: false }),
    getWarrantDistanceInfo: () => null,
    clearLongWarrantInfo: () => {},
    clearShortWarrantInfo: () => {},
  };
}

function createUnrealizedLossCheckerStub(
  overrides: Partial<UnrealizedLossChecker> = {},
): UnrealizedLossChecker {
  const base: UnrealizedLossChecker = {
    getUnrealizedLossData: () => undefined,
    clearUnrealizedLossData: () => {},
    refresh: async () => null,
    check: () => ({ shouldLiquidate: false }),
  };
  return { ...base, ...overrides };
}

function createPositionLimitCheckerStub(
  overrides: Partial<PositionLimitChecker> = {},
): PositionLimitChecker {
  const base: PositionLimitChecker = {
    checkLimit: () => ({ allowed: true }),
  };
  return { ...base, ...overrides };
}

describe('riskController(index) business flow', () => {
  it('rejects buy when HKD available cash is insufficient', () => {
    const checker = createRiskChecker({
      warrantRiskChecker: createWarrantCheckerStub(),
      unrealizedLossChecker: createUnrealizedLossCheckerStub(),
      positionLimitChecker: createPositionLimitCheckerStub(),
      options: { maxDailyLoss: 1_000 },
    });

    const result = checker.checkBeforeOrder({
      account: createAccountSnapshotDouble(500),
      positions: [],
      signal: createSignalDouble('BUYCALL', 'BULL.HK'),
      orderNotional: 5_000,
      currentPrice: 5,
      longCurrentPrice: 5,
      shortCurrentPrice: 5,
    });

    expect(result.allowed).toBeFalse();
    expect(result.reason).toContain('港币可用现金');
  });

  it('rejects buy when unrealized loss exceeds configured maxDailyLoss', () => {
    const checker = createRiskChecker({
      warrantRiskChecker: createWarrantCheckerStub(),
      unrealizedLossChecker: createUnrealizedLossCheckerStub({
        getUnrealizedLossData: () => ({
          r1: 1_000,
          n1: 100,
          lastUpdateTime: Date.now(),
        }),
      }),
      positionLimitChecker: createPositionLimitCheckerStub(),
      options: { maxDailyLoss: 100 },
    });

    const result = checker.checkBeforeOrder({
      account: createAccountSnapshotDouble(50_000),
      positions: [],
      signal: createSignalDouble('BUYCALL', 'BULL.HK'),
      orderNotional: 5_000,
      currentPrice: 8,
      longCurrentPrice: 8,
      shortCurrentPrice: 12,
    });

    expect(result.allowed).toBeFalse();
    expect(result.reason).toContain('浮亏约');
  });

  it('allows sell when account data is unavailable', () => {
    let positionLimitCalls = 0;
    const checker = createRiskChecker({
      warrantRiskChecker: createWarrantCheckerStub(),
      unrealizedLossChecker: createUnrealizedLossCheckerStub(),
      positionLimitChecker: createPositionLimitCheckerStub({
        checkLimit: () => {
          positionLimitCalls += 1;
          return { allowed: true };
        },
      }),
      options: { maxDailyLoss: 100 },
    });

    const result = checker.checkBeforeOrder({
      account: null,
      positions: [],
      signal: createSignalDouble('SELLCALL', 'BULL.HK'),
      orderNotional: 5_000,
      currentPrice: 10,
      longCurrentPrice: 10,
      shortCurrentPrice: 10,
    });

    expect(result.allowed).toBeTrue();
    expect(positionLimitCalls).toBe(0);
  });

  it('returns position limit checker rejection after passing buy preconditions', () => {
    const checker = createRiskChecker({
      warrantRiskChecker: createWarrantCheckerStub(),
      unrealizedLossChecker: createUnrealizedLossCheckerStub({
        getUnrealizedLossData: () => undefined,
      }),
      positionLimitChecker: createPositionLimitCheckerStub({
        checkLimit: () => ({
          allowed: false,
          reason: '持仓市值超过限制',
        }),
      }),
      options: { maxDailyLoss: 1_000 },
    });

    const result = checker.checkBeforeOrder({
      account: createAccountSnapshotDouble(100_000),
      positions: [],
      signal: createSignalDouble('BUYCALL', 'BULL.HK'),
      orderNotional: 5_000,
      currentPrice: 10,
      longCurrentPrice: 10,
      shortCurrentPrice: 10,
    });

    expect(result.allowed).toBeFalse();
    expect(result.reason).toBe('持仓市值超过限制');
  });

  it('builds unrealized-loss metrics from cached R1/N1 and current price', () => {
    const checker = createRiskChecker({
      warrantRiskChecker: createWarrantCheckerStub(),
      unrealizedLossChecker: createUnrealizedLossCheckerStub({
        getUnrealizedLossData: () => ({
          r1: 1_000,
          n1: 100,
          lastUpdateTime: Date.now(),
        }),
      }),
      positionLimitChecker: createPositionLimitCheckerStub(),
      options: { maxDailyLoss: 1_000 },
    });

    const metrics = checker.getUnrealizedLossMetrics('BULL.HK', 12);
    expect(metrics).toEqual({
      r1: 1_000,
      n1: 100,
      r2: 1_200,
      unrealizedPnL: 200,
    });
  });
});
