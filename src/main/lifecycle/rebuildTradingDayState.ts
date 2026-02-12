/**
 * 交易日状态重建模块
 *
 * 核心职责：
 * - 在开盘重建阶段，基于最新的行情和订单数据重建所有运行时状态
 *
 * 重建流程（按顺序执行）：
 * 1. 同步所有监控标的的席位快照和行情数据到 MonitorContext
 * 2. 重建订单记录（从全量订单 API 数据中恢复）
 * 3. 重建牛熊证风险缓存（收回价等关键风控数据）
 * 4. 重建浮亏缓存（结合当日已实现亏损偏移量）
 * 5. 恢复订单追踪状态
 * 6. 展示账户和持仓信息
 *
 * 错误处理：
 * - 任一步骤失败即整体抛出，由生命周期管理器负责重试
 */
import { formatError } from '../../utils/helpers/index.js';
import { isSeatReady } from '../../services/autoSymbolManager/utils.js';
import type { MonitorContext } from '../../types/state.js';
import type { Quote } from '../../types/quote.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { MarketDataClient, RawOrderFromAPI } from '../../types/services.js';
import type { DailyLossTracker } from '../../core/riskController/types.js';
import type { RebuildTradingDayStateDeps, RebuildTradingDayStateParams } from './types.js';

function syncMonitorContextQuotes(
  monitorContext: MonitorContext,
  symbolRegistry: SymbolRegistry,
  quotesMap: ReadonlyMap<string, Quote | null>,
): void {
  const monitorSymbol = monitorContext.config.monitorSymbol;
  const longSeatState = symbolRegistry.getSeatState(monitorSymbol, 'LONG');
  const shortSeatState = symbolRegistry.getSeatState(monitorSymbol, 'SHORT');
  const longSeatVersion = symbolRegistry.getSeatVersion(monitorSymbol, 'LONG');
  const shortSeatVersion = symbolRegistry.getSeatVersion(monitorSymbol, 'SHORT');

  monitorContext.seatState = {
    long: longSeatState,
    short: shortSeatState,
  };
  monitorContext.seatVersion = {
    long: longSeatVersion,
    short: shortSeatVersion,
  };

  const longSymbol = isSeatReady(longSeatState) ? longSeatState.symbol : null;
  const shortSymbol = isSeatReady(shortSeatState) ? shortSeatState.symbol : null;
  const longQuote = longSymbol ? (quotesMap.get(longSymbol) ?? null) : null;
  const shortQuote = shortSymbol ? (quotesMap.get(shortSymbol) ?? null) : null;
  const monitorQuote = quotesMap.get(monitorSymbol) ?? null;

  monitorContext.longQuote = longQuote;
  monitorContext.shortQuote = shortQuote;
  monitorContext.monitorQuote = monitorQuote;

  if (longSymbol) {
    monitorContext.longSymbolName = longQuote?.name ?? longSymbol;
  } else {
    monitorContext.longSymbolName = '';
  }
  if (shortSymbol) {
    monitorContext.shortSymbolName = shortQuote?.name ?? shortSymbol;
  } else {
    monitorContext.shortSymbolName = '';
  }
  monitorContext.monitorSymbolName = monitorQuote?.name ?? monitorSymbol;
}

function syncAllMonitorContexts(
  monitorContexts: ReadonlyMap<string, MonitorContext>,
  symbolRegistry: SymbolRegistry,
  quotesMap: ReadonlyMap<string, Quote | null>,
): void {
  for (const monitorContext of monitorContexts.values()) {
    syncMonitorContextQuotes(monitorContext, symbolRegistry, quotesMap);
  }
}

async function rebuildOrderRecords(
  monitorContexts: ReadonlyMap<string, MonitorContext>,
  allOrders: ReadonlyArray<RawOrderFromAPI>,
): Promise<void> {
  for (const monitorContext of monitorContexts.values()) {
    const monitorSymbol = monitorContext.config.monitorSymbol;
    const longSeatState = monitorContext.symbolRegistry.getSeatState(monitorSymbol, 'LONG');
    const shortSeatState = monitorContext.symbolRegistry.getSeatState(monitorSymbol, 'SHORT');

    if (isSeatReady(longSeatState)) {
      await monitorContext.orderRecorder.refreshOrdersFromAllOrdersForLong(
        longSeatState.symbol,
        allOrders,
        monitorContext.longQuote,
      );
    }
    if (isSeatReady(shortSeatState)) {
      await monitorContext.orderRecorder.refreshOrdersFromAllOrdersForShort(
        shortSeatState.symbol,
        allOrders,
        monitorContext.shortQuote,
      );
    }
  }
}

async function refreshSeatWarrantInfo(
  marketDataClient: MarketDataClient,
  monitorContext: MonitorContext,
  symbol: string | null,
  isLongSymbol: boolean,
  callPriceFromSeat: number | null,
): Promise<void> {
  if (!symbol) {
    return;
  }

  const quote = isLongSymbol ? monitorContext.longQuote : monitorContext.shortQuote;
  const symbolName = quote?.name ?? null;
  if (callPriceFromSeat != null && Number.isFinite(callPriceFromSeat) && callPriceFromSeat > 0) {
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

async function rebuildWarrantRiskCache(
  marketDataClient: MarketDataClient,
  monitorContexts: ReadonlyMap<string, MonitorContext>,
): Promise<void> {
  for (const monitorContext of monitorContexts.values()) {
    const monitorSymbol = monitorContext.config.monitorSymbol;
    const longSeatState = monitorContext.symbolRegistry.getSeatState(monitorSymbol, 'LONG');
    const shortSeatState = monitorContext.symbolRegistry.getSeatState(monitorSymbol, 'SHORT');

    await refreshSeatWarrantInfo(
      marketDataClient,
      monitorContext,
      isSeatReady(longSeatState) ? longSeatState.symbol : null,
      true,
      isSeatReady(longSeatState) ? (longSeatState.callPrice ?? null) : null,
    );
    await refreshSeatWarrantInfo(
      marketDataClient,
      monitorContext,
      isSeatReady(shortSeatState) ? shortSeatState.symbol : null,
      false,
      isSeatReady(shortSeatState) ? (shortSeatState.callPrice ?? null) : null,
    );
  }
}

async function rebuildUnrealizedLossCache(
  monitorContexts: ReadonlyMap<string, MonitorContext>,
  dailyLossTracker: DailyLossTracker,
): Promise<void> {
  for (const monitorContext of monitorContexts.values()) {
    const monitorSymbol = monitorContext.config.monitorSymbol;
    const maxUnrealizedLoss = monitorContext.config.maxUnrealizedLossPerSymbol ?? 0;
    if (maxUnrealizedLoss <= 0) {
      continue;
    }

    const longSeatState = monitorContext.symbolRegistry.getSeatState(monitorSymbol, 'LONG');
    const shortSeatState = monitorContext.symbolRegistry.getSeatState(monitorSymbol, 'SHORT');

    if (isSeatReady(longSeatState)) {
      const dailyLossOffset = dailyLossTracker.getLossOffset(monitorSymbol, true);
      await monitorContext.riskChecker.refreshUnrealizedLossData(
        monitorContext.orderRecorder,
        longSeatState.symbol,
        true,
        monitorContext.longQuote,
        dailyLossOffset,
      );
    }
    if (isSeatReady(shortSeatState)) {
      const dailyLossOffset = dailyLossTracker.getLossOffset(monitorSymbol, false);
      await monitorContext.riskChecker.refreshUnrealizedLossData(
        monitorContext.orderRecorder,
        shortSeatState.symbol,
        false,
        monitorContext.shortQuote,
        dailyLossOffset,
      );
    }
  }
}

export function createRebuildTradingDayState(deps: RebuildTradingDayStateDeps): (
  params: RebuildTradingDayStateParams,
) => Promise<void> {
  const {
    marketDataClient,
    trader,
    lastState,
    symbolRegistry,
    monitorContexts,
    dailyLossTracker,
    displayAccountAndPositions,
  } = deps;

  return async function rebuildTradingDayState(params: RebuildTradingDayStateParams): Promise<void> {
    const { allOrders, quotesMap } = params;

    syncAllMonitorContexts(monitorContexts, symbolRegistry, quotesMap);

    try {
      await rebuildOrderRecords(monitorContexts, allOrders);
      await rebuildWarrantRiskCache(marketDataClient, monitorContexts);
      await rebuildUnrealizedLossCache(monitorContexts, dailyLossTracker);
      await trader._recoverOrderTracking();
      await displayAccountAndPositions({ lastState, quotesMap });
    } catch (err) {
      throw new Error(`[Lifecycle] 重建交易日状态失败: ${formatError(err)}`, { cause: err });
    }
  };
}
