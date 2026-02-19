/**
 * 交易后刷新器模块
 *
 * 功能：
 * - 订单成交后异步刷新账户和持仓缓存
 * - 刷新浮亏监控数据（R1/N1）
 * - 展示最新的账户和持仓信息
 *
 * 与 RefreshGate 的协作：
 * - 订单成交时 markStale() 标记缓存过期
 * - 本模块完成刷新后调用 markFresh(version)
 * - 其他异步处理器通过 waitForFresh() 等待刷新完成
 *
 * 重试机制：
 * - 刷新失败时自动重试（延迟 API.DEFAULT_RETRY_DELAY_MS）
 * - 重试时合并所有待刷新标的，避免重复刷新
 */
import { logger } from '../../../utils/logger/index.js';
import { API } from '../../../constants/index.js';
import { formatError, formatSymbolDisplay } from '../../../utils/helpers/index.js';
import { isSeatReady } from '../../../services/autoSymbolManager/utils.js';

import type { MonitorContext } from '../../../types/state.js';
import type { Quote } from '../../../types/quote.js';
import type { PendingRefreshSymbol } from '../../../types/services.js';
import type { PostTradeRefresher, PostTradeRefresherDeps, PostTradeRefresherEnqueueParams } from './types.js';

/**
 * 创建交易后刷新器。
 * 订单成交后异步刷新账户、持仓与浮亏数据，并调用 displayAccountAndPositions 展示；完成刷新后 markFresh，供其他异步处理器 waitForFresh 同步。失败时自动重试并合并待刷新标的。
 *
 * @param deps 依赖注入，包含 refreshGate、trader、lastState、monitorContexts、displayAccountAndPositions
 * @returns PostTradeRefresher 实例（start、enqueue、stopAndDrain、clearPending）
 */
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
  let drainResolve: (() => void) | null = null;

  /**
   * 执行交易后刷新：刷新账户/持仓缓存、浮亏数据，并展示最新账户持仓信息
   * 任一步骤失败时返回 false，由调用方决定是否重试
   */
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

  /**
   * 执行一次刷新任务
   * 消费当前 pendingSymbols，刷新失败时将任务归还并触发重试
   */
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
      drainResolve?.();
      drainResolve = null;
      if (running && pendingSymbols.length > 0) {
        if (refreshOk) {
          scheduleRun();
        } else {
          scheduleRetry();
        }
      }
    }
  }

  /**
   * 通过 setImmediate 调度下一次 run，避免重复调度
   * 若存在重试定时器则先取消，优先立即执行
   */
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

  /**
   * 刷新失败后延迟重试，使用 API.DEFAULT_RETRY_DELAY_MS 间隔
   */
  function scheduleRetry(): void {
    if (!running || inFlight || retryHandle) {
      return;
    }
    retryHandle = setTimeout(() => {
      retryHandle = null;
      void run();
    }, API.DEFAULT_RETRY_DELAY_MS);
  }

  /**
   * 将待刷新标的加入队列并触发调度
   * 多次入队时合并 pendingSymbols，取最新行情和最大 staleVersion
   */
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

  /**
   * 停止刷新器并等待当前在途任务完成
   * 清空所有待刷新队列和定时器，确保优雅退出
   */
  async function stopAndDrain(): Promise<void> {
    running = false;
    pendingSymbols = [];
    latestQuotesMap = null;
    pendingVersion = null;
    if (immediateHandle) {
      clearImmediate(immediateHandle);
      immediateHandle = null;
    }
    if (retryHandle) {
      clearTimeout(retryHandle);
      retryHandle = null;
    }
    if (!inFlight) return;
    await new Promise<void>((resolve) => {
      drainResolve = resolve;
    });
  }

  /** 启动刷新器，允许后续 enqueue 触发刷新 */
  function start(): void {
    running = true;
  }

  /** 清空待刷新队列与版本，用于生命周期重置时丢弃未消费的刷新请求 */
  function clearPending(): void {
    pendingSymbols = [];
    latestQuotesMap = null;
    pendingVersion = null;
  }

  return {
    start,
    enqueue,
    stopAndDrain,
    clearPending,
  };
}
