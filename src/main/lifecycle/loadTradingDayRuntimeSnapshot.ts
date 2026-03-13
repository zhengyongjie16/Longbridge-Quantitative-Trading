/**
 * 交易日运行时快照加载模块
 *
 * 核心职责：
 * - 加载交易日所需的完整运行时快照，为开盘重建提供数据基础
 *
 * 加载流程（按顺序执行）：
 * 1. 验证交易日信息（可选）
 * 2. 初始化订单监控订阅（进入 BOOTSTRAPPING）
 * 3. 刷新账户和持仓数据
 * 4. 获取全量订单并解析席位绑定（prepareSeatsForRuntime）
 * 5. 从交易日志水合冷却状态，并基于订单/持仓恢复保护性清仓边界（可选）
 * 6. 基于保护性清仓边界回算日内亏损追踪
 * 7. 重置行情订阅（可选）
 * 8. 收集并订阅所有交易标的的行情和 K 线
 * 9. 返回全量订单和行情快照，供后续重建使用
 *
 * 使用场景：
 * - 程序启动时的首次初始化
 * - 开盘重建流程中由 globalStateDomain 调用
 */
import { OrderSide } from 'longbridge';
import { PENDING_ORDER_STATUSES, TRADING } from '../../constants/index.js';
import {
  getHKDateKey,
  getTradingMinutesSinceOpen,
  isWithinMorningOpenProtection,
} from '../../utils/time/index.js';
import { logger } from '../../utils/logger/index.js';
import { prepareSeatsForRuntime } from '../recovery/seatPreparation.js';
import { collectRuntimeQuoteSymbols, refreshAccountAndPositions } from '../utils.js';
import type { RawOrderFromAPI } from '../../types/services.js';
import { formatError } from '../../utils/error/index.js';
import { decimalToNumber, isValidPositiveNumber } from '../../utils/helpers/index.js';
import { resolveOrderOwnership } from '../../core/orderRecorder/orderOwnershipParser.js';
import { hasProtectiveLiquidationRemark } from '../../core/trader/utils.js';
import { buildCooldownKey } from '../../services/liquidationCooldown/utils.js';
import { isSeatReady } from '../../services/autoSymbolManager/utils.js';
import type {
  LoadTradingDayRuntimeSnapshotDeps,
  LoadTradingDayRuntimeSnapshotParams,
  LoadTradingDayRuntimeSnapshotResult,
} from './types.js';
import type { ProtectiveLiquidationDirection } from '../../core/trader/protectiveLiquidationEpisodeTracker/types.js';

function resolveDirectionFromKey(
  key: string,
): { monitorSymbol: string; direction: ProtectiveLiquidationDirection } | null {
  const separatorIndex = key.lastIndexOf(':');
  if (separatorIndex <= 0 || separatorIndex >= key.length - 1) {
    return null;
  }

  const monitorSymbol = key.slice(0, separatorIndex);
  const directionText = key.slice(separatorIndex + 1);
  if (directionText !== 'LONG' && directionText !== 'SHORT') {
    return null;
  }

  return {
    monitorSymbol,
    direction: directionText,
  };
}

function isDirectionFlatAtSnapshot(
  symbolRegistry: LoadTradingDayRuntimeSnapshotDeps['symbolRegistry'],
  lastState: LoadTradingDayRuntimeSnapshotDeps['lastState'],
  monitorSymbol: string,
  direction: ProtectiveLiquidationDirection,
): boolean {
  const seatState = symbolRegistry.getSeatState(monitorSymbol, direction);
  if (!isSeatReady(seatState)) {
    return true;
  }

  const position = lastState.positionCache.get(seatState.symbol);
  return position === null || position.quantity <= 0;
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
    protectiveLiquidationEpisodeTracker,
    tradeLogHydrator,
    warrantListCacheConfig,
  } = deps;

  /**
   * 加载交易日完整运行时快照：验证交易日 → 刷新账户持仓 → 获取全量订单
   * → 解析席位 → 水合冷却状态并恢复保护性清仓边界 → 回算日内亏损追踪
   * → 重置行情订阅 → 订阅标的行情和 K 线 → 返回快照。
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

    await trader.initializeOrderMonitor();
    await refreshAccountAndPositions(trader, lastState);
    if (!lastState.cachedAccount) {
      throw new Error('无法获取账户信息');
    }

    if (!Array.isArray(lastState.cachedPositions)) {
      throw new TypeError('无法获取持仓信息');
    }

    logger.debug('账户和持仓信息获取成功，开始解析席位');
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
    await prepareSeatsForRuntime({
      tradingConfig,
      symbolRegistry,
      positions: lastState.cachedPositions,
      orders: allOrders,
      marketDataClient,
      now: () => now,
      logger,
      getTradingMinutesSinceOpen,
      isWithinMorningOpenProtection,
      warrantListCacheConfig,
    });
    protectiveLiquidationEpisodeTracker.resetAll();
    const completedBoundaryByDirection = hydrateCooldownFromTradeLog
      ? tradeLogHydrator.hydrate()
      : new Map<string, number>();

    const currentDayKey = getHKDateKey(now);
    const protectiveLatestFillByDirection = new Map<string, number>();
    const pendingProtectiveLatestFillByDirection = new Map<string, number>();
    const pendingProtectiveDirectionKeys = new Set<string>();
    for (const order of allOrders) {
      if (!hasProtectiveLiquidationRemark(order.remark)) {
        continue;
      }

      if (!(order.updatedAt instanceof Date)) {
        continue;
      }

      if (getHKDateKey(order.updatedAt) !== currentDayKey) {
        continue;
      }

      const ownership = resolveOrderOwnership(order, tradingConfig.monitors);
      if (!ownership) {
        continue;
      }

      const directionKey = buildCooldownKey(ownership.monitorSymbol, ownership.direction);
      const executedTimeMs = order.updatedAt.getTime();
      const executedQuantity = decimalToNumber(order.executedQuantity);
      const hasProtectiveExecution =
        order.side === OrderSide.Sell &&
        isValidPositiveNumber(executedTimeMs) &&
        isValidPositiveNumber(executedQuantity);
      if (hasProtectiveExecution) {
        const existing = protectiveLatestFillByDirection.get(directionKey);
        if (existing === undefined || executedTimeMs > existing) {
          protectiveLatestFillByDirection.set(directionKey, executedTimeMs);
        }
      }

      if (PENDING_ORDER_STATUSES.has(order.status)) {
        pendingProtectiveDirectionKeys.add(directionKey);
        if (hasProtectiveExecution) {
          const existingPending = pendingProtectiveLatestFillByDirection.get(directionKey);
          if (existingPending === undefined || executedTimeMs > existingPending) {
            pendingProtectiveLatestFillByDirection.set(directionKey, executedTimeMs);
          }
        }
      }
    }

    const restoredBoundaryByDirection = new Map<string, number>();
    for (const [directionKey, boundaryExecutedTimeMs] of completedBoundaryByDirection) {
      const parsed = resolveDirectionFromKey(directionKey);
      if (!parsed) {
        continue;
      }

      protectiveLiquidationEpisodeTracker.restoreCompletedBoundary({
        monitorSymbol: parsed.monitorSymbol,
        direction: parsed.direction,
        boundaryExecutedTimeMs,
      });
      restoredBoundaryByDirection.set(directionKey, boundaryExecutedTimeMs);
    }

    for (const [directionKey, latestExecutedTimeMs] of protectiveLatestFillByDirection) {
      if (restoredBoundaryByDirection.has(directionKey) || pendingProtectiveDirectionKeys.has(directionKey)) {
        continue;
      }

      const parsed = resolveDirectionFromKey(directionKey);
      if (!parsed) {
        continue;
      }

      const isDirectionFlat = isDirectionFlatAtSnapshot(
        symbolRegistry,
        lastState,
        parsed.monitorSymbol,
        parsed.direction,
      );
      if (!isDirectionFlat) {
        continue;
      }

      protectiveLiquidationEpisodeTracker.restoreCompletedBoundary({
        monitorSymbol: parsed.monitorSymbol,
        direction: parsed.direction,
        boundaryExecutedTimeMs: latestExecutedTimeMs,
      });
      restoredBoundaryByDirection.set(directionKey, latestExecutedTimeMs);
    }

    for (const [directionKey, latestExecutedTimeMs] of protectiveLatestFillByDirection) {
      const parsed = resolveDirectionFromKey(directionKey);
      if (!parsed) {
        continue;
      }

      const boundaryExecutedTimeMs = restoredBoundaryByDirection.get(directionKey);
      const hasPendingProtective = pendingProtectiveDirectionKeys.has(directionKey);
      if (hasPendingProtective) {
        const pendingLatestExecutedTimeMs = pendingProtectiveLatestFillByDirection.get(directionKey);
        if (
          pendingLatestExecutedTimeMs !== undefined &&
          (boundaryExecutedTimeMs === undefined || pendingLatestExecutedTimeMs > boundaryExecutedTimeMs)
        ) {
          protectiveLiquidationEpisodeTracker.restoreInProgressEpisode({
            monitorSymbol: parsed.monitorSymbol,
            direction: parsed.direction,
            latestExecutedTimeMs: pendingLatestExecutedTimeMs,
          });
        }

        continue;
      }

      if (boundaryExecutedTimeMs !== undefined && latestExecutedTimeMs <= boundaryExecutedTimeMs) {
        continue;
      }

      const isDirectionFlat = isDirectionFlatAtSnapshot(
        symbolRegistry,
        lastState,
        parsed.monitorSymbol,
        parsed.direction,
      );
      if (isDirectionFlat) {
        continue;
      }

      protectiveLiquidationEpisodeTracker.restoreInProgressEpisode({
        monitorSymbol: parsed.monitorSymbol,
        direction: parsed.direction,
        latestExecutedTimeMs,
      });
    }

    const protectionBoundaryByDirection =
      protectiveLiquidationEpisodeTracker.getLatestProtectionBoundaryByDirection();
    dailyLossTracker.recalculateFromAllOrders(
      allOrders,
      tradingConfig.monitors,
      now,
      protectionBoundaryByDirection,
    );

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
      await marketDataClient.subscribeSymbols([...allTradingSymbols]);
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
