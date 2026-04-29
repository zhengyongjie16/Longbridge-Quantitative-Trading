/**
 * businessEventProgram 模块
 *
 * 职责：
 * - 监听 monitor symbol 的 K 线更新事件
 * - 以 per-monitor single-flight + latest-only collapse 推进普通 latest snapshot
 * - 在事件路径中直接生成普通 immediate / delayed signals
 * - 在普通指标推进成功后立即写入 indicatorCache 延迟验证样本
 * - 不负责生命周期 tick、末日保护和周期换标 tick
 */
import { TRADING } from '../../constants/index.js';
import { logger } from '../../utils/logger/index.js';
import { formatError } from '../../utils/error/index.js';
import { projectVerificationSampleValues } from '../asyncProgram/indicatorCache/utils.js';
import { runIndicatorPipeline } from './indicatorPipeline.js';
import { runSignalPipeline } from './signalPipeline.js';
import { resolveSignalSeatInfo } from '../processMonitor/seatProjection.js';
import type {
  BusinessEventProgram,
  BusinessEventProgramDeps,
  BusinessEventRouteState,
} from './types.js';

/**
 * 创建普通 K 线业务主程序。
 *
 * @param deps 共享依赖
 * @returns businessEventProgram 实例
 */
export function createBusinessEventProgram(deps: BusinessEventProgramDeps): BusinessEventProgram {
  const {
    marketDataClient,
    monitorContexts,
    lastState,
    tradingConfig,
    buyTaskQueue,
    sellTaskQueue,
    indicatorCache,
    monitorDisplayRuntime,
  } = deps;
  const pipelineContext = {
    marketDataClient,
    lastState,
    tradingConfig,
    buyTaskQueue,
    sellTaskQueue,
  };
  const routeStates = new Map<string, BusinessEventRouteState>();
  const activePromises = new Set<Promise<void>>();
  let running = false;
  let unsubscribeCandlestickUpdated: (() => void) | null = null;

  /**
   * 获取或创建单 monitor route 状态。
   *
   * @param monitorSymbol 监控标的
   * @returns route 状态
   */
  function getOrCreateRouteState(monitorSymbol: string): BusinessEventRouteState {
    const existing = routeStates.get(monitorSymbol);
    if (existing !== undefined) {
      return existing;
    }

    const routeState: BusinessEventRouteState = {
      inFlight: false,
      dirty: false,
    };
    routeStates.set(monitorSymbol, routeState);
    return routeState;
  }

  /**
   * 启动并跟踪单 monitor route 的异步调度任务。
   *
   * @param monitorSymbol 监控标的
   * @param failureMessage 失败日志前缀
   */
  function startMonitorRouteProcessing(monitorSymbol: string, failureMessage: string): void {
    const processingPromise = Promise.resolve()
      .then(() => {
        processMonitorRoute(monitorSymbol);
      })
      .catch((error: unknown) => {
        logger.error(
          `[businessEventProgram] ${failureMessage} monitorSymbol=${monitorSymbol}`,
          formatError(error),
        );
      });
    activePromises.add(processingPromise);
    void processingPromise.finally(() => {
      activePromises.delete(processingPromise);
    });
  }

  /**
   * 处理单 monitor 的 K 线业务链路。
   *
   * @param monitorSymbol 监控标的
   */
  function processMonitorRoute(monitorSymbol: string): void {
    if (!routeStates.has(monitorSymbol)) {
      return;
    }

    try {
      while (running) {
        const currentRouteState = routeStates.get(monitorSymbol);
        if (!currentRouteState?.dirty) {
          return;
        }

        const observedAtMs = currentRouteState.pendingObservedAtMs;
        routeStates.set(monitorSymbol, {
          inFlight: currentRouteState.inFlight,
          dirty: false,
        });

        const monitorContext = monitorContexts.get(monitorSymbol);
        if (monitorContext === undefined) {
          routeStates.delete(monitorSymbol);
          return;
        }

        const monitorSnapshot = runIndicatorPipeline({
          monitorSymbol,
          monitorContext,
          mainContext: pipelineContext,
        });
        if (monitorSnapshot === null) {
          continue;
        }

        const verificationIndicators = new Set([
          ...monitorContext.indicatorProfile.verificationIndicatorsBySide.buy,
          ...monitorContext.indicatorProfile.verificationIndicatorsBySide.sell,
        ]);
        indicatorCache.push(
          monitorSymbol,
          projectVerificationSampleValues(monitorSnapshot, [...verificationIndicators]),
          observedAtMs,
        );

        const seatInfo = resolveSignalSeatInfo({
          monitorSymbol,
          monitorContext,
        });

        monitorDisplayRuntime.requestRender({
          monitorSymbol,
          monitorSnapshot,
        });

        runSignalPipeline({
          monitorSymbol,
          monitorContext,
          mainContext: pipelineContext,
          runtimeFlags: {
            currentTime: new Date(),
            openProtectionActive: lastState.openProtectionActive === true,
          },
          seatInfo,
          monitorSnapshot,
        });
      }
    } finally {
      const latestRouteState = routeStates.get(monitorSymbol);
      if (latestRouteState !== undefined) {
        const idleRouteState: BusinessEventRouteState = latestRouteState.dirty
          ? {
              inFlight: false,
              dirty: true,
              pendingObservedAtMs: latestRouteState.pendingObservedAtMs,
            }
          : {
              inFlight: false,
              dirty: false,
            };
        routeStates.set(monitorSymbol, idleRouteState);
        if (running && idleRouteState.dirty) {
          routeStates.set(monitorSymbol, {
            inFlight: true,
            dirty: true,
            pendingObservedAtMs: idleRouteState.pendingObservedAtMs,
          });
          startMonitorRouteProcessing(monitorSymbol, 'monitor route 重入失败');
        }
      }
    }
  }

  /**
   * 统一触发单 monitor 业务路由。
   *
   * @param monitorSymbol 监控标的
   * @param observedAtMs 本次 K 线事件被监听到的时间戳
   */
  function triggerMonitorRoute(monitorSymbol: string, observedAtMs: number): void {
    let routeState = getOrCreateRouteState(monitorSymbol);
    routeState = {
      ...routeState,
      dirty: true,
      pendingObservedAtMs: observedAtMs,
    };
    routeStates.set(monitorSymbol, routeState);
    if (routeState.inFlight || !running) {
      return;
    }

    routeState = {
      ...routeState,
      inFlight: true,
    };
    routeStates.set(monitorSymbol, routeState);
    startMonitorRouteProcessing(monitorSymbol, 'monitor route 执行失败');
  }

  function start(): void {
    if (running) {
      return;
    }

    running = true;
    unsubscribeCandlestickUpdated = marketDataClient.onCandlestickUpdated((event) => {
      if (event.period !== TRADING.CANDLE_PERIOD) {
        return;
      }

      if (!monitorContexts.has(event.symbol)) {
        return;
      }

      triggerMonitorRoute(event.symbol, Date.now());
    });
  }

  async function stopAndDrain(): Promise<void> {
    running = false;
    unsubscribeCandlestickUpdated?.();
    unsubscribeCandlestickUpdated = null;

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
