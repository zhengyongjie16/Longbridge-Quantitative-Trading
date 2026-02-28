/**
 * 订单监控工作器模块
 *
 * 功能：
 * - 异步执行订单监控和管理（超时撤单、订单状态追踪）
 * - 使用"最新覆盖"策略，避免并发执行
 * - 当有新行情到达时，如果上一次执行未完成，则记录最新行情待执行
 *
 * 执行策略：
 * - 调用 schedule(quotesMap) 时记录最新行情
 * - 如果当前无任务在执行，立即开始执行
 * - 如果有任务在执行，等待完成后自动执行最新记录的行情
 * - 保证同一时刻只有一个 monitorAndManageOrders 在运行
 */
import { logger } from '../../../utils/logger/index.js';
import type { Quote } from '../../../types/quote.js';
import type { OrderMonitorWorker, OrderMonitorWorkerDeps } from './types.js';
import { formatError } from '../../../utils/error/index.js';
/**
 * 创建订单监控工作器。
 * 使用「最新覆盖」策略异步执行订单监控：同一时刻仅有一个 monitorAndManageOrders 在运行，
 * 新行情到达时若当前有任务在执行则覆盖待执行行情，避免排队积压。
 *
 * @param deps 依赖注入，含 monitorAndManageOrders（订单监控与管理的异步函数）
 * @returns OrderMonitorWorker 实例（start、schedule、stopAndDrain、clearLatestQuotes）
 */
export function createOrderMonitorWorker(deps: OrderMonitorWorkerDeps): OrderMonitorWorker {
  const { monitorAndManageOrders } = deps;
  let running = true;
  let inFlight = false;
  let latestQuotes: ReadonlyMap<string, Quote | null> | null = null;
  let drainResolve: (() => void) | null = null;
  const hasQueuedQuotes = (): boolean => latestQuotes !== null;
  /**
   * 执行一次订单监控，消费 latestQuotes 并调用 monitorAndManageOrders
   * 完成后若有新行情则自动触发下一次执行，保证最新行情不被丢弃
   */
  async function run(): Promise<void> {
    if (!running || inFlight || !latestQuotes) {
      return;
    }
    const quotes = latestQuotes;
    latestQuotes = null;
    inFlight = true;
    try {
      await monitorAndManageOrders(quotes);
    } catch (err) {
      logger.warn('[OrderMonitorWorker] 订单监控失败', formatError(err));
    } finally {
      inFlight = false;
      drainResolve?.();
      drainResolve = null;
      if (hasQueuedQuotes()) {
        void run();
      }
    }
  }
  /**
   * 记录最新行情并触发执行
   * 若当前有任务在执行，仅更新 latestQuotes，等待当前任务完成后自动消费
   */
  function schedule(quotesMap: ReadonlyMap<string, Quote | null>): void {
    if (!running) {
      return;
    }
    latestQuotes = quotesMap;
    if (!inFlight) {
      void run();
    }
  }
  /**
   * 停止工作器并等待当前在途任务完成
   * 清空待执行行情，确保停止后不再触发新的监控执行
   */
  async function stopAndDrain(): Promise<void> {
    running = false;
    latestQuotes = null;
    if (!inFlight) return;
    await new Promise<void>((resolve) => {
      drainResolve = resolve;
    });
  }
  /**
   * 启动工作器，允许后续 schedule 调用触发执行
   */
  function start(): void {
    running = true;
  }
  /**
   * 清空待执行行情，用于生命周期重置时丢弃未消费的行情数据
   */
  function clearLatestQuotes(): void {
    latestQuotes = null;
  }
  return {
    start,
    schedule,
    stopAndDrain,
    clearLatestQuotes,
  };
}
