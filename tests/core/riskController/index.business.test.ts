/**
 * riskController/index 业务测试
 *
 * 功能：
 * - 验证风控组合（持仓/浮亏）场景意图与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import { createRiskChecker } from '../../../src/core/riskController/index.js';
import { createUnrealizedLossChecker } from '../../../src/core/riskController/unrealizedLossChecker.js';
import { createUnrealizedLossMonitor } from '../../../src/core/riskController/unrealizedLossMonitor.js';
import { createExternalApiRequestError } from '../../../src/utils/apiFailure/index.js';
import type { DailyLossTracker } from '../../../src/types/risk.js';
import type { OrderRecorder, RiskChecker, Trader } from '../../../src/types/services.js';
import type {
  PositionLimitChecker,
  UnrealizedLossChecker,
  WarrantRiskChecker,
} from '../../../src/core/riskController/types.js';
import {
  createAccountSnapshotDouble,
  createQuoteDouble,
  createSignalDouble,
} from '../../helpers/testDoubles.js';

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

function getMissingUnrealizedLossData(): undefined {
  return;
}

function createUnrealizedLossCheckerStub(
  overrides: Partial<UnrealizedLossChecker> = {},
): UnrealizedLossChecker {
  const base: UnrealizedLossChecker = {
    getUnrealizedLossData: getMissingUnrealizedLossData,
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
    });

    const result = checker.checkBeforeOrder({
      account: createAccountSnapshotDouble(500),
      positions: [],
      signal: createSignalDouble('BUYCALL', 'BULL.HK'),
      orderNotional: 5_000,
    });

    expect(result.allowed).toBeFalse();
    expect(result.reason).toContain('港币可用现金');
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
    });

    const result = checker.checkBeforeOrder({
      account: null,
      positions: [],
      signal: createSignalDouble('SELLCALL', 'BULL.HK'),
      orderNotional: 5_000,
    });

    expect(result.allowed).toBeTrue();
    expect(positionLimitCalls).toBe(0);
  });

  it('returns position limit checker rejection after passing buy preconditions', () => {
    const checker = createRiskChecker({
      warrantRiskChecker: createWarrantCheckerStub(),
      unrealizedLossChecker: createUnrealizedLossCheckerStub({
        getUnrealizedLossData: getMissingUnrealizedLossData,
      }),
      positionLimitChecker: createPositionLimitCheckerStub({
        checkLimit: () => ({
          allowed: false,
          reason: '持仓市值超过限制',
        }),
      }),
    });

    const result = checker.checkBeforeOrder({
      account: createAccountSnapshotDouble(100_000),
      positions: [],
      signal: createSignalDouble('BUYCALL', 'BULL.HK'),
      orderNotional: 5_000,
    });

    expect(result.allowed).toBeFalse();
    expect(result.reason).toBe('持仓市值超过限制');
  });

  it('rethrows internal errors during unrealized loss refresh', () => {
    const checker = createUnrealizedLossChecker({
      maxUnrealizedLossPerSymbol: 1_000,
    });
    const internalError = new Error('order recorder broken');
    const orderRecorder = {
      getBuyOrdersForSymbol: () => {
        throw internalError;
      },
    } as unknown as OrderRecorder;

    expect(() => checker.refresh(orderRecorder, 'BULL.HK', true)).toThrow(internalError);
  });

  it('rethrows submitOrder API failure during protective liquidation', async () => {
    const monitor = createUnrealizedLossMonitor({
      maxUnrealizedLossPerSymbol: 1_000,
    });
    const submitError = createExternalApiRequestError({
      operation: 'TradeContext.submitOrder',
      attempts: 1,
      cause: new Error('submit timeout'),
    });
    const riskChecker = {
      checkUnrealizedLoss: () => ({ shouldLiquidate: true, reason: 'loss limit', quantity: 100 }),
    } as unknown as RiskChecker;
    const trader = {
      executeSignals: async () => {
        throw submitError;
      },
    } as unknown as Trader;
    const orderRecorder = {
      clearBuyOrders: () => {},
    } as unknown as OrderRecorder;
    const dailyLossTracker = {
      getLossOffset: () => 0,
    } as unknown as DailyLossTracker;

    let caught: unknown = null;
    try {
      await monitor.monitorDirectionalUnrealizedLoss({
        symbol: 'BULL.HK',
        isLong: true,
        monitorSymbol: 'HSI.HK',
        seatVersion: 2,
        quote: createQuoteDouble('BULL.HK', 1.1, 100),
        riskChecker,
        trader,
        orderRecorder,
        dailyLossTracker,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(submitError);
  });

  it('rethrows local cleanup errors after protective liquidation is submitted', async () => {
    const monitor = createUnrealizedLossMonitor({
      maxUnrealizedLossPerSymbol: 1_000,
    });
    const cleanupError = new Error('refresh failed after liquidation submitted');
    const riskChecker = {
      checkUnrealizedLoss: () => ({ shouldLiquidate: true, reason: 'loss limit', quantity: 100 }),
      refreshUnrealizedLossData: async () => {
        throw cleanupError;
      },
    } as unknown as RiskChecker;
    const trader = {
      executeSignals: async () => ({ submittedCount: 1, submittedOrderIds: ['order-1'] }),
    } as unknown as Trader;
    const orderRecorder = {
      clearBuyOrders: () => {},
    } as unknown as OrderRecorder;
    const dailyLossTracker = {
      getLossOffset: () => 0,
    } as unknown as DailyLossTracker;

    let caught: unknown = null;
    try {
      await monitor.monitorDirectionalUnrealizedLoss({
        symbol: 'BULL.HK',
        isLong: true,
        monitorSymbol: 'HSI.HK',
        seatVersion: 2,
        quote: createQuoteDouble('BULL.HK', 1.1, 100),
        riskChecker,
        trader,
        orderRecorder,
        dailyLossTracker,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(cleanupError);
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
