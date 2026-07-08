/**
 * tradingQuoteDisplayRuntime 模块
 *
 * 职责：
 * - 监听标准化交易标的 quote 事件
 * - 复用 tradingRisk routing 规则解析当前 ACTIVE route
 * - 按 routeKey 执行 single-flight + latest-only collapse，避免异步期间输出旧 quote
 * - 在异步补充 monitor quote 后再次复核 routeKey + seatVersion，再交给纯渲染器输出
 */
import { buildTradingRiskRoutingIndex } from '../tradingRiskEventRuntime/routingIndex.js';
import {
  isTradingRiskRouteCurrent,
  resolveTradingRiskRoute,
} from '../tradingRiskEventRuntime/routeValidation.js';
import { logger } from '../../utils/logger/index.js';
import { formatError } from '../../utils/error/index.js';
import type { TradingRiskRoutingIndex } from '../tradingRiskEventRuntime/types.js';
import type {
  TradingQuoteDisplayRouteState,
  TradingQuoteDisplayRuntime,
  TradingQuoteDisplayRuntimeDeps,
} from './types.js';

function isGateOpen(lastState: TradingQuoteDisplayRuntimeDeps['lastState']): boolean {
  return lastState.isTradingEnabled && lastState.canTrade === true;
}

export function createTradingQuoteDisplayRuntime(
  deps: TradingQuoteDisplayRuntimeDeps,
): TradingQuoteDisplayRuntime {
  const activePromises = new Set<Promise<void>>();
  const routeStates = new Map<string, TradingQuoteDisplayRouteState>();
  let cachedRoutingIndex: TradingRiskRoutingIndex | null = null;
  let routingIndexFatalError: Error | null = null;
  let running = false;
  let unsubscribeQuoteUpdated: (() => void) | null = null;
  let unsubscribeSeatTruthChanged: (() => void) | null = null;

  function trackPromise(promise: Promise<void>): void {
    activePromises.add(promise);
    void promise.finally(() => {
      activePromises.delete(promise);
    });
  }

  /**
   * 按当前席位事实重建交易 quote 到监控 route 的派生索引。
   */
  function rebuildRoutingIndex(): void {
    try {
      cachedRoutingIndex = buildTradingRiskRoutingIndex({
        monitorContexts: deps.monitorContexts,
        symbolRegistry: deps.symbolRegistry,
      });
      routingIndexFatalError = null;
    } catch (error) {
      cachedRoutingIndex = null;
      routingIndexFatalError = error instanceof Error ? error : new Error(formatError(error));
      logger.warn(
        '[tradingQuoteDisplayRuntime] routing index build failed',
        formatError(routingIndexFatalError),
      );
    }
  }

  /**
   * 获取当前可用的派生 routing index。
   *
   * @returns routing index 构建失败或尚不可用时返回 null
   */
  function getCurrentRoutingIndex(): TradingRiskRoutingIndex | null {
    if (routingIndexFatalError !== null) {
      return null;
    }

    return cachedRoutingIndex;
  }

  function getOrCreateRouteState(routeKey: string): TradingQuoteDisplayRouteState {
    const existing = routeStates.get(routeKey);
    if (existing !== undefined) {
      return existing;
    }

    const routeState: TradingQuoteDisplayRouteState = {
      inFlight: false,
      dirty: false,
      latestEvent: null,
      latestRoute: null,
    };
    routeStates.set(routeKey, routeState);
    return routeState;
  }

  async function processRoute(routeKey: string): Promise<void> {
    const routeState = routeStates.get(routeKey);
    if (routeState === undefined) {
      return;
    }

    try {
      while (running && routeState.dirty) {
        routeState.dirty = false;
        const event = routeState.latestEvent;
        const route = routeState.latestRoute;
        if (event === null || route === null) {
          return;
        }

        if (!isGateOpen(deps.lastState)) {
          return;
        }

        try {
          const quotesMap = await deps.marketDataClient.getQuotes([route.monitorSymbol]);
          const latestRouteState = routeStates.get(routeKey);
          if (latestRouteState?.dirty === true) {
            continue;
          }

          const routingIndex = getCurrentRoutingIndex();
          if (
            routingIndex === null ||
            !isGateOpen(deps.lastState) ||
            !isTradingRiskRouteCurrent(route, routingIndex)
          ) {
            return;
          }

          deps.renderTradingQuote({
            event,
            tradingSymbol: route.tradingSymbol,
            monitorSymbol: route.monitorSymbol,
            direction: route.direction,
            monitorQuote: quotesMap.get(route.monitorSymbol) ?? null,
          });
        } catch (error) {
          logger.warn(
            `[tradingQuoteDisplayRuntime] render failed routeKey=${routeKey}`,
            formatError(error),
          );
        }
      }
    } finally {
      routeState.inFlight = false;
      if (routeState.dirty && running) {
        routeState.inFlight = true;
        trackPromise(processRoute(routeKey));
      }
    }
  }

  function handleQuoteUpdated(
    event: Parameters<TradingQuoteDisplayRuntimeDeps['renderTradingQuote']>[0]['event'],
  ): void {
    if (!running || !isGateOpen(deps.lastState)) {
      return;
    }

    const routingIndex = getCurrentRoutingIndex();
    if (routingIndex === null) {
      return;
    }

    const route = resolveTradingRiskRoute(routingIndex, event.symbol);
    if (route === null) {
      return;
    }

    const routeState = getOrCreateRouteState(route.routeKey);
    routeState.latestEvent = event;
    routeState.latestRoute = route;
    routeState.dirty = true;
    if (routeState.inFlight) {
      return;
    }

    routeState.inFlight = true;
    trackPromise(processRoute(route.routeKey));
  }

  function start(): void {
    if (running) {
      return;
    }

    running = true;
    rebuildRoutingIndex();
    unsubscribeSeatTruthChanged = deps.symbolRegistry.onSeatTruthChanged(() => {
      rebuildRoutingIndex();
    });

    unsubscribeQuoteUpdated = deps.marketDataClient.onQuoteUpdated((event) => {
      handleQuoteUpdated(event);
    });
  }

  async function stopAndDrain(): Promise<void> {
    running = false;
    unsubscribeQuoteUpdated?.();
    unsubscribeQuoteUpdated = null;
    unsubscribeSeatTruthChanged?.();
    unsubscribeSeatTruthChanged = null;
    cachedRoutingIndex = null;
    routingIndexFatalError = null;
    if (activePromises.size > 0) {
      await Promise.allSettled(activePromises);
    }

    routeStates.clear();
  }

  return {
    start,
    stopAndDrain,
  };
}
