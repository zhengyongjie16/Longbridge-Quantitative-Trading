/**
 * 信号运行时缓存域（CacheDomain: signalRuntime）
 *
 * 午夜清理：
 * - 停止并排空所有异步处理器（买入、卖出、监控任务、订单监控、交易后刷新）
 * - 清空交易任务队列（买入/卖出/监控），释放队列中的信号对象
 * - 取消所有延迟验证信号
 * - 清空订单监控的最新行情缓存和交易后刷新的待处理项
 * - 清空指标计算缓存
 *
 * 开盘重建：
 * - 重启所有异步处理器（买入、卖出、监控任务、订单监控、交易后刷新）
 * - 刷新 refreshGate 版本，标记数据为最新
 */
import { logger } from '../../../utils/logger/index.js';
import type { MonitorContext } from '../../../types/index.js';
import type { CacheDomain, LifecycleContext } from '../types.js';
import type { SignalRuntimeDomainDeps } from './types.js';

function clearTradeQueues(
  deps: Pick<
    SignalRuntimeDomainDeps,
    'buyTaskQueue' | 'sellTaskQueue' | 'monitorTaskQueue' | 'releaseSignal'
  >,
): {
  readonly removedBuy: number;
  readonly removedSell: number;
  readonly removedMonitor: number;
} {
  const { buyTaskQueue, sellTaskQueue, monitorTaskQueue, releaseSignal } = deps;
  const removedBuy = buyTaskQueue.clearAll((task) => {
    releaseSignal(task.data);
  });
  const removedSell = sellTaskQueue.clearAll((task) => {
    releaseSignal(task.data);
  });
  const removedMonitor = monitorTaskQueue.clearAll();
  return {
    removedBuy,
    removedSell,
    removedMonitor,
  };
}

function cancelAllDelayedSignals(
  monitorContexts: ReadonlyMap<string, MonitorContext>,
): number {
  let total = 0;
  for (const monitorContext of monitorContexts.values()) {
    total += monitorContext.delayedSignalVerifier.cancelAll();
  }
  return total;
}

export function createSignalRuntimeDomain(deps: SignalRuntimeDomainDeps): CacheDomain {
  const {
    monitorContexts,
    buyProcessor,
    sellProcessor,
    monitorTaskProcessor,
    orderMonitorWorker,
    postTradeRefresher,
    indicatorCache,
    buyTaskQueue,
    sellTaskQueue,
    monitorTaskQueue,
    refreshGate,
    releaseSignal,
  } = deps;

  return {
    name: 'signalRuntime',
    async midnightClear(_ctx: LifecycleContext): Promise<void> {
      await Promise.all([
        buyProcessor.stopAndDrain(),
        sellProcessor.stopAndDrain(),
        monitorTaskProcessor.stopAndDrain(),
        orderMonitorWorker.stopAndDrain(),
        postTradeRefresher.stopAndDrain(),
      ]);

      const queueResult = clearTradeQueues({
        buyTaskQueue,
        sellTaskQueue,
        monitorTaskQueue,
        releaseSignal,
      });
      const removedDelayed = cancelAllDelayedSignals(monitorContexts);

      orderMonitorWorker.clearLatestQuotes();
      postTradeRefresher.clearPending();
      indicatorCache.clearAll();

      logger.info(
        `[Lifecycle][signalRuntime] 午夜清理完成: delayed=${removedDelayed}, buy=${queueResult.removedBuy}, sell=${queueResult.removedSell}, monitor=${queueResult.removedMonitor}`,
      );
    },
    openRebuild(_ctx: LifecycleContext): void {
      buyProcessor.restart();
      sellProcessor.restart();
      monitorTaskProcessor.restart();
      orderMonitorWorker.start();
      postTradeRefresher.start();
      const latestStaleVersion = refreshGate.getStatus().staleVersion;
      refreshGate.markFresh(latestStaleVersion);
      logger.info('[Lifecycle][signalRuntime] 处理器与运行态已重启');
    },
  };
}
