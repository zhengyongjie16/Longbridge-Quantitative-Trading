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
import { AUTO_SYMBOL_SEARCH_COOLDOWN_MS, TRADING } from '../../constants/index.js';
import { formatError, sleep } from '../../utils/helpers/index.js';
import { refreshAccountAndPositions } from '../../utils/helpers/accountDisplay.js';
import { getTradingMinutesSinceOpen, isWithinMorningOpenProtection } from '../../utils/helpers/tradingTime.js';
import { collectRuntimeQuoteSymbols } from '../../utils/helpers/quoteHelpers.js';
import { logger } from '../../utils/logger/index.js';
import { prepareSeatsOnStartup } from '../startup/seat.js';
import type { RawOrderFromAPI } from '../../types/index.js';
import type {
  LoadTradingDayRuntimeSnapshotDeps,
  LoadTradingDayRuntimeSnapshotParams,
  LoadTradingDayRuntimeSnapshotResult,
} from './types.js';

export function createLoadTradingDayRuntimeSnapshot(
  deps: LoadTradingDayRuntimeSnapshotDeps,
): (
  params: LoadTradingDayRuntimeSnapshotParams,
) => Promise<LoadTradingDayRuntimeSnapshotResult> {
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
      allOrders = await trader._orderRecorder.fetchAllOrdersFromAPI(forceOrderRefresh);
    } catch (err) {
      if (failOnOrderFetchError) {
        throw new Error(`[全量订单获取失败] ${formatError(err)}`);
      }
      logger.warn('[全量订单获取失败] 将按空订单继续初始化', formatError(err));
    }

    trader.seedOrderHoldSymbols(allOrders);
    dailyLossTracker.recalculateFromAllOrders(allOrders, tradingConfig.monitors, now);

    const seatResult = await prepareSeatsOnStartup({
      tradingConfig,
      symbolRegistry,
      positions: lastState.cachedPositions,
      orders: allOrders,
      marketDataClient,
      sleep,
      now: () => new Date(),
      searchCooldownMs: AUTO_SYMBOL_SEARCH_COOLDOWN_MS,
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
