/**
 * dailyKlineMonitor 工具全量指标快照模块。
 * 职责：为监控工具和对拍测试提供旧全量口径的指标快照构造能力。
 */
import { isValidPositiveNumber } from '../../src/utils/helpers/index.js';
import type { CandleData } from '../../src/types/data.js';
import type { IndicatorUsageProfile } from '../../src/types/indicatorProfile.js';
import type { IndicatorSnapshot } from '../../src/types/quote.js';
import {
  validateEmaPeriod,
  validatePsyPeriod,
  validateRsiPeriod,
} from '../../src/utils/indicatorHelpers/index.js';
import {
  createAdxState,
  commitAdxCandle,
  readAdxValue,
} from '../../src/services/indicators/runtime/adx.js';
import {
  createEmaState,
  commitEmaClose,
  readEmaValue,
} from '../../src/services/indicators/runtime/ema.js';
import {
  createKdjState,
  commitKdjCandle,
  readKdjValue,
} from '../../src/services/indicators/runtime/kdj.js';
import {
  createMacdState,
  commitMacdClose,
  readMacdValue,
} from '../../src/services/indicators/runtime/macd.js';
import {
  createMfiState,
  commitMfiCandle,
  readMfiValue,
} from '../../src/services/indicators/runtime/mfi.js';
import {
  createPsyState,
  commitPsyClose,
  readPsyValue,
} from '../../src/services/indicators/runtime/psy.js';
import {
  createRsiState,
  commitRsiClose,
  readRsiValue,
} from '../../src/services/indicators/runtime/rsi.js';
import { toNumber } from '../../src/services/indicators/runtime/utils.js';
import type { IndicatorCommittedState } from '../../src/services/indicators/runtime/types.js';

function createRecordFromPeriods<T>(params: {
  readonly periods: ReadonlyArray<number>;
  readonly isValidPeriod: (period: unknown) => period is number;
  readonly createState: (period: number) => T;
}): Record<number, T> {
  const result: Record<number, T> = {};
  for (const period of params.periods) {
    if (!params.isValidPeriod(period) || !Number.isInteger(period)) {
      continue;
    }

    result[period] = params.createState(period);
  }

  return result;
}

function buildCommittedState(profile: IndicatorUsageProfile): IndicatorCommittedState {
  return {
    lastValidClose: null,
    previousValidClose: null,
    emaStates: createRecordFromPeriods({
      periods: profile.requiredPeriods.ema,
      isValidPeriod: validateEmaPeriod,
      createState: (period) => createEmaState(period),
    }),
    rsiStates: createRecordFromPeriods({
      periods: profile.requiredPeriods.rsi,
      isValidPeriod: validateRsiPeriod,
      createState: (period) => createRsiState(period),
    }),
    psyStates: createRecordFromPeriods({
      periods: profile.requiredPeriods.psy,
      isValidPeriod: validatePsyPeriod,
      createState: (period) => createPsyState(period),
    }),
    mfiState: profile.requiredFamilies.mfi ? createMfiState(14) : null,
    kdjState: profile.requiredFamilies.kdj ? createKdjState(9, 5) : null,
    macdState: profile.requiredFamilies.macd ? createMacdState(12, 26, 9) : null,
    adxState: profile.requiredFamilies.adx ? createAdxState(14) : null,
  };
}

function commitCandleToCommittedState(state: IndicatorCommittedState, candle: CandleData): void {
  const close = toNumber(candle.close);
  if (isValidPositiveNumber(close)) {
    state.previousValidClose = state.lastValidClose;
    state.lastValidClose = close;

    for (const emaState of Object.values(state.emaStates)) {
      commitEmaClose(emaState, close);
    }

    for (const rsiState of Object.values(state.rsiStates)) {
      commitRsiClose(rsiState, close);
    }

    for (const psyState of Object.values(state.psyStates)) {
      commitPsyClose(psyState, close);
    }

    if (state.macdState !== null) {
      commitMacdClose(state.macdState, close);
    }
  }

  if (state.mfiState !== null) {
    commitMfiCandle(state.mfiState, candle);
  }

  if (state.kdjState !== null) {
    commitKdjCandle(state.kdjState, candle);
  }

  if (state.adxState !== null) {
    commitAdxCandle(state.adxState, candle);
  }
}

function buildPeriodSnapshotRecord<T>(params: {
  readonly periods: ReadonlyArray<number>;
  readonly isValidPeriod: (period: unknown) => period is number;
  readonly states: Record<number, T>;
  readonly readValue: (state: T) => number | null;
}): Record<number, number> | null {
  if (params.periods.length === 0) {
    return null;
  }

  const periodRecord: Record<number, number> = {};
  let hasValue = false;
  for (const period of params.periods) {
    if (!params.isValidPeriod(period) || !Number.isInteger(period)) {
      continue;
    }

    const state = params.states[period];
    if (!state) {
      continue;
    }

    const value = params.readValue(state);
    if (value === null) {
      continue;
    }

    periodRecord[period] = value;
    hasValue = true;
  }

  return hasValue ? periodRecord : null;
}

function buildSnapshotFromCommitted(params: {
  readonly symbol: string;
  readonly profile: IndicatorUsageProfile;
  readonly committed: IndicatorCommittedState;
}): IndicatorSnapshot | null {
  const { symbol, profile, committed } = params;
  const price = committed.lastValidClose;
  if (price === null) {
    return null;
  }

  let changePercent: number | null = null;
  if (committed.previousValidClose !== null) {
    changePercent = ((price - committed.previousValidClose) / committed.previousValidClose) * 100;
  }

  const ema = buildPeriodSnapshotRecord({
    periods: profile.requiredPeriods.ema,
    isValidPeriod: validateEmaPeriod,
    states: committed.emaStates,
    readValue: (state) => readEmaValue(state),
  });
  const rsi = buildPeriodSnapshotRecord({
    periods: profile.requiredPeriods.rsi,
    isValidPeriod: validateRsiPeriod,
    states: committed.rsiStates,
    readValue: (state) => readRsiValue(state),
  });
  const psy = buildPeriodSnapshotRecord({
    periods: profile.requiredPeriods.psy,
    isValidPeriod: validatePsyPeriod,
    states: committed.psyStates,
    readValue: (state) => readPsyValue(state),
  });
  const mfi =
    profile.requiredFamilies.mfi && committed.mfiState !== null
      ? readMfiValue(committed.mfiState)
      : null;
  const kdj =
    profile.requiredFamilies.kdj && committed.kdjState !== null
      ? readKdjValue(committed.kdjState)
      : null;
  const macd =
    profile.requiredFamilies.macd && committed.macdState !== null
      ? readMacdValue(committed.macdState)
      : null;
  const adx =
    profile.requiredFamilies.adx && committed.adxState !== null
      ? readAdxValue(committed.adxState)
      : null;

  return {
    symbol,
    price,
    changePercent,
    ema,
    rsi,
    psy,
    mfi,
    kdj,
    macd,
    adx,
  };
}

/**
 * 构建指标快照（工具侧旧全量路径 oracle）。默认行为：无有效价格时返回 null。
 *
 * @param symbol 标的代码
 * @param candles K 线数据数组
 * @param indicatorProfile 指标画像
 * @returns 指标快照，无有效价格时返回 null
 */
export function buildIndicatorSnapshot(
  symbol: string,
  candles: ReadonlyArray<CandleData>,
  indicatorProfile: IndicatorUsageProfile,
): IndicatorSnapshot | null {
  if (candles.length === 0) {
    return null;
  }

  const committed = buildCommittedState(indicatorProfile);
  for (const candle of candles) {
    commitCandleToCommittedState(committed, candle);
  }

  return buildSnapshotFromCommitted({
    symbol,
    profile: indicatorProfile,
    committed,
  });
}
