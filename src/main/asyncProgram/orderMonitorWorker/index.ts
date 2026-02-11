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
import { formatError } from '../../../utils/helpers/index.js';

import type { Quote } from '../../../types/index.js';
import type { OrderMonitorWorker, OrderMonitorWorkerDeps } from './types.js';

/**
 * 创建订单监控工作器
 * 使用"最新覆盖"策略异步执行订单监控
 */
export function createOrderMonitorWorker(deps: OrderMonitorWorkerDeps): OrderMonitorWorker {
  const { monitorAndManageOrders } = deps;

  let running = true;
  let inFlight = false;
  let latestQuotes: ReadonlyMap<string, Quote | null> | null = null;
  let drainResolve: (() => void) | null = null;

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
      if (running && latestQuotes) {
        void run();
      }
    }
  }

  function schedule(quotesMap: ReadonlyMap<string, Quote | null>): void {
    if (!running) {
      return;
    }
    latestQuotes = quotesMap;
    if (!inFlight) {
      void run();
    }
  }

  function stop(): void {
    running = false;
    latestQuotes = null;
  }

  async function stopAndDrain(): Promise<void> {
    running = false;
    latestQuotes = null;
    if (!inFlight) return;
    await new Promise<void>((resolve) => {
      drainResolve = resolve;
    });
  }

  function start(): void {
    running = true;
  }

  function clearLatestQuotes(): void {
    latestQuotes = null;
  }

  return {
    start,
    schedule,
    stop,
    stopAndDrain,
    clearLatestQuotes,
  };
}
