/**
 * 信号运行时缓存域（CacheDomain: signalRuntime）
 *
 * 午夜清理：
 * - 先终止 freshness 等待，随后停止普通 K 线业务 owner、交易标的风险 runtime、monitor quote runtime、switch wakeup runtime、自动寻标 runtime 与激活 dispatcher
 * - 再排空监控处理器并停止席位退场清理 owner，随后排空买卖处理器，最后停止订单监控 runtime、订阅 owner 与成交后一致性 runtime
 * - 清空交易任务队列（买入/卖出/监控）
 * - 取消所有延迟验证信号
 * - 调用成交后一致性 runtime 的跨日清理
 * - 清空指标计算缓存
 *
 * 开盘重建：
 * - 先启动成交后一致性 runtime，并完成 rebuild baseline
 * - 先执行订阅首轮真相投影，再启动订阅 owner、激活 dispatcher 与自动寻标 runtime
 * - 再启动普通 K 线业务 owner、交易标的风险 runtime、monitor quote runtime 与 switch wakeup runtime
 * - 再重启买入、卖出、监控任务处理器
 */
import { logger } from '../../../utils/logger/index.js';
import type { MonitorContext } from '../../../types/state.js';
import type { CacheDomain, LifecycleContext } from '../types.js';
import type { SignalRuntimeDomainDeps } from './types.js';

/**
 * 清空买入、卖出、监控三条任务队列。
 *
 * @param deps 包含 buyTaskQueue、sellTaskQueue、monitorTaskQueue
 * @returns 各队列移除的任务数量
 */
function clearTradeQueues(
  deps: Pick<SignalRuntimeDomainDeps, 'buyTaskQueue' | 'sellTaskQueue' | 'monitorTaskQueue'>,
): {
  readonly removedBuy: number;
  readonly removedSell: number;
  readonly removedMonitor: number;
} {
  const { buyTaskQueue, sellTaskQueue, monitorTaskQueue } = deps;
  const removedBuy = buyTaskQueue.clearAll();
  const removedSell = sellTaskQueue.clearAll();
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
 * 午夜清理时先中断 freshness 等待并停止上游事件 owner，再排空监控处理器并停止席位退场清理 owner，随后排空买卖处理器，最后停止订单监控、订阅 owner 与成交后一致性 runtime、清空任务队列并执行跨日清理；开盘重建时先恢复 runtime baseline 和订阅投影，再启动事件 owner 与处理器。
 *
 * @param deps 依赖注入，包含各处理器、队列与 postTradeConsistencyRuntime 等
 * @returns 实现 CacheDomain 的信号运行时域实例
 */
export function createSignalRuntimeDomain(deps: SignalRuntimeDomainDeps): CacheDomain {
  const {
    monitorContexts,
    buyProcessor,
    sellProcessor,
    monitorTaskProcessor,
    businessEventProgram,
    tradingRiskEventRuntime,
    monitorQuoteEventRuntime,
    monitorDisplayRuntime,
    tradingQuoteDisplayRuntime,
    switchWakeupRuntime,
    quoteSubscriptionRuntime,
    autoSearchWakeupRuntime,
    seatActivationDispatcher,
    seatRuntimeCleanupDispatcher,
    trader,
    postTradeConsistencyRuntime,
    indicatorCache,
    buyTaskQueue,
    sellTaskQueue,
    monitorTaskQueue,
  } = deps;

  return {
    async midnightClear(_ctx: LifecycleContext): Promise<void> {
      postTradeConsistencyRuntime.abortWaiting();
      await businessEventProgram.stopAndDrain();
      await tradingRiskEventRuntime.stopAndDrain();
      await monitorQuoteEventRuntime.stopAndDrain();
      await monitorDisplayRuntime.stopAndDrain();
      await tradingQuoteDisplayRuntime.stopAndDrain();
      await switchWakeupRuntime.stopAndDrain();
      await autoSearchWakeupRuntime.stopAndDrain();
      seatActivationDispatcher.stop();
      await monitorTaskProcessor.stopAndDrain();
      seatRuntimeCleanupDispatcher.stop();
      await buyProcessor.stopAndDrain();
      await sellProcessor.stopAndDrain();
      await trader.stopOrderMonitorRuntimeAndDrain();
      await quoteSubscriptionRuntime.stopAndDrain();
      await postTradeConsistencyRuntime.stopAndDrain();

      const queueResult = clearTradeQueues({
        buyTaskQueue,
        sellTaskQueue,
        monitorTaskQueue,
      });
      const removedDelayed = cancelAllDelayedSignals(monitorContexts);

      postTradeConsistencyRuntime.midnightClear();
      indicatorCache.clearAll();

      logger.debug(
        `[Lifecycle][signalRuntime] 午夜清理完成: delayed=${removedDelayed}, buy=${queueResult.removedBuy}, sell=${queueResult.removedSell}, monitor=${queueResult.removedMonitor}`,
      );
    },
    async openRebuild(_ctx: LifecycleContext): Promise<void> {
      postTradeConsistencyRuntime.resetAbort();
      postTradeConsistencyRuntime.start();
      postTradeConsistencyRuntime.completeRebuildBaseline();
      await quoteSubscriptionRuntime.reconcileFromCurrentTruth();
      tradingQuoteDisplayRuntime.start();
      quoteSubscriptionRuntime.start();
      seatRuntimeCleanupDispatcher.start();
      seatActivationDispatcher.start();
      autoSearchWakeupRuntime.start();
      monitorDisplayRuntime.start();
      businessEventProgram.start();
      tradingRiskEventRuntime.start();
      monitorQuoteEventRuntime.start();
      switchWakeupRuntime.start();
      buyProcessor.restart();
      sellProcessor.restart();
      monitorTaskProcessor.restart();
      trader.startOrderMonitorRuntime();
      logger.debug(
        '[Lifecycle][signalRuntime] runtime baseline、显示 owner、业务 owner、订阅 owner、处理器与订单监控 runtime 已重启',
      );
    },
  };
}
