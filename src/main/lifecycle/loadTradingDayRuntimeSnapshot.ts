/**
 * 交易日运行时快照加载模块
 *
 * 核心职责：
 * - 加载交易日所需的完整运行时快照，为开盘重建提供数据基础
 *
 * 加载流程（按顺序执行）：
 * 1. 验证交易日信息（可选）
 * 2. 刷新账户和持仓数据
 * 3. 获取全量订单并初始化日内亏损追踪
 * 4. 解析席位绑定（prepareSeatsOnStartup）
 * 5. 从交易日志水合冷却状态（可选）
 * 6. 重置行情订阅（可选）
 * 7. 收集并订阅所有交易标的的行情和 K 线
 * 8. 返回全量订单和行情快照，供后续重建使用
 *
 * 使用场景：
 * - 程序启动时的首次初始化
 * - 开盘重建流程中由 globalStateDomain 调用
 */
import { TRADING } from '../../constants/index.js';
import { formatError } from '../../utils/helpers/index.js';
import { refreshAccountAndPositions } from '../../utils/helpers/accountDisplay.js';
import {
  getHKDateKey,
  getTradingMinutesSinceOpen,
  isWithinMorningOpenProtection,
  listHKDateKeysBetween,
} from '../../utils/helpers/tradingTime.js';
import { collectRuntimeQuoteSymbols } from '../../utils/helpers/quoteHelpers.js';
import { logger } from '../../utils/logger/index.js';
import { prepareSeatsOnStartup } from '../startup/seat.js';
import type { RawOrderFromAPI, TradingDayInfo } from '../../types/services.js';
import type {
  LoadTradingDayRuntimeSnapshotDeps,
  LoadTradingDayRuntimeSnapshotParams,
  LoadTradingDayRuntimeSnapshotResult,
} from './types.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const HK_TIMEZONE_OFFSET_MS = 8 * 60 * 60 * 1000;
const CALENDAR_PREWARM_LOOKAHEAD_DAYS = 7;
const CALENDAR_PREWARM_FALLBACK_LOOKBACK_DAYS = 14;
const CALENDAR_PREWARM_QUERY_CHUNK_DAYS = 180;
const HK_DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 解析全量订单中的最早时间戳（submittedAt/updatedAt），用于交易日历预热起点。
 */
function resolveEarliestOrderTimeMs(allOrders: ReadonlyArray<RawOrderFromAPI>): number | null {
  let earliestMs: number | null = null;

  for (const order of allOrders) {
    const submittedMs = order.submittedAt?.getTime();
    if (submittedMs !== undefined && Number.isFinite(submittedMs)) {
      if (earliestMs === null || submittedMs < earliestMs) {
        earliestMs = submittedMs;
      }
    }

    const updatedMs = order.updatedAt?.getTime();
    if (updatedMs !== undefined && Number.isFinite(updatedMs)) {
      if (earliestMs === null || updatedMs < earliestMs) {
        earliestMs = updatedMs;
      }
    }
  }

  return earliestMs;
}

/**
 * 将港股日期键（YYYY-MM-DD）转换为对应港股日 00:00 的 Date。
 */
function resolveDateFromHKDateKey(dayKey: string): Date | null {
  const match = HK_DATE_KEY_PATTERN.exec(dayKey);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  const utcMs = Date.UTC(year, month - 1, day) - HK_TIMEZONE_OFFSET_MS;
  if (!Number.isFinite(utcMs)) {
    return null;
  }
  return new Date(utcMs);
}

/**
 * 将日期键按固定大小切分为查询批次，避免单次区间过大。
 */
function splitDateKeysByChunk(
  dateKeys: ReadonlyArray<string>,
  chunkSize: number,
): ReadonlyArray<ReadonlyArray<string>> {
  if (dateKeys.length === 0 || chunkSize <= 0) {
    return [];
  }

  const chunks: Array<ReadonlyArray<string>> = [];
  for (let index = 0; index < dateKeys.length; index += chunkSize) {
    chunks.push(dateKeys.slice(index, index + chunkSize));
  }
  return chunks;
}

/**
 * 使用批量交易日历接口预热快照（分批查询），保证长区间历史也能完整覆盖。
 */
async function hydrateSnapshotByBatchTradingDays({
  marketDataClient,
  dateKeys,
  nextSnapshot,
}: {
  marketDataClient: LoadTradingDayRuntimeSnapshotDeps['marketDataClient'];
  dateKeys: ReadonlyArray<string>;
  nextSnapshot: Map<string, TradingDayInfo>;
}): Promise<void> {
  const getTradingDays = marketDataClient.getTradingDays;
  if (!getTradingDays || dateKeys.length === 0) {
    return;
  }

  const chunks = splitDateKeysByChunk(dateKeys, CALENDAR_PREWARM_QUERY_CHUNK_DAYS);
  for (const chunkKeys of chunks) {
    const firstKey = chunkKeys[0];
    const lastKey = chunkKeys[chunkKeys.length - 1];
    if (!firstKey || !lastKey) {
      continue;
    }

    const startDate = resolveDateFromHKDateKey(firstKey);
    const endDate = resolveDateFromHKDateKey(lastKey);
    if (!startDate || !endDate) {
      continue;
    }

    const result = await getTradingDays(startDate, endDate);
    const tradingSet = new Set(result.tradingDays);
    const halfDaySet = new Set(result.halfTradingDays);

    for (const dateKey of chunkKeys) {
      const isHalfDay = halfDaySet.has(dateKey);
      const isTradingDay = tradingSet.has(dateKey) || isHalfDay;
      nextSnapshot.set(dateKey, { isTradingDay, isHalfDay });
    }
  }
}

/**
 * 批量接口不可用时回退到逐日查询，保证语义正确性。
 */
async function hydrateSnapshotByDailyTradingDay({
  marketDataClient,
  dateKeys,
  nextSnapshot,
}: {
  marketDataClient: LoadTradingDayRuntimeSnapshotDeps['marketDataClient'];
  dateKeys: ReadonlyArray<string>;
  nextSnapshot: Map<string, TradingDayInfo>;
}): Promise<void> {
  for (const dateKey of dateKeys) {
    const date = resolveDateFromHKDateKey(dateKey);
    if (!date) {
      continue;
    }
    const dayInfo = await marketDataClient.isTradingDay(date);
    nextSnapshot.set(dateKey, dayInfo);
  }
}

/**
 * 在生命周期阶段预热交易日历快照，卖出热路径仅读取本地快照，不发起临时网络请求。
 */
async function prewarmTradingCalendarSnapshot({
  marketDataClient,
  lastState,
  now,
  allOrders,
}: {
  marketDataClient: LoadTradingDayRuntimeSnapshotDeps['marketDataClient'];
  lastState: LoadTradingDayRuntimeSnapshotDeps['lastState'];
  now: Date;
  allOrders: ReadonlyArray<RawOrderFromAPI>;
}): Promise<void> {
  const nowMs = now.getTime();
  const earliestOrderMs = resolveEarliestOrderTimeMs(allOrders);
  const fallbackStartMs = nowMs - CALENDAR_PREWARM_FALLBACK_LOOKBACK_DAYS * MS_PER_DAY;
  const startMs = earliestOrderMs ?? fallbackStartMs;
  const endMs = nowMs + CALENDAR_PREWARM_LOOKAHEAD_DAYS * MS_PER_DAY;

  const dateKeys = listHKDateKeysBetween(startMs, endMs);
  if (dateKeys.length === 0) {
    return;
  }

  const nextSnapshot = new Map<string, TradingDayInfo>(lastState.tradingCalendarSnapshot ?? []);
  const missingDateKeys = dateKeys.filter((dateKey) => !nextSnapshot.has(dateKey));

  if (missingDateKeys.length > 0) {
    if (marketDataClient.getTradingDays) {
      await hydrateSnapshotByBatchTradingDays({
        marketDataClient,
        dateKeys: missingDateKeys,
        nextSnapshot,
      });
    } else {
      await hydrateSnapshotByDailyTradingDay({
        marketDataClient,
        dateKeys: missingDateKeys,
        nextSnapshot,
      });
    }
  }

  const nowDateKey = getHKDateKey(now);
  if (nowDateKey && lastState.cachedTradingDayInfo) {
    nextSnapshot.set(nowDateKey, lastState.cachedTradingDayInfo);
  }

  lastState.tradingCalendarSnapshot = nextSnapshot;
}

/**
 * 创建交易日运行时快照加载函数（工厂）。
 * 注入依赖后返回 loadTradingDayRuntimeSnapshot，用于启动初始化与开盘重建时加载账户、持仓、订单、席位与行情快照。
 *
 * @param deps 依赖注入（marketDataClient、trader、lastState、tradingConfig、symbolRegistry、dailyLossTracker、tradeLogHydrator、warrantListCacheConfig）
 * @returns 接收 LoadTradingDayRuntimeSnapshotParams 的异步函数，返回全量订单与行情快照供重建使用
 */
export function createLoadTradingDayRuntimeSnapshot(
  deps: LoadTradingDayRuntimeSnapshotDeps,
): (params: LoadTradingDayRuntimeSnapshotParams) => Promise<LoadTradingDayRuntimeSnapshotResult> {
  const {
    marketDataClient,
    trader,
    lastState,
    tradingConfig,
    symbolRegistry,
    dailyLossTracker,
    tradeLogHydrator,
    warrantListCacheConfig,
  } = deps;

  /**
   * 加载交易日完整运行时快照：验证交易日 → 刷新账户持仓 → 获取全量订单
   * → 解析席位 → 水合冷却状态 → 重置行情订阅 → 订阅标的行情和 K 线 → 返回快照。
   */
  return async function loadTradingDayRuntimeSnapshot(
    params: LoadTradingDayRuntimeSnapshotParams,
  ): Promise<LoadTradingDayRuntimeSnapshotResult> {
    const {
      now,
      requireTradingDay,
      failOnOrderFetchError,
      resetRuntimeSubscriptions,
      hydrateCooldownFromTradeLog,
      forceOrderRefresh,
    } = params;

    if (requireTradingDay) {
      const tradingDayInfo = await marketDataClient.isTradingDay(now);
      if (!tradingDayInfo.isTradingDay) {
        throw new Error('重建触发时交易日信息无效');
      }
      lastState.cachedTradingDayInfo = tradingDayInfo;
      lastState.isHalfDay = tradingDayInfo.isHalfDay;
    }

    await refreshAccountAndPositions(trader, lastState);
    if (!lastState.cachedAccount) {
      throw new Error('无法获取账户信息');
    }
    if (!Array.isArray(lastState.cachedPositions)) {
      throw new TypeError('无法获取持仓信息');
    }

    logger.info('账户和持仓信息获取成功，开始解析席位');

    let allOrders: ReadonlyArray<RawOrderFromAPI> = [];
    try {
      allOrders = await trader.fetchAllOrdersFromAPI(forceOrderRefresh);
    } catch (err) {
      if (failOnOrderFetchError) {
        throw new Error(`[全量订单获取失败] ${formatError(err)}`, { cause: err });
      }
      logger.warn('[全量订单获取失败] 将按空订单继续初始化', formatError(err));
    }

    trader.seedOrderHoldSymbols(allOrders);
    dailyLossTracker.recalculateFromAllOrders(allOrders, tradingConfig.monitors, now);
    try {
      await prewarmTradingCalendarSnapshot({
        marketDataClient,
        lastState,
        now,
        allOrders,
      });
    } catch (err) {
      logger.warn('[交易日历快照] 预热失败，将沿用当前快照并等待下一次重建', formatError(err));
    }

    const seatResult = await prepareSeatsOnStartup({
      tradingConfig,
      symbolRegistry,
      positions: lastState.cachedPositions,
      orders: allOrders,
      marketDataClient,
      now: () => new Date(),
      logger,
      getTradingMinutesSinceOpen,
      isWithinMorningOpenProtection,
      warrantListCacheConfig,
    });

    if (hydrateCooldownFromTradeLog) {
      tradeLogHydrator.hydrate({ seatSymbols: seatResult.seatSymbols });
    }

    if (resetRuntimeSubscriptions) {
      await marketDataClient.resetRuntimeSubscriptionsAndCaches();
    }

    const orderHoldSymbols = trader.getOrderHoldSymbols();
    const allTradingSymbols = collectRuntimeQuoteSymbols(
      tradingConfig.monitors,
      symbolRegistry,
      lastState.cachedPositions,
      orderHoldSymbols,
    );
    lastState.allTradingSymbols = allTradingSymbols;
    if (allTradingSymbols.size > 0) {
      await marketDataClient.subscribeSymbols(Array.from(allTradingSymbols));
    }

    for (const monitorConfig of tradingConfig.monitors) {
      await marketDataClient.subscribeCandlesticks(
        monitorConfig.monitorSymbol,
        TRADING.CANDLE_PERIOD,
      );
    }

    const quotesMap = await marketDataClient.getQuotes(allTradingSymbols);
    return {
      allOrders,
      quotesMap,
    };
  };
}
