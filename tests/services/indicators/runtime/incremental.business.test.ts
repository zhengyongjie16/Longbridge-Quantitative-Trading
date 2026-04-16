/**
 * indicators/runtime 增量模型业务测试
 *
 * 功能：
 * - 验证 bootstrap 结果与全量重算口径一致
 * - 验证活动 bar 增量更新、收线确认与跨 bar 移位逐拍对拍一致
 */
import { describe, expect, it } from 'bun:test';
import { Period } from 'longbridge';

import type { CandleData } from '../../../../src/types/data.js';
import type { IndicatorUsageProfile } from '../../../../src/types/indicatorProfile.js';
import type { CandlestickCacheSnapshot } from '../../../../src/types/services.js';
import {
  bootstrapIndicatorRuntime,
  buildSnapshotFromRuntime,
  updateRuntimeForCandlestickSnapshot,
} from '../../../../src/services/indicators/runtime/index.js';
import { buildIndicatorSnapshot } from '../../../../tools/dailyKlineMonitor/runtimeSnapshot.js';
import { createIndicatorUsageProfileDouble } from '../../../helpers/testDoubles.js';

function createCandle(params: {
  readonly timestamp: number;
  readonly close: number;
  readonly highOffset?: number;
  readonly lowOffset?: number;
  readonly openOffset?: number;
  readonly volume?: number;
}): CandleData {
  const highOffset = params.highOffset ?? 0.4;
  const lowOffset = params.lowOffset ?? 0.6;
  const openOffset = params.openOffset ?? 0.2;
  return {
    open: params.close - openOffset,
    high: params.close + highOffset,
    low: params.close - lowOffset,
    close: params.close,
    volume: params.volume ?? 1_000,
    timestamp: params.timestamp,
  };
}

function createTrendCandles(
  length: number,
  startClose: number,
  step: number,
): ReadonlyArray<CandleData> {
  const baseTimestamp = 1_710_000_000_000;
  const candles: CandleData[] = [];
  for (let index = 0; index < length; index += 1) {
    candles.push(
      createCandle({
        timestamp: baseTimestamp + index * 60_000,
        close: startClose + index * step,
        volume: 2_000 + index * 13,
      }),
    );
  }

  return candles;
}

function createCacheSnapshot(params: {
  readonly candles: ReadonlyArray<CandleData>;
  readonly version: number;
  readonly lastBarConfirmed: boolean;
}): CandlestickCacheSnapshot {
  const latest = params.candles.at(-1);
  const lastBarTimestamp =
    latest && typeof latest.timestamp === 'number' && Number.isFinite(latest.timestamp)
      ? latest.timestamp
      : null;
  return {
    symbol: 'HSI.HK',
    period: Period.Min_1,
    version: params.version,
    candles: params.candles,
    lastBarTimestamp,
    lastBarConfirmed: params.lastBarConfirmed,
    initialized: true,
  };
}

function expectRuntimeSnapshotEqualsFull(params: {
  readonly profile: IndicatorUsageProfile;
  readonly runtimeSnapshot: ReturnType<typeof buildSnapshotFromRuntime>;
  readonly candles: ReadonlyArray<CandleData>;
}): void {
  const fullSnapshot = buildIndicatorSnapshot('HSI.HK', params.candles, params.profile);
  expect(params.runtimeSnapshot).toEqual(fullSnapshot);
}

describe('indicators/runtime incremental business flow', () => {
  it('bootstraps incremental runtime from cache snapshot and matches full snapshot', () => {
    const profile = createIndicatorUsageProfileDouble();
    const candles = createTrendCandles(90, 100, 0.35);
    const cacheSnapshot = createCacheSnapshot({
      candles,
      version: 1,
      lastBarConfirmed: false,
    });

    const runtime = bootstrapIndicatorRuntime({
      symbol: 'HSI.HK',
      cacheSnapshot,
      indicatorProfile: profile,
    });
    expect(runtime).not.toBeNull();
    if (runtime === null) {
      throw new Error('expected runtime');
    }

    const runtimeSnapshot = buildSnapshotFromRuntime(runtime);
    expectRuntimeSnapshotEqualsFull({
      profile,
      runtimeSnapshot,
      candles,
    });
  });

  it('preserves price/changePercent semantics from the latest two valid closes', () => {
    const profile = createIndicatorUsageProfileDouble({
      requiredFamilies: {
        mfi: false,
        kdj: false,
        macd: false,
        adx: false,
      },
      requiredPeriods: {
        ema: [],
        rsi: [],
        psy: [],
      },
      displayPlan: ['price', 'changePercent'],
    });
    const baseTs = 1_710_100_000_000;
    const candles: ReadonlyArray<CandleData> = [
      { close: null, high: 1, low: 1, volume: 1, timestamp: baseTs },
      { close: 100, high: 100.2, low: 99.8, volume: 1_000, timestamp: baseTs + 60_000 },
      { close: 0, high: 100.2, low: 99.8, volume: 1_000, timestamp: baseTs + 120_000 },
      { close: 103, high: 103.2, low: 102.5, volume: 1_020, timestamp: baseTs + 180_000 },
    ];
    const cacheSnapshot = createCacheSnapshot({
      candles,
      version: 1,
      lastBarConfirmed: true,
    });

    const runtime = bootstrapIndicatorRuntime({
      symbol: 'HSI.HK',
      cacheSnapshot,
      indicatorProfile: profile,
    });
    expect(runtime).not.toBeNull();
    if (runtime === null) {
      throw new Error('expected runtime');
    }

    const runtimeSnapshot = buildSnapshotFromRuntime(runtime);
    expectRuntimeSnapshotEqualsFull({
      profile,
      runtimeSnapshot,
      candles,
    });
    expect(runtimeSnapshot?.price).toBe(103);
    expect(runtimeSnapshot?.changePercent).toBe(3);
  });

  it('matches rounding and invalid-value semantics for RSI/MFI/ADX and non-rounded indicators', () => {
    const profile = createIndicatorUsageProfileDouble();
    const candles = createTrendCandles(120, 88.3, 0.173);
    const cacheSnapshot = createCacheSnapshot({
      candles,
      version: 1,
      lastBarConfirmed: true,
    });

    const runtime = bootstrapIndicatorRuntime({
      symbol: 'HSI.HK',
      cacheSnapshot,
      indicatorProfile: profile,
    });
    expect(runtime).not.toBeNull();
    if (runtime === null) {
      throw new Error('expected runtime');
    }

    const runtimeSnapshot = buildSnapshotFromRuntime(runtime);
    const fullSnapshot = buildIndicatorSnapshot('HSI.HK', candles, profile);
    expect(runtimeSnapshot).toEqual(fullSnapshot);
    expect(runtimeSnapshot?.rsi?.[6]).toBe(fullSnapshot?.rsi?.[6]);
    expect(runtimeSnapshot?.mfi).toBe(fullSnapshot?.mfi);
    expect(runtimeSnapshot?.adx).toBe(fullSnapshot?.adx);
    expect(runtimeSnapshot?.ema?.[7]).toBe(fullSnapshot?.ema?.[7]);
    expect(runtimeSnapshot?.psy?.[13]).toBe(fullSnapshot?.psy?.[13]);
    expect(runtimeSnapshot?.macd?.dif).toBe(fullSnapshot?.macd?.dif);
    expect(runtimeSnapshot?.kdj?.k).toBe(fullSnapshot?.kdj?.k);
  });

  it('updates snapshot incrementally on active bar updates, confirmation, replay and same-tick shift', () => {
    const profile = createIndicatorUsageProfileDouble();
    const initialCandles = createTrendCandles(90, 105, 0.27);
    const baseActive = initialCandles.at(-1);
    if (!baseActive || typeof baseActive.timestamp !== 'number') {
      throw new Error('expected active bar');
    }

    const bootstrapSnapshot = createCacheSnapshot({
      candles: initialCandles,
      version: 1,
      lastBarConfirmed: false,
    });
    let runtime = bootstrapIndicatorRuntime({
      symbol: 'HSI.HK',
      cacheSnapshot: bootstrapSnapshot,
      indicatorProfile: profile,
    });
    expect(runtime).not.toBeNull();
    if (runtime === null) {
      throw new Error('expected runtime');
    }

    const activeUpdatedCandles = [
      ...initialCandles.slice(0, -1),
      createCandle({
        timestamp: baseActive.timestamp,
        close: Number(baseActive.close) + 1.2,
        highOffset: 1.3,
        lowOffset: 0.8,
        volume: 9_999,
      }),
    ];
    runtime = updateRuntimeForCandlestickSnapshot({
      runtime,
      cacheSnapshot: createCacheSnapshot({
        candles: activeUpdatedCandles,
        version: 2,
        lastBarConfirmed: false,
      }),
    });
    expect(runtime).not.toBeNull();
    if (runtime === null) {
      throw new Error('expected runtime after active update');
    }

    expectRuntimeSnapshotEqualsFull({
      profile,
      runtimeSnapshot: buildSnapshotFromRuntime(runtime),
      candles: activeUpdatedCandles,
    });

    runtime = updateRuntimeForCandlestickSnapshot({
      runtime,
      cacheSnapshot: createCacheSnapshot({
        candles: activeUpdatedCandles,
        version: 3,
        lastBarConfirmed: true,
      }),
    });
    expect(runtime).not.toBeNull();
    if (runtime === null) {
      throw new Error('expected runtime after confirmation');
    }

    const confirmedSnapshot = buildSnapshotFromRuntime(runtime);
    expectRuntimeSnapshotEqualsFull({
      profile,
      runtimeSnapshot: confirmedSnapshot,
      candles: activeUpdatedCandles,
    });

    runtime = updateRuntimeForCandlestickSnapshot({
      runtime,
      cacheSnapshot: createCacheSnapshot({
        candles: activeUpdatedCandles,
        version: 4,
        lastBarConfirmed: true,
      }),
    });
    expect(runtime).not.toBeNull();
    if (runtime === null) {
      throw new Error('expected runtime after replay');
    }

    expect(buildSnapshotFromRuntime(runtime)).toEqual(confirmedSnapshot);

    const appendedCandles = [
      ...activeUpdatedCandles,
      createCandle({
        timestamp: baseActive.timestamp + 60_000,
        close: Number(baseActive.close) + 1.6,
        highOffset: 1.1,
        lowOffset: 0.5,
        volume: 10_100,
      }),
    ];
    runtime = updateRuntimeForCandlestickSnapshot({
      runtime,
      cacheSnapshot: createCacheSnapshot({
        candles: appendedCandles,
        version: 5,
        lastBarConfirmed: false,
      }),
    });
    expect(runtime).not.toBeNull();
    if (runtime === null) {
      throw new Error('expected runtime after shift');
    }

    expectRuntimeSnapshotEqualsFull({
      profile,
      runtimeSnapshot: buildSnapshotFromRuntime(runtime),
      candles: appendedCandles,
    });
  });

  it('finalizes the previous active bar when the next tick only sees a shifted snapshot', () => {
    const profile = createIndicatorUsageProfileDouble();
    const initialCandles = createTrendCandles(90, 105, 0.27);
    const baseActive = initialCandles.at(-1);
    if (!baseActive || typeof baseActive.timestamp !== 'number') {
      throw new Error('expected active bar');
    }

    const bootstrapSnapshot = createCacheSnapshot({
      candles: initialCandles,
      version: 1,
      lastBarConfirmed: false,
    });
    let runtime = bootstrapIndicatorRuntime({
      symbol: 'HSI.HK',
      cacheSnapshot: bootstrapSnapshot,
      indicatorProfile: profile,
    });
    expect(runtime).not.toBeNull();
    if (runtime === null) {
      throw new Error('expected runtime');
    }

    const shiftedCandles = [
      ...initialCandles.slice(0, -1),
      createCandle({
        timestamp: baseActive.timestamp,
        close: Number(baseActive.close) + 1.1,
        highOffset: 1.2,
        lowOffset: 0.7,
        volume: 8_888,
      }),
      createCandle({
        timestamp: baseActive.timestamp + 60_000,
        close: Number(baseActive.close) + 1.8,
        highOffset: 1.4,
        lowOffset: 0.6,
        volume: 9_777,
      }),
    ];

    runtime = updateRuntimeForCandlestickSnapshot({
      runtime,
      cacheSnapshot: createCacheSnapshot({
        candles: shiftedCandles,
        version: 2,
        lastBarConfirmed: false,
      }),
    });
    expect(runtime).not.toBeNull();
    if (runtime === null) {
      throw new Error('expected runtime after shifted snapshot');
    }

    expectRuntimeSnapshotEqualsFull({
      profile,
      runtimeSnapshot: buildSnapshotFromRuntime(runtime),
      candles: shiftedCandles,
    });
  });
});
