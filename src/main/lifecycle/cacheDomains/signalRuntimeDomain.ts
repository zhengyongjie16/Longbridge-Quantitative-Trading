/**
 * 信号运行时缓存域（CacheDomain: signalRuntime）
 *
 * 午夜清理：
 * - 先终止 freshness 等待，再停止交易标的风险 runtime，然后排空其他处理器，最后停止成交后一致性 runtime
 * - 清空交易任务队列（买入/卖出/监控），释放队列中的信号对象
 * - 取消所有延迟验证信号
 * - 调用成交后一致性 runtime 的跨日清理
 * - 清空指标计算缓存
 *
 * 开盘重建：
 * - 先启动成交后一致性 runtime，并完成 rebuild baseline
 * - 再启动交易标的风险 runtime
 * - 再重启买入、卖出、监控任务与订单监控处理器
 */
import { logger } from '../../../utils/logger/index.js';
import type { MonitorContext } from '../../../types/state.js';
import type { CacheDomain, LifecycleContext } from '../types.js';
import type { SignalRuntimeDomainDeps } from './types.js';

/**
 * 清空买入、卖出、监控三条任务队列，释放队列中的信号对象回对象池。
 *
 * @param deps 包含 buyTaskQueue、sellTaskQueue、monitorTaskQueue、releaseSignal
 * @returns 各队列移除的任务数量
 */
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

/**
 * 取消所有监控标的的延迟验证信号。
 *
 * @param monitorContexts 所有监控上下文
 * @returns 取消的信号总数
 */
function cancelAllDelayedSignals(monitorContexts: ReadonlyMap<string, MonitorContext>): number {
  let total = 0;
  for (const monitorContext of monitorContexts.values()) {
    total += monitorContext.delayedSignalVerifier.cancelAll();
  }

  return total;
}

/**
 * 创建信号运行时缓存域。
 * 午夜清理时按 runtime owner 顺序停止处理器与成交后一致性 runtime、清空任务队列并执行跨日清理；开盘重建时先恢复 runtime baseline，再启动其他处理器。
 *
 * @param deps 依赖注入，包含各处理器、队列、postTradeConsistencyRuntime、releaseSignal 等
 * @returns 实现 CacheDomain 的信号运行时域实例
 */
export function createSignalRuntimeDomain(deps: SignalRuntimeDomainDeps): CacheDomain {
  const {
    monitorContexts,
    buyProcessor,
    sellProcessor,
    monitorTaskProcessor,
    orderMonitorWorker,
    tradingRiskEventRuntime,
    postTradeConsistencyRuntime,
    indicatorCache,
    buyTaskQueue,
    sellTaskQueue,
    monitorTaskQueue,
    releaseSignal,
  } = deps;

  return {
    async midnightClear(_ctx: LifecycleContext): Promise<void> {
      postTradeConsistencyRuntime.abortWaiting();
      await tradingRiskEventRuntime.stopAndDrain();
      await buyProcessor.stopAndDrain();
      await sellProcessor.stopAndDrain();
      await monitorTaskProcessor.stopAndDrain();
      await orderMonitorWorker.stopAndDrain();
      await postTradeConsistencyRuntime.stopAndDrain();

      const queueResult = clearTradeQueues({
        buyTaskQueue,
        sellTaskQueue,
        monitorTaskQueue,
        releaseSignal,
      });
      const removedDelayed = cancelAllDelayedSignals(monitorContexts);

      postTradeConsistencyRuntime.midnightClear();
      indicatorCache.clearAll();

      logger.debug(
        `[Lifecycle][signalRuntime] 午夜清理完成: delayed=${removedDelayed}, buy=${queueResult.removedBuy}, sell=${queueResult.removedSell}, monitor=${queueResult.removedMonitor}`,
      );
    },
    openRebuild(_ctx: LifecycleContext): void {
      postTradeConsistencyRuntime.resetAbort();
      postTradeConsistencyRuntime.start();
      postTradeConsistencyRuntime.completeRebuildBaseline();
      tradingRiskEventRuntime.start();
      buyProcessor.restart();
      sellProcessor.restart();
      monitorTaskProcessor.restart();
      orderMonitorWorker.start();
      logger.debug('[Lifecycle][signalRuntime] runtime baseline 与处理器已重启');
    },
  };
}
