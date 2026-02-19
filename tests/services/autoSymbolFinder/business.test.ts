/**
 * autoSymbolFinder 业务测试
 *
 * 功能：
 * - 验证自动寻标发现相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import { inspect } from 'node:util';
import {
  FilterWarrantExpiryDate,
  WarrantStatus,
  WarrantType,
  type QuoteContext,
  type WarrantInfo,
} from 'longport';

import {
  buildExpiryDateFilters,
  createWarrantListCache,
  selectBestWarrant,
} from '../../../src/services/autoSymbolFinder/utils.js';
import { toMockDecimal } from '../../../mock/longport/decimal.js';
import { createQuoteContextMock } from '../../../mock/longport/quoteContextMock.js';
import type {
  FindBestWarrantInput,
  WarrantCandidate,
  WarrantListItem,
} from '../../../src/services/autoSymbolFinder/types.js';
import type { Logger } from '../../../src/utils/logger/types.js';

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
          warns.push(typeof extra === 'string' ? extra : inspect(extra, { depth: 3, breakLength: Infinity }));
        }
      },
      error: () => {},
    },
    warns,
  };
}

function createWarrantListItem(params: {
  readonly symbol: string;
  readonly distancePct: number;
  readonly turnover: number;
  readonly status?: WarrantStatus;
  readonly callPrice?: number;
  readonly name?: string;
}): WarrantListItem {
  return {
    symbol: params.symbol,
    name: params.name ?? params.symbol,
    lastDone: toMockDecimal(0.1),
    toCallPrice: toMockDecimal(params.distancePct),
    callPrice: toMockDecimal(params.callPrice ?? 20_000),
    turnover: toMockDecimal(params.turnover),
    warrantType: WarrantType.Bull,
    status: params.status ?? WarrantStatus.Normal,
  };
}

function toWarrantInfo(item: WarrantListItem): WarrantInfo {
  return {
    ...item,
    warrantType: item.warrantType ?? 'Bull',
  } as unknown as WarrantInfo;
}

type FindBestWarrantFn = (
  input: FindBestWarrantInput,
) => Promise<WarrantCandidate | null>;

async function loadFindBestWarrant(): Promise<FindBestWarrantFn> {
  const modulePath = '../../../src/services/autoSymbolFinder/index.js?real-auto-symbol-finder';
  const module = await import(modulePath);
  return module.findBestWarrant as FindBestWarrantFn;
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
        createWarrantListItem({ symbol: 'A.HK', distancePct: 0.8, turnover: 120_000 }),
        createWarrantListItem({ symbol: 'B.HK', distancePct: 0.6, turnover: 200_000 }),
        createWarrantListItem({ symbol: 'C.HK', distancePct: 0.6, turnover: 260_000 }),
        createWarrantListItem({ symbol: 'D.HK', distancePct: 0.3, turnover: 500_000 }),
        createWarrantListItem({
          symbol: 'E.HK',
          distancePct: 0.5,
          turnover: 500_000,
          status: 999 as unknown as WarrantStatus,
        }),
      ],
      tradingMinutes: 10,
      isBull: true,
      minDistancePct: 0.35,
      minTurnoverPerMinute: 10_000,
    });

    expect(result?.symbol).toBe('C.HK');
    expect(result?.distancePct).toBe(0.6);
    expect(result?.turnoverPerMinute).toBe(26_000);
  });

  it('reuses cache within TTL and re-fetches after expiry for the same monitor symbol and direction', async () => {
    const findBestWarrant = await loadFindBestWarrant();
    const quoteCtx = createQuoteContextMock();
    quoteCtx.seedWarrantList('HSI.HK', [
      toWarrantInfo(createWarrantListItem({ symbol: 'BULL-1.HK', distancePct: 0.55, turnover: 300_000 })),
    ]);

    let nowMs = 1_000;
    const cache = createWarrantListCache();
    const { logger } = createLoggerRecorder();

    const baseInput = {
      ctx: quoteCtx as unknown as QuoteContext,
      monitorSymbol: 'HSI.HK',
      isBull: true,
      tradingMinutes: 10,
      minDistancePct: 0.35,
      minTurnoverPerMinute: 10_000,
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
    const findBestWarrant = await loadFindBestWarrant();
    const quoteCtx = createQuoteContextMock();
    quoteCtx.setFailureRule('warrantList', {
      failAtCalls: [1],
      errorMessage: 'warrant list mock failed',
    });

    const { logger, warns } = createLoggerRecorder();
    const result = await findBestWarrant({
      ctx: quoteCtx as unknown as QuoteContext,
      monitorSymbol: 'HSI.HK',
      isBull: true,
      tradingMinutes: 10,
      minDistancePct: 0.35,
      minTurnoverPerMinute: 10_000,
      expiryMinMonths: 3,
      logger,
    });

    expect(result).toBeNull();
    expect(warns.some((msg) => msg.includes('warrantList 获取失败'))).toBeTrue();
  });

  it('returns null and logs when no warrant can satisfy business thresholds', async () => {
    const findBestWarrant = await loadFindBestWarrant();
    const quoteCtx = createQuoteContextMock();
    quoteCtx.seedWarrantList('HSI.HK', [
      toWarrantInfo(createWarrantListItem({ symbol: 'LOW-DIST.HK', distancePct: 0.2, turnover: 1_000_000 })),
    ]);

    const { logger, warns } = createLoggerRecorder();
    const result = await findBestWarrant({
      ctx: quoteCtx as unknown as QuoteContext,
      monitorSymbol: 'HSI.HK',
      isBull: true,
      tradingMinutes: 10,
      minDistancePct: 0.35,
      minTurnoverPerMinute: 10_000,
      expiryMinMonths: 3,
      logger,
    });

    expect(result).toBeNull();
    expect(warns.some((msg) => msg.includes('未找到符合条件'))).toBeTrue();
  });
});
