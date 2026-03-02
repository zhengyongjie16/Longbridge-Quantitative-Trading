/**
 * liquidationCooldown utils 业务测试
 *
 * 功能：
 * - 验证保护性清仓记录分组与触发周期模拟算法。
 */
import { describe, expect, it } from 'bun:test';

import type { TradeRecord } from '../../../src/core/trader/types.js';
import type { CooldownCandidate } from '../../../src/services/liquidationCooldown/types.js';
import {
  collectLiquidationRecordsByMonitor,
  simulateTriggerCycle,
} from '../../../src/services/liquidationCooldown/utils.js';

function createTradeRecord(params: {
  readonly monitorSymbol: string | null;
  readonly symbol: string;
  readonly action: string | null;
  readonly executedAtMs: number;
  readonly isProtectiveClearance: boolean;
}): TradeRecord {
  return {
    orderId: 'order-id',
    symbol: params.symbol,
    symbolName: null,
    monitorSymbol: params.monitorSymbol,
    action: params.action,
    side: 'SELL',
    quantity: '1000',
    price: '1.23',
    orderType: 'ELO',
    status: 'FILLED',
    error: null,
    reason: null,
    signalTriggerTime: null,
    executedAt: null,
    executedAtMs: params.executedAtMs,
    timestamp: null,
    isProtectiveClearance: params.isProtectiveClearance,
  };
}

function createCandidate(executedAtMs: number): CooldownCandidate {
  return {
    monitorSymbol: 'HSI.HK',
    direction: 'LONG',
    executedAtMs,
  };
}

describe('liquidationCooldown utils', () => {
  it('collectLiquidationRecordsByMonitor groups by monitor + direction and sorts by time', () => {
    const records = [
      createTradeRecord({
        monitorSymbol: 'HSI.HK',
        symbol: 'BULL1.HK',
        action: 'SELLCALL',
        executedAtMs: 300,
        isProtectiveClearance: true,
      }),
      createTradeRecord({
        monitorSymbol: 'HSI.HK',
        symbol: 'BULL2.HK',
        action: 'SELLCALL',
        executedAtMs: 100,
        isProtectiveClearance: true,
      }),
      createTradeRecord({
        monitorSymbol: 'HSI.HK',
        symbol: 'BEAR1.HK',
        action: 'SELLPUT',
        executedAtMs: 200,
        isProtectiveClearance: true,
      }),
      createTradeRecord({
        monitorSymbol: 'QQQ.HK',
        symbol: 'QQQ_BULL.HK',
        action: 'SELLCALL',
        executedAtMs: 50,
        isProtectiveClearance: true,
      }),
      createTradeRecord({
        monitorSymbol: 'HSI.HK',
        symbol: 'BULL3.HK',
        action: 'BUYCALL',
        executedAtMs: 400,
        isProtectiveClearance: true,
      }),
    ];

    const grouped = collectLiquidationRecordsByMonitor({
      monitorSymbols: new Set(['HSI.HK']),
      tradeRecords: records,
    });

    const longGroup = grouped.get('HSI.HK:LONG') ?? [];
    const shortGroup = grouped.get('HSI.HK:SHORT') ?? [];
    expect(longGroup.map((item) => item.executedAtMs)).toEqual([100, 300]);
    expect(shortGroup.map((item) => item.executedAtMs)).toEqual([200]);
    expect(grouped.has('QQQ.HK:LONG')).toBe(false);
  });

  it('collectLiquidationRecordsByMonitor returns empty map for non-protective records', () => {
    const grouped = collectLiquidationRecordsByMonitor({
      monitorSymbols: new Set(['HSI.HK']),
      tradeRecords: [
        createTradeRecord({
          monitorSymbol: 'HSI.HK',
          symbol: 'BULL.HK',
          action: 'SELLCALL',
          executedAtMs: 100,
          isProtectiveClearance: false,
        }),
      ],
    });

    expect(grouped.size).toBe(0);
  });

  it('simulateTriggerCycle returns zero for empty records', () => {
    const result = simulateTriggerCycle({
      records: [],
      triggerLimit: 3,
      cooldownConfig: { mode: 'minutes', minutes: 30 },
    });

    expect(result).toEqual({
      currentCount: 0,
      cooldownExecutedTimeMs: null,
    });
  });

  it('simulateTriggerCycle activates cooldown on the third trigger', () => {
    const result = simulateTriggerCycle({
      records: [createCandidate(0), createCandidate(900_000), createCandidate(1_800_000)],
      triggerLimit: 3,
      cooldownConfig: { mode: 'minutes', minutes: 30 },
    });

    expect(result).toEqual({
      currentCount: 3,
      cooldownExecutedTimeMs: 1_800_000,
    });
  });

  it('simulateTriggerCycle returns only new-cycle count after previous cooldown expired', () => {
    const result = simulateTriggerCycle({
      records: [
        createCandidate(0),
        createCandidate(900_000),
        createCandidate(1_800_000),
        createCandidate(4_500_000),
        createCandidate(5_400_000),
      ],
      triggerLimit: 3,
      cooldownConfig: { mode: 'minutes', minutes: 30 },
    });

    expect(result).toEqual({
      currentCount: 2,
      cooldownExecutedTimeMs: null,
    });
  });

  it('simulateTriggerCycle activates cooldown again in a new cycle when trigger limit is reached', () => {
    const result = simulateTriggerCycle({
      records: [
        createCandidate(0),
        createCandidate(900_000),
        createCandidate(1_800_000),
        createCandidate(4_500_000),
        createCandidate(5_400_000),
        createCandidate(6_300_000),
      ],
      triggerLimit: 3,
      cooldownConfig: { mode: 'minutes', minutes: 30 },
    });

    expect(result).toEqual({
      currentCount: 3,
      cooldownExecutedTimeMs: 6_300_000,
    });
  });
});
