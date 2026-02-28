/**
 * 交易日历预热器模块
 *
 * 核心职责：
 * - 在重建阶段基于“当前仍持仓买单”计算交易日历需求窗口
 * - 仅补齐快照缺失日期，避免重复查询
 * - 按自然月分块调用交易日接口，严格遵守单次查询区间约束
 *
 * 约束与失败策略：
 * - 交易日历接口仅支持最近一年窗口，超出范围直接抛错阻断重建
 * - 任一查询失败即抛错，由生命周期管理器统一重试
 */
import { LIFECYCLE, TIME } from '../../constants/index.js';
import { isSeatReady } from '../../services/autoSymbolManager/utils.js';
import type { MonitorContext } from '../../types/state.js';
import type { MarketDataClient, OrderRecord, TradingDayInfo } from '../../types/services.js';
import { listHKDateKeysBetween, resolveHKDayStartUtcMs } from './utils.js';
import { getHKDateKey } from '../../utils/tradingTime/index.js';
import type {
  DateRangeChunk,
  PrewarmTradingCalendarSnapshotParams,
  TradingCalendarPrewarmError,
  TradingCalendarPrewarmErrorParams,
} from './types.js';
/**
 * 创建交易日历预热结构化错误，附带稳定错误码与上下文，便于生命周期日志与告警定位。
 */
function createTradingCalendarPrewarmError(
  params: TradingCalendarPrewarmErrorParams,
): TradingCalendarPrewarmError {
  const error = new Error(params.message);
  error.name = 'TradingCalendarPrewarmError';
  return Object.assign(error, {
    code: params.code,
    details: params.details,
  });
}
/**
 * 在重建阶段预热交易日历快照：按 READY 席位仍持仓订单决定窗口，补齐缺失日期后写回 lastState。
 */
export async function prewarmTradingCalendarSnapshotForRebuild(
  params: PrewarmTradingCalendarSnapshotParams,
): Promise<void> {
  const { marketDataClient, lastState, monitorContexts, now } = params;
  const nowMs = now.getTime();
  const earliestOpenOrderMs = resolveEarliestOpenOrderExecutedMs(monitorContexts);
  const fallbackStartMs =
    nowMs - LIFECYCLE.CALENDAR_PREWARM_FALLBACK_LOOKBACK_DAYS * TIME.MILLISECONDS_PER_DAY;
  const demandStartMs = earliestOpenOrderMs ?? fallbackStartMs;
  const demandEndMs = nowMs + LIFECYCLE.CALENDAR_PREWARM_LOOKAHEAD_DAYS * TIME.MILLISECONDS_PER_DAY;
  assertCalendarLookbackRange(demandStartMs, nowMs);
  const demandDateKeys = listHKDateKeysBetween(demandStartMs, demandEndMs);
  if (demandDateKeys.length === 0) {
    return;
  }
  const nextSnapshot = new Map<string, TradingDayInfo>(lastState.tradingCalendarSnapshot ?? []);
  const missingDateKeys = demandDateKeys.filter((dateKey) => !nextSnapshot.has(dateKey));
  if (missingDateKeys.length > 0) {
    await (marketDataClient.getTradingDays
      ? hydrateSnapshotByMonthlyTradingDays({
          marketDataClient,
          dateKeys: missingDateKeys,
          nextSnapshot,
        })
      : hydrateSnapshotByDailyTradingDay({
          marketDataClient,
          dateKeys: missingDateKeys,
          nextSnapshot,
        }));
  }
  const nowDateKey = getHKDateKey(now);
  if (nowDateKey && lastState.cachedTradingDayInfo) {
    nextSnapshot.set(nowDateKey, lastState.cachedTradingDayInfo);
  }
  lastState.tradingCalendarSnapshot = nextSnapshot;
}
/**
 * 从 READY 席位提取当前仍持仓买单，返回最早成交时间。
 */
function resolveEarliestOpenOrderExecutedMs(
  monitorContexts: ReadonlyMap<string, MonitorContext>,
): number | null {
  let earliestMs: number | null = null;
  for (const monitorContext of monitorContexts.values()) {
    const monitorSymbol = monitorContext.config.monitorSymbol;
    const longSeatState = monitorContext.symbolRegistry.getSeatState(monitorSymbol, 'LONG');
    const shortSeatState = monitorContext.symbolRegistry.getSeatState(monitorSymbol, 'SHORT');
    if (isSeatReady(longSeatState)) {
      const longOrders = monitorContext.orderRecorder.getBuyOrdersForSymbol(
        longSeatState.symbol,
        true,
      );
      earliestMs = resolveMinTimestamp(earliestMs, longOrders);
    }
    if (isSeatReady(shortSeatState)) {
      const shortOrders = monitorContext.orderRecorder.getBuyOrdersForSymbol(
        shortSeatState.symbol,
        false,
      );
      earliestMs = resolveMinTimestamp(earliestMs, shortOrders);
    }
  }
  return earliestMs;
}
/**
 * 在当前最小值基础上，用订单列表中的有效成交时间更新最小时间戳。
 */
function resolveMinTimestamp(
  currentEarliestMs: number | null,
  orders: ReadonlyArray<OrderRecord>,
): number | null {
  let earliestMs = currentEarliestMs;
  for (const order of orders) {
    const executedTimeMs = order.executedTime;
    if (!Number.isFinite(executedTimeMs)) {
      continue;
    }
    if (earliestMs === null || executedTimeMs < earliestMs) {
      earliestMs = executedTimeMs;
    }
  }
  return earliestMs;
}
/**
 * 校验需求窗口是否落在交易日接口“最近一年”能力范围内。
 */
function assertCalendarLookbackRange(demandStartMs: number, nowMs: number): void {
  const earliestAllowedMs =
    nowMs - LIFECYCLE.CALENDAR_API_MAX_LOOKBACK_DAYS * TIME.MILLISECONDS_PER_DAY;
  if (demandStartMs >= earliestAllowedMs) {
    return;
  }
  throw createTradingCalendarPrewarmError({
    code: 'TRADING_CALENDAR_LOOKBACK_EXCEEDED',
    message: '[交易日历快照] 预热窗口超出接口最近一年限制，重建已阻断',
    details: {
      demandStartDateKey: getHKDateKey(new Date(demandStartMs)),
      earliestAllowedDateKey: getHKDateKey(new Date(earliestAllowedMs)),
      nowDateKey: getHKDateKey(new Date(nowMs)),
      maxLookbackDays: LIFECYCLE.CALENDAR_API_MAX_LOOKBACK_DAYS,
    },
  });
}
/**
 * 使用交易日批量接口按自然月分块补齐快照缺失日期。
 */
async function hydrateSnapshotByMonthlyTradingDays({
  marketDataClient,
  dateKeys,
  nextSnapshot,
}: {
  marketDataClient: MarketDataClient;
  dateKeys: ReadonlyArray<string>;
  nextSnapshot: Map<string, TradingDayInfo>;
}): Promise<void> {
  const getTradingDays = marketDataClient.getTradingDays;
  if (!getTradingDays || dateKeys.length === 0) {
    return;
  }
  const chunks = splitMissingDateKeysByMonth(dateKeys);
  for (const chunk of chunks) {
    const startDate = resolveDateFromHKDateKey(chunk.startKey);
    const endDate = resolveDateFromHKDateKey(chunk.endKey);
    const result = await getTradingDays(startDate, endDate);
    const tradingSet = new Set(result.tradingDays);
    const halfDaySet = new Set(result.halfTradingDays);
    for (const dateKey of chunk.dateKeys) {
      const isHalfDay = halfDaySet.has(dateKey);
      const isTradingDay = isHalfDay || tradingSet.has(dateKey);
      nextSnapshot.set(dateKey, { isTradingDay, isHalfDay });
    }
  }
}
/**
 * 批量接口不可用时逐日查询，仍保持按缺失日期补齐语义。
 */
async function hydrateSnapshotByDailyTradingDay({
  marketDataClient,
  dateKeys,
  nextSnapshot,
}: {
  marketDataClient: MarketDataClient;
  dateKeys: ReadonlyArray<string>;
  nextSnapshot: Map<string, TradingDayInfo>;
}): Promise<void> {
  for (const dateKey of dateKeys) {
    const date = resolveDateFromHKDateKey(dateKey);
    const dayInfo = await marketDataClient.isTradingDay(date);
    nextSnapshot.set(dateKey, dayInfo);
  }
}
/**
 * 将缺失日期键切分为“同月且连续”的查询分块，确保每次请求不跨自然月且不覆盖已存在日期。
 */
function splitMissingDateKeysByMonth(
  dateKeys: ReadonlyArray<string>,
): ReadonlyArray<DateRangeChunk> {
  if (dateKeys.length === 0) {
    return [];
  }
  const firstDateKey = dateKeys[0];
  if (!firstDateKey) {
    return [];
  }
  const chunks: DateRangeChunk[] = [];
  let chunkStartKey = firstDateKey;
  let previousKey = firstDateKey;
  let chunkDateKeys: string[] = [chunkStartKey];
  for (let index = 1; index < dateKeys.length; index += 1) {
    const currentKey = dateKeys[index];
    if (!currentKey) {
      continue;
    }
    const sameMonth = resolveMonthKey(chunkStartKey) === resolveMonthKey(currentKey);
    const consecutiveDay = isConsecutiveDateKey(previousKey, currentKey);
    if (sameMonth && consecutiveDay) {
      chunkDateKeys.push(currentKey);
      previousKey = currentKey;
      continue;
    }
    chunks.push({
      startKey: chunkStartKey,
      endKey: previousKey,
      dateKeys: chunkDateKeys,
    });
    chunkStartKey = currentKey;
    previousKey = currentKey;
    chunkDateKeys = [currentKey];
  }
  chunks.push({
    startKey: chunkStartKey,
    endKey: previousKey,
    dateKeys: chunkDateKeys,
  });
  return chunks;
}
/**
 * 判断两个日期键是否为相邻自然日。
 */
function isConsecutiveDateKey(previousKey: string, currentKey: string): boolean {
  const previousDayStartMs = resolveHKDayStartUtcMs(previousKey);
  const currentDayStartMs = resolveHKDayStartUtcMs(currentKey);
  if (previousDayStartMs === null || currentDayStartMs === null) {
    return false;
  }
  return currentDayStartMs - previousDayStartMs === TIME.MILLISECONDS_PER_DAY;
}
/**
 * 获取日期键的 YYYY-MM 月键。
 */
function resolveMonthKey(dayKey: string): string {
  return dayKey.slice(0, 7);
}
/**
 * 将港股日期键转换为对应港股日 00:00 的 Date（UTC）。
 */
function resolveDateFromHKDateKey(dayKey: string): Date {
  const dayStartUtcMs = resolveHKDayStartUtcMs(dayKey);
  if (dayStartUtcMs === null) {
    throw createTradingCalendarPrewarmError({
      code: 'TRADING_CALENDAR_INVALID_DATE_KEY',
      message: `[交易日历快照] 无法解析日期键: ${dayKey}`,
      details: { dateKey: dayKey },
    });
  }
  return new Date(dayStartUtcMs);
}
