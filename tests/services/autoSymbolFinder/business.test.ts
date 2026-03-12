/**
 * autoSymbolFinder 业务测试
 *
 * 功能：
 * - 验证自动寻标发现相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import { inspect } from 'node:util';
import { FilterWarrantExpiryDate, WarrantStatus, WarrantType } from 'longbridge';

import { findBestWarrant } from '../../../src/services/autoSymbolFinder/index.js';
import { resolveDirectionalAutoSearchPolicy } from '../../../src/services/autoSymbolFinder/policyResolver.js';
import {
  buildExpiryDateFilters,
  createWarrantListCache,
  selectBestWarrant,
} from '../../../src/services/autoSymbolFinder/utils.js';
import { toMockDecimal } from '../../../mock/longbridge/decimal.js';
import { createQuoteContextMock } from '../../../mock/longbridge/quoteContextMock.js';
import type {
  DirectionalAutoSearchPolicy,
  WarrantListItem,
} from '../../../src/services/autoSymbolFinder/types.js';
import type { Logger } from '../../../src/utils/logger/types.js';
import { createQuoteContextDouble } from '../../helpers/testDoubles.js';

function createLoggerRecorder(): {
  readonly logger: Logger;
  readonly warns: string[];
} {
  const warns: string[] = [];
  return {
    logger: {
      debug: () => {},
      info: () => {},
      warn: (msg: string, extra?: unknown) => {
        warns.push(msg);
        if (extra !== undefined) {
          warns.push(
            typeof extra === 'string' ? extra : inspect(extra, { depth: 3, breakLength: Infinity }),
          );
        }
      },
      error: () => {},
    },
    warns,
  };
}

function createWarrantListItem(params: {
  readonly symbol: string;
  readonly apiDistanceRatio: number;
  readonly turnover: number;
  readonly status?: WarrantListItem['status'];
  readonly callPrice?: number;
  readonly name?: string;
}): WarrantListItem {
  return {
    symbol: params.symbol,
    name: params.name ?? params.symbol,
    lastDone: toMockDecimal(0.1),
    toCallPrice: toMockDecimal(params.apiDistanceRatio),
    callPrice: toMockDecimal(params.callPrice ?? 20_000),
    turnover: toMockDecimal(params.turnover),
    warrantType: WarrantType.Bull,
    status: params.status ?? WarrantStatus.Normal,
  };
}

function toApiDistanceRatio(percentValue: number): number {
  return percentValue / 100;
}

function toWarrantInfo(
  item: WarrantListItem,
): Parameters<ReturnType<typeof createQuoteContextMock>['seedWarrantList']>[1][number] {
  const normalizeDecimalField = (value: WarrantListItem['lastDone']): number | null | undefined => {
    if (value === undefined || value === null) {
      return value;
    }

    if (typeof value === 'string' || typeof value === 'number') {
      return Number(value);
    }

    return value.toNumber();
  };

  const lastDone = normalizeDecimalField(item.lastDone);
  const toCallPrice = normalizeDecimalField(item.toCallPrice);
  const callPrice = normalizeDecimalField(item.callPrice);
  const turnover = normalizeDecimalField(item.turnover);
  return {
    warrantType: item.warrantType ?? 'Bull',
    symbol: item.symbol,
    ...(item.name === undefined ? {} : { name: item.name }),
    ...(lastDone === undefined ? {} : { lastDone }),
    ...(toCallPrice === undefined ? {} : { toCallPrice }),
    ...(callPrice === undefined ? {} : { callPrice }),
    ...(turnover === undefined ? {} : { turnover }),
    ...(item.status === undefined ? {} : { status: item.status }),
  };
}

function createDirectionalPolicy(
  direction: 'LONG' | 'SHORT',
  overrides: Partial<DirectionalAutoSearchPolicy> = {},
): DirectionalAutoSearchPolicy {
  const base =
    direction === 'LONG'
      ? {
          direction,
          primaryThreshold: 0.35,
          minTurnoverPerMinute: 10_000,
          degradedRange: { min: 0.2, max: 0.35 },
          switchDistanceRange: { min: 0.2, max: 1.5 },
        }
      : {
          direction,
          primaryThreshold: -0.35,
          minTurnoverPerMinute: 10_000,
          degradedRange: { min: -0.35, max: -0.2 },
          switchDistanceRange: { min: -1.5, max: -0.2 },
        };
  return {
    ...base,
    ...overrides,
  };
}

describe('autoSymbolFinder business flow', () => {
  it('builds expiry filter sets by configured minimum month threshold', () => {
    expect(buildExpiryDateFilters(3)).toEqual([
      FilterWarrantExpiryDate.Between_3_6,
      FilterWarrantExpiryDate.Between_6_12,
      FilterWarrantExpiryDate.GT_12,
    ]);

    expect(buildExpiryDateFilters(5)).toEqual([
      FilterWarrantExpiryDate.Between_6_12,
      FilterWarrantExpiryDate.GT_12,
    ]);
    expect(buildExpiryDateFilters(7)).toEqual([FilterWarrantExpiryDate.GT_12]);
  });

  it('selects best candidate by distance then turnover-per-minute under business constraints', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'A.HK',
          apiDistanceRatio: toApiDistanceRatio(0.8),
          turnover: 120_000,
        }),
        createWarrantListItem({
          symbol: 'B.HK',
          apiDistanceRatio: toApiDistanceRatio(0.6),
          turnover: 200_000,
        }),
        createWarrantListItem({
          symbol: 'C.HK',
          apiDistanceRatio: toApiDistanceRatio(0.6),
          turnover: 260_000,
        }),
        createWarrantListItem({
          symbol: 'D.HK',
          apiDistanceRatio: toApiDistanceRatio(0.3),
          turnover: 500_000,
        }),
        createWarrantListItem({
          symbol: 'E.HK',
          apiDistanceRatio: toApiDistanceRatio(0.5),
          turnover: 500_000,
          status: 999,
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('LONG'),
    });

    expect(result.candidate?.symbol).toBe('C.HK');
    expect(result.candidate?.distancePct).toBe(0.6);
    expect(result.candidate?.turnoverPerMinute).toBe(26_000);
    expect(result.candidate?.selectionStage).toBe('PRIMARY');
    expect(result.primaryCandidateCount).toBe(3);
    expect(result.degradedCandidateCount).toBe(1);
  });

  it('falls back to degraded band only when primary band has no candidates', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'LOWER.HK',
          apiDistanceRatio: toApiDistanceRatio(0.22),
          turnover: 150_000,
        }),
        createWarrantListItem({
          symbol: 'BEST.HK',
          apiDistanceRatio: toApiDistanceRatio(0.34),
          turnover: 160_000,
        }),
        createWarrantListItem({
          symbol: 'PRIMARY.HK',
          apiDistanceRatio: toApiDistanceRatio(0.36),
          turnover: 200_000,
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('LONG'),
    });

    expect(result.candidate?.symbol).toBe('PRIMARY.HK');
    expect(result.candidate?.selectionStage).toBe('PRIMARY');
    expect(result.primaryCandidateCount).toBe(1);
    expect(result.degradedCandidateCount).toBe(2);
  });

  it('selects the degraded candidate closest to threshold when primary band is empty', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'LOWER.HK',
          apiDistanceRatio: toApiDistanceRatio(0.22),
          turnover: 150_000,
        }),
        createWarrantListItem({
          symbol: 'BEST.HK',
          apiDistanceRatio: toApiDistanceRatio(0.3499),
          turnover: 140_000,
        }),
        createWarrantListItem({
          symbol: 'TIE.HK',
          apiDistanceRatio: toApiDistanceRatio(0.3499),
          turnover: 180_000,
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('LONG'),
    });

    expect(result.candidate?.symbol).toBe('TIE.HK');
    expect(result.candidate?.selectionStage).toBe('DEGRADED');
    expect(result.candidate?.distanceDeltaToThreshold).toBeCloseTo(0.0001);
    expect(result.primaryCandidateCount).toBe(0);
    expect(result.degradedCandidateCount).toBe(3);
  });

  it('selects the best SHORT candidate by negative-threshold distance and turnover-per-minute', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'FAR.HK',
          apiDistanceRatio: toApiDistanceRatio(-0.8),
          turnover: 200_000,
        }),
        createWarrantListItem({
          symbol: 'BEST.HK',
          apiDistanceRatio: toApiDistanceRatio(-0.4),
          turnover: 260_000,
        }),
        createWarrantListItem({
          symbol: 'TIE.HK',
          apiDistanceRatio: toApiDistanceRatio(-0.4),
          turnover: 220_000,
        }),
        createWarrantListItem({
          symbol: 'DEGRADED.HK',
          apiDistanceRatio: toApiDistanceRatio(-0.3),
          turnover: 500_000,
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('SHORT'),
    });

    expect(result.candidate?.symbol).toBe('BEST.HK');
    expect(result.candidate?.selectionStage).toBe('PRIMARY');
    expect(result.primaryCandidateCount).toBe(3);
    expect(result.degradedCandidateCount).toBe(1);
  });

  it('falls back to the closest degraded SHORT candidate when primary band is empty', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'UPPER.HK',
          apiDistanceRatio: toApiDistanceRatio(-0.22),
          turnover: 150_000,
        }),
        createWarrantListItem({
          symbol: 'BEST.HK',
          apiDistanceRatio: toApiDistanceRatio(-0.3499),
          turnover: 160_000,
        }),
        createWarrantListItem({
          symbol: 'TIE.HK',
          apiDistanceRatio: toApiDistanceRatio(-0.3499),
          turnover: 180_000,
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('SHORT'),
    });

    expect(result.candidate?.symbol).toBe('TIE.HK');
    expect(result.candidate?.selectionStage).toBe('DEGRADED');
    expect(result.candidate?.distanceDeltaToThreshold).toBeCloseTo(0.0001);
    expect(result.primaryCandidateCount).toBe(0);
    expect(result.degradedCandidateCount).toBe(3);
  });

  it('excludes threshold and degraded-boundary equality from both candidate bands', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'THRESHOLD.HK',
          apiDistanceRatio: toApiDistanceRatio(0.35),
          turnover: 200_000,
        }),
        createWarrantListItem({
          symbol: 'BOUNDARY.HK',
          apiDistanceRatio: toApiDistanceRatio(0.2),
          turnover: 200_000,
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('LONG'),
    });

    expect(result.candidate).toBeNull();
    expect(result.primaryCandidateCount).toBe(0);
    expect(result.degradedCandidateCount).toBe(0);
  });

  it('excludes SHORT threshold and degraded-boundary equality from both candidate bands', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'THRESHOLD.HK',
          apiDistanceRatio: toApiDistanceRatio(-0.35),
          turnover: 200_000,
        }),
        createWarrantListItem({
          symbol: 'BOUNDARY.HK',
          apiDistanceRatio: toApiDistanceRatio(-0.2),
          turnover: 200_000,
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('SHORT'),
    });

    expect(result.candidate).toBeNull();
    expect(result.primaryCandidateCount).toBe(0);
    expect(result.degradedCandidateCount).toBe(0);
  });

  it('keeps Decimal precision when comparing near-threshold candidates', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'NEARER.HK',
          apiDistanceRatio: 0.003500000002,
          turnover: 200_000,
        }),
        createWarrantListItem({
          symbol: 'FARTHER.HK',
          apiDistanceRatio: 0.003500000009,
          turnover: 500_000,
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('LONG'),
    });

    expect(result.candidate?.symbol).toBe('NEARER.HK');
  });

  it('keeps Decimal precision when comparing near-threshold SHORT candidates', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'NEARER.HK',
          apiDistanceRatio: -0.003500000002,
          turnover: 200_000,
        }),
        createWarrantListItem({
          symbol: 'FARTHER.HK',
          apiDistanceRatio: -0.003500000009,
          turnover: 500_000,
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('SHORT'),
    });

    expect(result.candidate?.symbol).toBe('NEARER.HK');
  });

  it('interprets realistic bull thresholds against api raw ratio inputs', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'BELOW.HK',
          apiDistanceRatio: 0.0184,
          turnover: 2_000_000,
        }),
        createWarrantListItem({
          symbol: 'MATCH.HK',
          apiDistanceRatio: 0.0185000001,
          turnover: 2_500_000,
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('LONG', {
        primaryThreshold: 1.85,
        degradedRange: { min: 1, max: 1.85 },
        switchDistanceRange: { min: 1, max: 4 },
      }),
    });

    expect(result.candidate?.symbol).toBe('MATCH.HK');
    expect(result.candidate?.selectionStage).toBe('PRIMARY');
    expect(result.candidate?.distancePct).toBeCloseTo(1.85000001);
  });

  it('interprets realistic bear thresholds against api raw ratio inputs', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'ABOVE.HK',
          apiDistanceRatio: -0.0184,
          turnover: 2_000_000,
        }),
        createWarrantListItem({
          symbol: 'MATCH.HK',
          apiDistanceRatio: -0.0185000001,
          turnover: 2_500_000,
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('SHORT', {
        primaryThreshold: -1.85,
        degradedRange: { min: -1.85, max: -1 },
        switchDistanceRange: { min: -4, max: -1 },
      }),
    });

    expect(result.candidate?.symbol).toBe('MATCH.HK');
    expect(result.candidate?.selectionStage).toBe('PRIMARY');
    expect(result.candidate?.distancePct).toBeCloseTo(-1.85000001);
  });

  it('supports higher realistic bull thresholds without treating api raw ratios as percent values', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'BELOW.HK',
          apiDistanceRatio: 0.0349,
          turnover: 2_000_000,
        }),
        createWarrantListItem({
          symbol: 'MATCH.HK',
          apiDistanceRatio: 0.035000001,
          turnover: 2_500_000,
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('LONG', {
        primaryThreshold: 3.5,
        degradedRange: { min: 2, max: 3.5 },
        switchDistanceRange: { min: 2, max: 8 },
      }),
    });

    expect(result.candidate?.symbol).toBe('MATCH.HK');
    expect(result.candidate?.selectionStage).toBe('PRIMARY');
    expect(result.candidate?.distancePct).toBeCloseTo(3.5000001);
  });

  it('supports higher realistic bear thresholds without treating api raw ratios as percent values', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrantListItem({
          symbol: 'ABOVE.HK',
          apiDistanceRatio: -0.0349,
          turnover: 2_000_000,
        }),
        createWarrantListItem({
          symbol: 'MATCH.HK',
          apiDistanceRatio: -0.035000001,
          turnover: 2_500_000,
        }),
      ],
      tradingMinutes: 10,
      policy: createDirectionalPolicy('SHORT', {
        primaryThreshold: -3.5,
        degradedRange: { min: -3.5, max: -2 },
        switchDistanceRange: { min: -8, max: -2 },
      }),
    });

    expect(result.candidate?.symbol).toBe('MATCH.HK');
    expect(result.candidate?.selectionStage).toBe('PRIMARY');
    expect(result.candidate?.distancePct).toBeCloseTo(-3.5000001);
  });

  it('rejects non-finite thresholds at policy construction boundary', () => {
    const { logger, warns } = createLoggerRecorder();
    const policy = resolveDirectionalAutoSearchPolicy({
      direction: 'LONG',
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: Number.NaN,
        autoSearchMinDistancePctBear: -0.35,
        autoSearchMinTurnoverPerMinuteBull: Number.NaN,
        autoSearchMinTurnoverPerMinuteBear: 10_000,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: 0.2, max: 1.5 },
        switchDistanceRangeBear: { min: -1.5, max: -0.2 },
      },
      monitorSymbol: 'HSI.HK',
      logPrefix: '[自动寻标] 非法策略',
      logger: {
        ...logger,
        error: (message: string) => {
          warns.push(message);
        },
      },
    });

    expect(policy).toBeNull();
    expect(warns.some((message) => message.includes('不是有限数'))).toBeTrue();
  });

  it('rejects policies whose primary threshold is not strictly inside the switch range', () => {
    const { logger, warns } = createLoggerRecorder();
    const longPolicy = resolveDirectionalAutoSearchPolicy({
      direction: 'LONG',
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: 0.35,
        autoSearchMinDistancePctBear: -0.35,
        autoSearchMinTurnoverPerMinuteBull: 10_000,
        autoSearchMinTurnoverPerMinuteBear: 10_000,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: 0.2, max: 0.35 },
        switchDistanceRangeBear: { min: -1.5, max: -0.2 },
      },
      monitorSymbol: 'HSI.HK',
      logPrefix: '[自动寻标] 非法策略',
      logger: {
        ...logger,
        error: (message: string) => {
          warns.push(message);
        },
      },
    });
    const shortPolicy = resolveDirectionalAutoSearchPolicy({
      direction: 'SHORT',
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: 0.35,
        autoSearchMinDistancePctBear: -0.35,
        autoSearchMinTurnoverPerMinuteBull: 10_000,
        autoSearchMinTurnoverPerMinuteBear: 10_000,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: 0.2, max: 1.5 },
        switchDistanceRangeBear: { min: -0.35, max: -0.2 },
      },
      monitorSymbol: 'HSI.HK',
      logPrefix: '[自动寻标] 非法策略',
      logger: {
        ...logger,
        error: (message: string) => {
          warns.push(message);
        },
      },
    });

    expect(longPolicy).toBeNull();
    expect(shortPolicy).toBeNull();
    expect(
      warns.some((message) => message.includes('主阈值未严格落在换标安全区间内部')),
    ).toBeTrue();
  });

  it('reuses cache within TTL and re-fetches after expiry for the same monitor symbol and direction', async () => {
    const quoteCtx = createQuoteContextMock();
    quoteCtx.seedWarrantList('HSI.HK', [
      toWarrantInfo(
        createWarrantListItem({
          symbol: 'BULL-1.HK',
          apiDistanceRatio: toApiDistanceRatio(0.55),
          turnover: 300_000,
        }),
      ),
    ]);

    let nowMs = 1_000;
    const cache = createWarrantListCache();
    const { logger } = createLoggerRecorder();

    const baseInput = {
      ctx: createQuoteContextDouble(quoteCtx),
      monitorSymbol: 'HSI.HK',
      tradingMinutes: 10,
      policy: createDirectionalPolicy('LONG'),
      expiryMinMonths: 3,
      logger,
      cacheConfig: {
        cache,
        ttlMs: 3_000,
        nowMs: () => nowMs,
      },
    };

    const first = await findBestWarrant(baseInput);
    nowMs = 2_000;
    const second = await findBestWarrant(baseInput);

    expect(first?.symbol).toBe('BULL-1.HK');
    expect(second?.symbol).toBe('BULL-1.HK');
    expect(quoteCtx.getCalls('warrantList')).toHaveLength(1);

    nowMs = 5_500;
    await findBestWarrant(baseInput);
    expect(quoteCtx.getCalls('warrantList')).toHaveLength(2);
  });

  it('returns null and records warning when api call fails', async () => {
    const quoteCtx = createQuoteContextMock();
    quoteCtx.setFailureRule('warrantList', {
      failAtCalls: [1],
      errorMessage: 'warrant list mock failed',
    });

    const { logger, warns } = createLoggerRecorder();
    const result = await findBestWarrant({
      ctx: createQuoteContextDouble(quoteCtx),
      monitorSymbol: 'HSI.HK',
      tradingMinutes: 10,
      policy: createDirectionalPolicy('LONG'),
      expiryMinMonths: 3,
      logger,
    });

    expect(result).toBeNull();
    expect(warns.some((msg) => msg.includes('warrantList 获取失败'))).toBeTrue();
  });

  it('returns null and logs when no warrant can satisfy business thresholds', async () => {
    const quoteCtx = createQuoteContextMock();
    quoteCtx.seedWarrantList('HSI.HK', [
      toWarrantInfo(
        createWarrantListItem({
          symbol: 'LOW-DIST.HK',
          apiDistanceRatio: toApiDistanceRatio(0.2),
          turnover: 1_000_000,
        }),
      ),
    ]);

    const { logger, warns } = createLoggerRecorder();
    const result = await findBestWarrant({
      ctx: createQuoteContextDouble(quoteCtx),
      monitorSymbol: 'HSI.HK',
      tradingMinutes: 10,
      policy: createDirectionalPolicy('LONG'),
      expiryMinMonths: 3,
      logger,
    });

    expect(result).toBeNull();
    expect(warns.some((msg) => msg.includes('主条件与降级条件均未命中'))).toBeTrue();
  });
});
