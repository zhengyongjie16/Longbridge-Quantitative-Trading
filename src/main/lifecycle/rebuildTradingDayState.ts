/**
 * 交易日状态重建模块
 *
 * 核心职责：
 * - 在开盘重建阶段，基于最新的行情和订单数据重建所有运行时状态
 *
 * 重建流程（按顺序执行）：
 * 1. 同步所有监控标的的席位快照和行情数据到 MonitorContext
 * 2. 重建订单记录（从全量订单 API 数据中恢复）
 * 3. 预热交易日历快照（基于仍持仓订单需求窗口）
 * 4. 重建牛熊证风险缓存（收回价等关键风控数据）
 * 5. 重建浮亏缓存（结合当日已实现亏损偏移量）
 * 6. 恢复订单追踪状态
 * 7. 展示账户和持仓信息
 *
 * 错误处理：
 * - 任一步骤失败即整体抛出，由生命周期管理器负责重试
 */
import { hasSeatSymbol } from '../../services/autoSymbolManager/utils.js';
import type { MonitorContext } from '../../types/state.js';
import type { Quote } from '../../types/quote.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { MarketDataClient, RawOrderFromAPI } from '../../types/services.js';
import type { DailyLossTracker } from '../../types/risk.js';
import { resolveMonitorContextRuntimeSnapshot } from '../../utils/utils.js';
import type { RebuildTradingDayStateDeps, RebuildTradingDayStateParams } from './types.js';
import { prewarmTradingCalendarSnapshotForRebuild } from './tradingCalendarPrewarmer.js';
import { formatError } from '../../utils/error/index.js';

/**
 * 将席位状态和行情数据同步到单个 MonitorContext。
 * 为什么必须在订单重建前执行：后续订单重建、风控缓存重建等步骤依赖 symbolRegistry 与各 MonitorContext 中的最新席位与行情，若延后执行会导致恢复状态基于过旧数据。
 *
 * @param monitorContext 待同步的监控上下文
 * @param symbolRegistry 席位注册表（取席位状态与版本）
 * @param quotesMap 标的 -> 行情 Map
 * @returns 无返回值
 */
function syncMonitorContextQuotes(
  monitorContext: MonitorContext,
  symbolRegistry: SymbolRegistry,
  quotesMap: ReadonlyMap<string, Quote | null>,
): void {
  const runtimeSnapshot = resolveMonitorContextRuntimeSnapshot(
    monitorContext.config.monitorSymbol,
    symbolRegistry,
    quotesMap,
  );
  monitorContext.seatState = runtimeSnapshot.seatState;
  monitorContext.seatVersion = runtimeSnapshot.seatVersion;
  monitorContext.longSymbolName = runtimeSnapshot.longSymbolName;
  monitorContext.shortSymbolName = runtimeSnapshot.shortSymbolName;
  monitorContext.monitorSymbolName = runtimeSnapshot.monitorSymbolName;
}

/**
 * 遍历所有监控标的，将席位状态和行情数据同步到各自的 MonitorContext。
 */
function syncAllMonitorContexts(
  monitorContexts: ReadonlyMap<string, MonitorContext>,
  symbolRegistry: SymbolRegistry,
  quotesMap: ReadonlyMap<string, Quote | null>,
): void {
  for (const monitorContext of monitorContexts.values()) {
    syncMonitorContextQuotes(monitorContext, symbolRegistry, quotesMap);
  }
}

/**
 * 从全量订单数据中重建所有已绑定席位的订单记录。
 */
async function rebuildOrderRecords(
  monitorContexts: ReadonlyMap<string, MonitorContext>,
  allOrders: ReadonlyArray<RawOrderFromAPI>,
  quotesMap: ReadonlyMap<string, Quote | null>,
): Promise<void> {
  for (const monitorContext of monitorContexts.values()) {
    const monitorSymbol = monitorContext.config.monitorSymbol;
    const longSeatState = monitorContext.symbolRegistry.getSeatState(monitorSymbol, 'LONG');
    const shortSeatState = monitorContext.symbolRegistry.getSeatState(monitorSymbol, 'SHORT');
    if (hasSeatSymbol(longSeatState)) {
      await monitorContext.orderRecorder.refreshOrdersFromAllOrdersForLong(
        longSeatState.symbol,
        allOrders,
        quotesMap.get(longSeatState.symbol) ?? null,
      );
    }

    if (hasSeatSymbol(shortSeatState)) {
      await monitorContext.orderRecorder.refreshOrdersFromAllOrdersForShort(
        shortSeatState.symbol,
        allOrders,
        quotesMap.get(shortSeatState.symbol) ?? null,
      );
    }
  }
}

/**
 * 刷新单个席位的牛熊证风险信息（收回价等）。
 * 优先使用席位缓存的 callPrice，否则从 API 重新拉取。
 */
async function refreshSeatWarrantInfo(
  marketDataClient: MarketDataClient,
  monitorContext: MonitorContext,
  symbol: string | null,
  quote: Quote | null,
  isLongSymbol: boolean,
  callPriceFromSeat: number | null,
): Promise<void> {
  if (!symbol) {
    return;
  }

  const symbolName = quote?.name ?? null;
  if (callPriceFromSeat !== null && Number.isFinite(callPriceFromSeat) && callPriceFromSeat > 0) {
    const result = monitorContext.riskChecker.setWarrantInfoFromCallPrice(
      symbol,
      callPriceFromSeat,
      isLongSymbol,
      symbolName,
    );
    if (result.status === 'error') {
      throw new Error(result.reason);
    }

    return;
  }

  const result = await monitorContext.riskChecker.refreshWarrantInfoForSymbol(
    marketDataClient,
    symbol,
    isLongSymbol,
    symbolName,
  );
  if (result.status === 'error' || result.status === 'skipped') {
    const reason = result.status === 'error' ? result.reason : '未提供行情客户端';
    throw new Error(reason);
  }
}

/**
 * 重建所有已绑定席位的牛熊证风险缓存（收回价等关键风控数据）。
 */
async function rebuildWarrantRiskCache(
  marketDataClient: MarketDataClient,
  monitorContexts: ReadonlyMap<string, MonitorContext>,
  quotesMap: ReadonlyMap<string, Quote | null>,
): Promise<void> {
  for (const monitorContext of monitorContexts.values()) {
    const monitorSymbol = monitorContext.config.monitorSymbol;
    const longSeatState = monitorContext.symbolRegistry.getSeatState(monitorSymbol, 'LONG');
    const shortSeatState = monitorContext.symbolRegistry.getSeatState(monitorSymbol, 'SHORT');
    await refreshSeatWarrantInfo(
      marketDataClient,
      monitorContext,
      hasSeatSymbol(longSeatState) ? longSeatState.symbol : null,
      hasSeatSymbol(longSeatState) ? (quotesMap.get(longSeatState.symbol) ?? null) : null,
      true,
      hasSeatSymbol(longSeatState) ? (longSeatState.callPrice ?? null) : null,
    );

    await refreshSeatWarrantInfo(
      marketDataClient,
      monitorContext,
      hasSeatSymbol(shortSeatState) ? shortSeatState.symbol : null,
      hasSeatSymbol(shortSeatState) ? (quotesMap.get(shortSeatState.symbol) ?? null) : null,
      false,
      hasSeatSymbol(shortSeatState) ? (shortSeatState.callPrice ?? null) : null,
    );
  }
}

/**
 * 重建所有已绑定席位的浮亏缓存，结合当日已实现亏损偏移量计算。
 */
async function rebuildUnrealizedLossCache(
  monitorContexts: ReadonlyMap<string, MonitorContext>,
  dailyLossTracker: DailyLossTracker,
  quotesMap: ReadonlyMap<string, Quote | null>,
): Promise<void> {
  for (const monitorContext of monitorContexts.values()) {
    const monitorSymbol = monitorContext.config.monitorSymbol;
    const longSeatState = monitorContext.symbolRegistry.getSeatState(monitorSymbol, 'LONG');
    const shortSeatState = monitorContext.symbolRegistry.getSeatState(monitorSymbol, 'SHORT');
    if (hasSeatSymbol(longSeatState)) {
      const dailyLossOffset = dailyLossTracker.getLossOffset(monitorSymbol, true);
      await monitorContext.riskChecker.refreshUnrealizedLossData(
        monitorContext.orderRecorder,
        longSeatState.symbol,
        true,
        quotesMap.get(longSeatState.symbol) ?? null,
        dailyLossOffset,
      );
    }

    if (hasSeatSymbol(shortSeatState)) {
      const dailyLossOffset = dailyLossTracker.getLossOffset(monitorSymbol, false);
      await monitorContext.riskChecker.refreshUnrealizedLossData(
        monitorContext.orderRecorder,
        shortSeatState.symbol,
        false,
        quotesMap.get(shortSeatState.symbol) ?? null,
        dailyLossOffset,
      );
    }
  }
}

/**
 * 在重建完成后，将已完成 admission 与缓存初始化的 seat 统一推进到 ACTIVE。
 */
function activateRebuiltSeats(monitorContexts: ReadonlyMap<string, MonitorContext>, nowMs: number): void {
  for (const monitorContext of monitorContexts.values()) {
    const monitorSymbol = monitorContext.config.monitorSymbol;
    for (const direction of ['LONG', 'SHORT'] as const) {
      const seatState = monitorContext.symbolRegistry.getSeatState(monitorSymbol, direction);
      if (!hasSeatSymbol(seatState)) {
        continue;
      }

      monitorContext.symbolRegistry.updateSeatState(monitorSymbol, direction, {
        ...seatState,
        status: 'ACTIVE',
        lastSeatActivatedAt: nowMs,
      });
    }
  }
}

/**
 * 创建交易日状态重建函数（工厂）。
 * 注入依赖后返回 rebuildTradingDayState，在开盘重建阶段基于全量订单与行情快照同步席位、重建订单与风控缓存并展示账户持仓。
 *
 * @param deps 依赖注入（marketDataClient、trader、lastState、symbolRegistry、monitorContexts、dailyLossTracker、displayAccountAndPositions）
 * @returns 接收 RebuildTradingDayStateParams 的异步函数，无返回值；任一步骤失败即抛出，由生命周期管理器重试
 */
export function createRebuildTradingDayState(
  deps: RebuildTradingDayStateDeps,
): (params: RebuildTradingDayStateParams) => Promise<void> {
  const {
    marketDataClient,
    trader,
    lastState,
    symbolRegistry,
    monitorContexts,
    dailyLossTracker,
    displayAccountAndPositions,
  } = deps;

  /**
   * 重建交易日运行时状态：同步席位/行情 → 重建订单记录 → 预热交易日历
   * → 重建风险缓存 → 重建浮亏缓存 → 恢复订单追踪 → 展示账户持仓。
   * 任一步骤失败即整体抛出，由生命周期管理器负责重试。
   */
  return async function rebuildTradingDayState(
    params: RebuildTradingDayStateParams,
  ): Promise<void> {
    const { allOrders, quotesMap, now = new Date() } = params;
    syncAllMonitorContexts(monitorContexts, symbolRegistry, quotesMap);
    try {
      await rebuildOrderRecords(monitorContexts, allOrders, quotesMap);
      await prewarmTradingCalendarSnapshotForRebuild({
        marketDataClient,
        lastState,
        monitorContexts,
        now,
      });
      await rebuildWarrantRiskCache(marketDataClient, monitorContexts, quotesMap);
      await rebuildUnrealizedLossCache(monitorContexts, dailyLossTracker, quotesMap);
      activateRebuiltSeats(monitorContexts, now.getTime());
      syncAllMonitorContexts(monitorContexts, symbolRegistry, quotesMap);
      await trader.recoverOrderTrackingFromSnapshot(allOrders);
      await displayAccountAndPositions({ lastState, quotesMap });
    } catch (err) {
      throw new Error(`[Lifecycle] 重建交易日状态失败: ${formatError(err)}`, { cause: err });
    }
  };
}
