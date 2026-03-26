/**
 * indicators/runtime 指标运行时计算模块
 *
 * 职责：
 * - 提供旧全量构建函数（作为对拍 oracle）
 * - 提供增量 runtime 的 bootstrap / update / snapshot 构造能力
 * - 确保对象池对象仅在对外快照构造时创建，不在 runtime 内长期持有
 */
import { isValidPositiveNumber } from '../../../utils/helpers/index.js';
import { periodRecordPool } from '../../../utils/objectPool/index.js';
import type { CandleData } from '../../../types/data.js';
import type { IndicatorSnapshot } from '../../../types/quote.js';
import type { IndicatorUsageProfile } from '../../../types/indicatorProfile.js';
import type { CandlestickCacheSnapshot } from '../../../types/services.js';
import type { IndicatorIncrementalRuntime } from '../../../types/indicatorRuntime.js';
import {
  validateEmaPeriod,
  validatePsyPeriod,
  validateRsiPeriod,
} from '../../../utils/indicatorHelpers/index.js';
import { cloneAdxState, commitAdxCandle, createAdxState, readAdxValue } from './adx.js';
import { cloneEmaState, commitEmaClose, createEmaState, readEmaValue } from './ema.js';
import { cloneKdjState, commitKdjCandle, createKdjState, readKdjValue } from './kdj.js';
import { cloneMacdState, commitMacdClose, createMacdState, readMacdValue } from './macd.js';
import { cloneMfiState, commitMfiCandle, createMfiState, readMfiValue } from './mfi.js';
import { clonePsyState, commitPsyClose, createPsyState, readPsyValue } from './psy.js';
import { cloneRsiState, commitRsiClose, createRsiState, readRsiValue } from './rsi.js';
import { toNumber } from './utils.js';
import type { IndicatorCommittedState, IndicatorRuntimeStateFields } from './types.js';

const indicatorRuntimeStateBrand = Symbol('IndicatorRuntimeState');

type IndicatorRuntimeState = IndicatorRuntimeStateFields & {
  readonly [indicatorRuntimeStateBrand]: true;
};

function createIndicatorRuntimeState(fields: IndicatorRuntimeStateFields): IndicatorRuntimeState {
  return {
    ...fields,
    [indicatorRuntimeStateBrand]: true,
  };
}

function toIndicatorIncrementalRuntime(
  runtimeState: IndicatorRuntimeState,
): IndicatorIncrementalRuntime {
  return runtimeState as unknown as IndicatorIncrementalRuntime;
}

function unwrapIndicatorRuntime(
  runtime: IndicatorIncrementalRuntime,
): IndicatorRuntimeState | null {
  if (!(indicatorRuntimeStateBrand in runtime)) {
    return null;
  }

  return runtime as unknown as IndicatorRuntimeState;
}

/**
 * 从 K 线长度与最后一根收盘价构造指纹字符串（格式 length_lastClose），供 getCandleFingerprint 使用。
 *
 * @param candles K 线数据数组（仅用 length）
 * @param lastClose 最后一根 K 线收盘价
 * @returns 指纹字符串
 */
function buildDataFingerprint(candles: ReadonlyArray<CandleData>, lastClose: number): string {
  return `${candles.length}_${lastClose}`;
}

/**
 * 从 K 线计算指纹，供旧路径判断是否可复用上一拍快照。
 *
 * @param candles K 线数据数组
 * @returns 指纹字符串（格式：length_lastClose），无效时返回 null
 */
export function getCandleFingerprint(candles: ReadonlyArray<CandleData>): string | null {
  if (candles.length === 0) {
    return null;
  }

  const lastCandle = candles.at(-1);
  const lastClose = lastCandle ? toNumber(lastCandle.close) : 0;
  if (!isValidPositiveNumber(lastClose)) {
    return null;
  }

  return buildDataFingerprint(candles, lastClose);
}

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

function cloneRecord<T>(source: Record<number, T>, cloneState: (value: T) => T): Record<number, T> {
  const result: Record<number, T> = {};
  for (const [periodKey, state] of Object.entries(source)) {
    const period = Number(periodKey);
    if (!Number.isFinite(period)) {
      continue;
    }

    result[period] = cloneState(state);
  }

  return result;
}

/**
 * 基于指标画像创建仅包含已确认收线状态的 committed 容器。
 *
 * 该状态只允许由 bootstrap 或 confirmed/shift commit 推进，不能直接承载活动 bar 的 preview 结果，
 * 从而保证运行期始终存在一份稳定、可复用的已提交指标基线。
 *
 * @param profile 指标画像
 * @returns 仅包含 committed 指标子状态的容器
 */
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

function cloneCommittedState(committed: IndicatorCommittedState): IndicatorCommittedState {
  return {
    lastValidClose: committed.lastValidClose,
    previousValidClose: committed.previousValidClose,
    emaStates: cloneRecord(committed.emaStates, cloneEmaState),
    rsiStates: cloneRecord(committed.rsiStates, cloneRsiState),
    psyStates: cloneRecord(committed.psyStates, clonePsyState),
    mfiState: committed.mfiState === null ? null : cloneMfiState(committed.mfiState),
    kdjState: committed.kdjState === null ? null : cloneKdjState(committed.kdjState),
    macdState: committed.macdState === null ? null : cloneMacdState(committed.macdState),
    adxState: committed.adxState === null ? null : cloneAdxState(committed.adxState),
  };
}

/**
 * 将单根已确认 K 线正式写入 committed 状态。
 *
 * 该函数只用于 confirmed bar 或 shift 后已完成的历史 bar，负责同步推进最近两个有效 close、
 * 周期指标状态以及依赖整根 OHLCV 的指标状态。活动 bar 的 preview 不会直接污染这里的输入状态。
 *
 * @param state committed 指标状态
 * @param candle 已确认收线的 K 线
 */
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
  readonly readValue: (state: T, period: number) => number | null;
}): Record<number, number> | null {
  if (params.periods.length === 0) {
    return null;
  }

  const periodRecord = periodRecordPool.acquire();
  let hasValue = false;
  for (const period of params.periods) {
    if (!params.isValidPeriod(period) || !Number.isInteger(period)) {
      continue;
    }

    const state = params.states[period];
    if (!state) {
      continue;
    }

    const value = params.readValue(state, period);
    if (value === null) {
      continue;
    }

    periodRecord[period] = value;
    hasValue = true;
  }

  if (hasValue) {
    return periodRecord;
  }

  periodRecordPool.release(periodRecord);
  return null;
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
 * 构建指标快照（旧全量路径，保留作为对拍 oracle）。
 *
 * @param symbol 标的代码
 * @param candles K线数据数组
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

function resolveActiveBar(params: {
  readonly candles: ReadonlyArray<CandleData>;
  readonly lastBarConfirmed: boolean | null;
}): CandleData | null {
  if (params.lastBarConfirmed !== false) {
    return null;
  }

  return params.candles.at(-1) ?? null;
}

/**
 * 从缓存快照 bootstrap 增量运行态。
 *
 * @param params bootstrap 参数
 * @returns 增量运行态，无有效输入时返回 null
 */
export function bootstrapIndicatorRuntime(params: {
  readonly symbol: string;
  readonly cacheSnapshot: CandlestickCacheSnapshot;
  readonly indicatorProfile: IndicatorUsageProfile;
}): IndicatorIncrementalRuntime | null {
  const { symbol, cacheSnapshot, indicatorProfile } = params;
  if (!cacheSnapshot.initialized || cacheSnapshot.candles.length === 0) {
    return null;
  }

  const activeBar = resolveActiveBar({
    candles: cacheSnapshot.candles,
    lastBarConfirmed: cacheSnapshot.lastBarConfirmed,
  });
  const committed = buildCommittedState(indicatorProfile);
  const closedCandlesEnd =
    activeBar === null ? cacheSnapshot.candles.length : cacheSnapshot.candles.length - 1;
  for (let index = 0; index < closedCandlesEnd; index += 1) {
    const candle = cacheSnapshot.candles[index];
    if (!candle) {
      continue;
    }

    commitCandleToCommittedState(committed, candle);
  }

  const lastClosed = closedCandlesEnd > 0 ? cacheSnapshot.candles[closedCandlesEnd - 1] : undefined;
  return toIndicatorIncrementalRuntime(
    createIndicatorRuntimeState({
      symbol,
      profile: indicatorProfile,
      lastProcessedVersion: cacheSnapshot.version,
      closedBarTimestamp:
        lastClosed && typeof lastClosed.timestamp === 'number' ? lastClosed.timestamp : null,
      activeBarTimestamp:
        activeBar && typeof activeBar.timestamp === 'number' ? activeBar.timestamp : null,
      activeBarConfirmed: activeBar === null ? cacheSnapshot.lastBarConfirmed : false,
      activeBar,
      lastBarTimestamp: cacheSnapshot.lastBarTimestamp,
      lastBarConfirmed: cacheSnapshot.lastBarConfirmed,
      committed,
    }),
  );
}

/**
 * 无法可靠增量推进时，基于最新缓存快照回退重建 runtime。
 *
 * @param params 运行态与最新缓存快照
 * @returns 重建后的增量运行态；输入无效时返回 null
 */
function rebuildRuntimeFromSnapshot(params: {
  readonly runtime: IndicatorRuntimeState;
  readonly cacheSnapshot: CandlestickCacheSnapshot;
}): IndicatorIncrementalRuntime | null {
  return bootstrapIndicatorRuntime({
    symbol: params.runtime.symbol,
    cacheSnapshot: params.cacheSnapshot,
    indicatorProfile: params.runtime.profile,
  });
}

/**
 * 在缓存最后一根 timestamp 前进后，提交旧活动 bar 并衔接新的活动/已确认区间。
 *
 * 该分支负责处理“上一拍还是活动 bar，本拍只看到了最终 shift 后快照”的场景：
 * 如果旧最后一根尚未确认，就先把它按 finalized previous bar 提交，再继续消费后续新增 candles，
 * 从而保证 confirmed 与 next bar 在同一主循环间隔内到达时，committed 状态仍与全量重算一致。
 *
 * @param params 运行态与最新缓存快照
 * @returns 推进后的增量运行态；无法可靠推进时回退为重建或返回 null
 */
function commitShiftedCandles(params: {
  readonly runtime: IndicatorRuntimeState;
  readonly cacheSnapshot: CandlestickCacheSnapshot;
}): IndicatorIncrementalRuntime | null {
  const { runtime, cacheSnapshot } = params;
  const previousTimestamp = runtime.lastBarTimestamp;
  if (previousTimestamp === null) {
    return rebuildRuntimeFromSnapshot({ runtime, cacheSnapshot });
  }

  const previousIndex = cacheSnapshot.candles.findIndex(
    (candle) => candle.timestamp === previousTimestamp,
  );
  if (previousIndex === -1) {
    return rebuildRuntimeFromSnapshot({ runtime, cacheSnapshot });
  }

  const nextCommitted = cloneCommittedState(runtime.committed);
  let closedBarTimestamp = runtime.closedBarTimestamp;
  if (runtime.lastBarConfirmed === false) {
    const finalizedPrevious = cacheSnapshot.candles[previousIndex];
    if (finalizedPrevious) {
      commitCandleToCommittedState(nextCommitted, finalizedPrevious);
      if (typeof finalizedPrevious.timestamp === 'number') {
        closedBarTimestamp = finalizedPrevious.timestamp;
      }
    }
  }

  let activeBar: CandleData | null = null;
  let activeBarTimestamp: number | null = null;
  let activeBarConfirmed: boolean | null = cacheSnapshot.lastBarConfirmed;
  const lastIndex = cacheSnapshot.candles.length - 1;
  for (let index = previousIndex + 1; index < cacheSnapshot.candles.length; index += 1) {
    const candle = cacheSnapshot.candles[index];
    if (!candle) {
      continue;
    }

    const isLast = index === lastIndex;
    if (isLast && cacheSnapshot.lastBarConfirmed === false) {
      activeBar = candle;
      activeBarTimestamp =
        typeof candle.timestamp === 'number' && Number.isFinite(candle.timestamp)
          ? candle.timestamp
          : null;
      activeBarConfirmed = false;
      continue;
    }

    commitCandleToCommittedState(nextCommitted, candle);
    if (typeof candle.timestamp === 'number' && Number.isFinite(candle.timestamp)) {
      closedBarTimestamp = candle.timestamp;
    }
  }

  return toIndicatorIncrementalRuntime(
    createIndicatorRuntimeState({
      ...runtime,
      lastProcessedVersion: cacheSnapshot.version,
      closedBarTimestamp,
      activeBarTimestamp,
      activeBarConfirmed,
      activeBar,
      lastBarTimestamp: cacheSnapshot.lastBarTimestamp,
      lastBarConfirmed: cacheSnapshot.lastBarConfirmed,
      committed: nextCommitted,
    }),
  );
}

/**
 * 基于最新缓存快照推进增量运行态。
 *
 * @param params 更新参数
 * @returns 新运行态；输入无效时返回 null
 */
export function updateRuntimeForCandlestickSnapshot(params: {
  readonly runtime: IndicatorIncrementalRuntime;
  readonly cacheSnapshot: CandlestickCacheSnapshot;
}): IndicatorIncrementalRuntime | null {
  const { runtime, cacheSnapshot } = params;
  if (!cacheSnapshot.initialized || cacheSnapshot.candles.length === 0) {
    return null;
  }

  const runtimeState = unwrapIndicatorRuntime(runtime);
  if (runtimeState === null) {
    return null;
  }

  if (cacheSnapshot.version === runtimeState.lastProcessedVersion) {
    return toIndicatorIncrementalRuntime(runtimeState);
  }

  const nextLastTimestamp = cacheSnapshot.lastBarTimestamp;
  const previousLastTimestamp = runtimeState.lastBarTimestamp;
  if (nextLastTimestamp === null || previousLastTimestamp === null) {
    return rebuildRuntimeFromSnapshot({ runtime: runtimeState, cacheSnapshot });
  }

  if (nextLastTimestamp === previousLastTimestamp) {
    const latestCandle = cacheSnapshot.candles.at(-1) ?? null;
    if (latestCandle === null) {
      return null;
    }

    if (runtimeState.lastBarConfirmed === false && cacheSnapshot.lastBarConfirmed === false) {
      return toIndicatorIncrementalRuntime(
        createIndicatorRuntimeState({
          ...runtimeState,
          lastProcessedVersion: cacheSnapshot.version,
          activeBarTimestamp: nextLastTimestamp,
          activeBarConfirmed: false,
          activeBar: latestCandle,
          lastBarTimestamp: cacheSnapshot.lastBarTimestamp,
          lastBarConfirmed: cacheSnapshot.lastBarConfirmed,
        }),
      );
    }

    if (runtimeState.lastBarConfirmed === false && cacheSnapshot.lastBarConfirmed === true) {
      const nextCommitted = cloneCommittedState(runtimeState.committed);
      commitCandleToCommittedState(nextCommitted, latestCandle);
      return toIndicatorIncrementalRuntime(
        createIndicatorRuntimeState({
          ...runtimeState,
          lastProcessedVersion: cacheSnapshot.version,
          closedBarTimestamp: nextLastTimestamp,
          activeBarTimestamp: null,
          activeBarConfirmed: true,
          activeBar: null,
          lastBarTimestamp: cacheSnapshot.lastBarTimestamp,
          lastBarConfirmed: cacheSnapshot.lastBarConfirmed,
          committed: nextCommitted,
        }),
      );
    }

    return rebuildRuntimeFromSnapshot({ runtime: runtimeState, cacheSnapshot });
  }

  return commitShiftedCandles({
    runtime: runtimeState,
    cacheSnapshot,
  });
}

/**
 * 从增量运行态构造对外指标快照。
 *
 * @param runtime 增量运行态
 * @returns 指标快照；当运行态句柄无效或无有效价格时返回 null
 */
export function buildSnapshotFromRuntime(
  runtime: IndicatorIncrementalRuntime,
): IndicatorSnapshot | null {
  const runtimeState = unwrapIndicatorRuntime(runtime);
  if (runtimeState === null) {
    return null;
  }

  if (runtimeState.activeBar !== null && runtimeState.activeBarConfirmed === false) {
    const previewCommitted = cloneCommittedState(runtimeState.committed);
    commitCandleToCommittedState(previewCommitted, runtimeState.activeBar);
    return buildSnapshotFromCommitted({
      symbol: runtimeState.symbol,
      profile: runtimeState.profile,
      committed: previewCommitted,
    });
  }

  return buildSnapshotFromCommitted({
    symbol: runtimeState.symbol,
    profile: runtimeState.profile,
    committed: runtimeState.committed,
  });
}
