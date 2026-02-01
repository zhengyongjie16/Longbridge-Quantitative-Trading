import { logger } from '../../../utils/logger/index.js';
import { API } from '../../../constants/index.js';
import { formatError, formatSymbolDisplay } from '../../../utils/helpers/index.js';
import { isSeatReady } from '../../../services/autoSymbolManager/utils.js';

import type { MonitorContext, PendingRefreshSymbol, Quote } from '../../../types/index.js';
import type { PostTradeRefresher, PostTradeRefresherDeps, PostTradeRefresherEnqueueParams } from './types.js';

export function createPostTradeRefresher(
  deps: PostTradeRefresherDeps,
): PostTradeRefresher {
  const {
    refreshGate,
    trader,
    lastState,
    monitorContexts,
    displayAccountAndPositions,
  } = deps;

  let running = true;
  let inFlight = false;
  let pendingSymbols: PendingRefreshSymbol[] = [];
  let latestQuotesMap: ReadonlyMap<string, Quote | null> | null = null;
  let pendingVersion: number | null = null;
  let immediateHandle: ReturnType<typeof setImmediate> | null = null;
  let retryHandle: ReturnType<typeof setTimeout> | null = null;

  async function refreshAfterTrades(
    pending: ReadonlyArray<PendingRefreshSymbol>,
    quotesMap: ReadonlyMap<string, Quote | null>,
  ): Promise<boolean> {
    if (pending.length === 0) {
      return true;
    }

    const needRefreshAccount = pending.some((item) => item.refreshAccount);
    const needRefreshPositions = pending.some((item) => item.refreshPositions);
    let refreshOk = true;

    if (needRefreshAccount || needRefreshPositions) {
      try {
        const [freshAccount, freshPositions] = await Promise.all([
          needRefreshAccount ? trader.getAccountSnapshot() : Promise.resolve(null),
          needRefreshPositions ? trader.getStockPositions() : Promise.resolve(null),
        ]);

        if (freshAccount !== null) {
          lastState.cachedAccount = freshAccount;
          logger.debug('[缓存刷新] 订单成交后刷新账户缓存');
        }

        if (Array.isArray(freshPositions)) {
          lastState.cachedPositions = freshPositions;
          lastState.positionCache.update(freshPositions);
          logger.debug('[缓存刷新] 订单成交后刷新持仓缓存');
        }
      } catch (err) {
        refreshOk = false;
        logger.warn('[缓存刷新] 订单成交后刷新缓存失败', formatError(err));
      }
    }

    const monitorContextBySymbol = new Map<string, MonitorContext>();

    for (const ctx of monitorContexts.values()) {
      const monitorSymbol = ctx.config.monitorSymbol;
      const seats = [
        ctx.symbolRegistry.getSeatState(monitorSymbol, 'LONG'),
        ctx.symbolRegistry.getSeatState(monitorSymbol, 'SHORT'),
      ];
      for (const seat of seats) {
        if (isSeatReady(seat) && !monitorContextBySymbol.has(seat.symbol)) {
          monitorContextBySymbol.set(seat.symbol, ctx);
        }
      }
    }

    for (const { symbol, isLongSymbol } of pending) {
      const monitorContext = monitorContextBySymbol.get(symbol);
      if (!monitorContext) {
        continue;
      }

      const maxUnrealizedLoss = monitorContext.config.maxUnrealizedLossPerSymbol ?? 0;
      if (maxUnrealizedLoss <= 0) {
        continue;
      }

      const quote = quotesMap.get(symbol) ?? null;
      const symbolName = isLongSymbol
        ? monitorContext.longSymbolName
        : monitorContext.shortSymbolName;
      const dailyLossOffset = monitorContext.dailyLossTracker.getLossOffset(
        monitorContext.config.monitorSymbol,
        isLongSymbol,
      );
      try {
        await monitorContext.riskChecker.refreshUnrealizedLossData(
          monitorContext.orderRecorder,
          symbol,
          isLongSymbol,
          quote,
          dailyLossOffset,
        );
      } catch (err) {
        refreshOk = false;
        logger.warn(
          `[浮亏监控] 订单成交后刷新浮亏数据失败: ${formatSymbolDisplay(symbol, symbolName)}`,
          formatError(err),
        );
      }
    }

    try {
      await displayAccountAndPositions({ lastState, quotesMap });
    } catch (err) {
      logger.warn('[缓存刷新] 订单成交后展示账户持仓失败', formatError(err));
    }

    return refreshOk;
  }

  async function run(): Promise<void> {
    if (!running || inFlight || pendingSymbols.length === 0 || !latestQuotesMap) {
      return;
    }

    const pending = pendingSymbols;
    const quotesMap = latestQuotesMap;
    const targetVersion = pendingVersion ?? refreshGate.getStatus().staleVersion;

    pendingSymbols = [];
    pendingVersion = null;
    inFlight = true;

    let refreshOk = false;
    try {
      refreshOk = await refreshAfterTrades(pending, quotesMap);
    } finally {
      if (refreshOk) {
        refreshGate.markFresh(targetVersion);
      } else {
        pendingSymbols = pending.concat(pendingSymbols);
        pendingVersion = pendingVersion == null
          ? targetVersion
          : Math.max(pendingVersion, targetVersion);
      }
      inFlight = false;
      if (running && pendingSymbols.length > 0) {
        if (refreshOk) {
          scheduleRun();
        } else {
          scheduleRetry();
        }
      }
    }
  }

  function scheduleRun(): void {
    if (!running || inFlight || immediateHandle) {
      return;
    }
    if (retryHandle) {
      clearTimeout(retryHandle);
      retryHandle = null;
    }
    immediateHandle = setImmediate(() => {
      immediateHandle = null;
      void run();
    });
  }

  function scheduleRetry(): void {
    if (!running || inFlight || retryHandle) {
      return;
    }
    retryHandle = setTimeout(() => {
      retryHandle = null;
      void run();
    }, API.DEFAULT_RETRY_DELAY_MS);
  }

  function enqueue(params: PostTradeRefresherEnqueueParams): void {
    if (!running || params.pending.length === 0) {
      return;
    }

    pendingSymbols = pendingSymbols.concat(params.pending);
    latestQuotesMap = params.quotesMap;

    const { staleVersion } = refreshGate.getStatus();
    pendingVersion = pendingVersion == null ? staleVersion : Math.max(pendingVersion, staleVersion);

    scheduleRun();
  }

  function stop(): void {
    running = false;
    pendingSymbols = [];
    latestQuotesMap = null;
    if (immediateHandle) {
      clearImmediate(immediateHandle);
      immediateHandle = null;
    }
    if (retryHandle) {
      clearTimeout(retryHandle);
      retryHandle = null;
    }
  }

  return {
    enqueue,
    stop,
  };
}
