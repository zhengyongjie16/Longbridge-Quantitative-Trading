/**
 * monitorDisplayRuntime 模块
 *
 * 职责：
 * - 接收 businessEventProgram 提交后的 monitor snapshot 渲染请求
 * - 以 monitorSymbol 为单位执行 single-flight + latest-only collapse
 * - 在 runtime gate 打开时异步读取当前 monitor quote 并交给纯渲染器输出
 */
import { TRADING } from '../../constants/index.js';
import { logger } from '../../utils/logger/index.js';
import { formatError } from '../../utils/error/index.js';
import type { IndicatorSnapshot } from '../../types/quote.js';
import type {
  MonitorDisplayRouteState,
  MonitorDisplayRuntime,
  MonitorDisplayRuntimeDeps,
} from './types.js';

function isGateOpen(lastState: MonitorDisplayRuntimeDeps['lastState']): boolean {
  return lastState.isTradingEnabled && lastState.canTrade === true;
}

export function createMonitorDisplayRuntime(
  deps: MonitorDisplayRuntimeDeps,
): MonitorDisplayRuntime {
  const routeStates = new Map<string, MonitorDisplayRouteState>();
  const activePromises = new Set<Promise<void>>();
  let running = false;

  function getOrCreateRouteState(monitorSymbol: string): MonitorDisplayRouteState {
    const existing = routeStates.get(monitorSymbol);
    if (existing !== undefined) {
      return existing;
    }

    const routeState: MonitorDisplayRouteState = {
      inFlight: false,
      dirty: false,
      latestMonitorSnapshot: null,
    };
    routeStates.set(monitorSymbol, routeState);
    return routeState;
  }

  function trackPromise(promise: Promise<void>): void {
    activePromises.add(promise);
    void promise.finally(() => {
      activePromises.delete(promise);
    });
  }

  async function processRoute(monitorSymbol: string): Promise<void> {
    const routeState = routeStates.get(monitorSymbol);
    if (routeState === undefined) {
      return;
    }

    try {
      while (running && routeState.dirty) {
        routeState.dirty = false;
        const monitorSnapshot = routeState.latestMonitorSnapshot;
        if (monitorSnapshot === null) {
          return;
        }

        if (!isGateOpen(deps.lastState)) {
          return;
        }

        try {
          const quotesMap = await deps.marketDataClient.getQuotes([monitorSymbol]);
          if (!isGateOpen(deps.lastState)) {
            return;
          }

          const latestRouteState = routeStates.get(monitorSymbol);
          if (latestRouteState?.dirty === true) {
            continue;
          }

          const latestSnapshot = routeState.latestMonitorSnapshot;
          if (latestSnapshot === null) {
            return;
          }

          const monitorContext = deps.monitorContexts.get(monitorSymbol);
          if (monitorContext === undefined) {
            return;
          }

          const candlestickSnapshot = deps.marketDataClient.getCandlestickSnapshot(
            monitorSymbol,
            TRADING.CANDLE_PERIOD,
          );
          deps.marketMonitor.renderMonitorIndicators({
            monitorSymbol,
            monitorSnapshot: latestSnapshot,
            monitorQuote: quotesMap.get(monitorSymbol) ?? null,
            indicatorProfile: monitorContext.indicatorProfile,
            klineTimestamp: candlestickSnapshot?.lastBarTimestamp ?? null,
          });
        } catch (error) {
          logger.warn(
            `[monitorDisplayRuntime] render failed monitorSymbol=${monitorSymbol}`,
            formatError(error),
          );
        }
      }
    } finally {
      routeState.inFlight = false;
      if (routeState.dirty && running) {
        routeState.inFlight = true;
        trackPromise(processRoute(monitorSymbol));
      }
    }
  }

  function start(): void {
    running = true;
  }

  function requestRender(params: {
    readonly monitorSymbol: string;
    readonly monitorSnapshot: IndicatorSnapshot;
  }): void {
    if (!running) {
      return;
    }

    const routeState = getOrCreateRouteState(params.monitorSymbol);
    routeState.latestMonitorSnapshot = params.monitorSnapshot;
    routeState.dirty = true;
    if (routeState.inFlight) {
      return;
    }

    routeState.inFlight = true;
    trackPromise(processRoute(params.monitorSymbol));
  }

  async function stopAndDrain(): Promise<void> {
    running = false;
    if (activePromises.size > 0) {
      await Promise.allSettled(activePromises);
    }

    routeStates.clear();
  }

  return {
    start,
    requestRender,
    stopAndDrain,
  };
}
