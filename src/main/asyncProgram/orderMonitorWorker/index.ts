/**
 * 订单监控工作器模块
 *
 * 功能：
 * - 异步执行订单监控和管理（超时撤单、订单状态追踪）
 * - 使用"最新覆盖"策略，避免并发执行
 * - 当主循环再次触发时，如果上一次执行未完成，则仅记录“需要再跑一次”
 *
 * 执行策略：
 * - 调用 schedule() 时仅标记需要执行
 * - 如果当前无任务在执行，立即开始执行
 * - 如果有任务在执行，等待完成后自动再执行一次
 * - 保证同一时刻只有一个 monitorAndManageOrders 在运行
 */
import { logger } from '../../../utils/logger/index.js';
import type { OrderMonitorWorker, OrderMonitorWorkerDeps } from './types.js';
import { formatError } from '../../../utils/error/index.js';

/**
 * 创建订单监控工作器。
 * 使用「最新覆盖」策略异步执行订单监控：同一时刻仅有一个 monitorAndManageOrders 在运行，
 * 新行情到达时若当前有任务在执行则覆盖待执行行情，避免排队积压。
 *
 * @param deps 依赖注入，含 monitorAndManageOrders（订单监控与管理的异步函数）
 * @returns OrderMonitorWorker 实例（start、schedule、stopAndDrain）
 */
export function createOrderMonitorWorker(deps: OrderMonitorWorkerDeps): OrderMonitorWorker {
  const { monitorAndManageOrders } = deps;
  let running = true;
  let inFlight = false;
  let queued = false;
  let drainResolve: (() => void) | null = null;

  /**
   * 执行一次订单监控，消费 queued 标记并调用 monitorAndManageOrders。
   * 完成后若期间又收到新的 schedule，则自动再执行一次。
   */
  async function run(): Promise<void> {
    if (!running || inFlight || !queued) {
      return;
    }

    queued = false;
    inFlight = true;
    try {
      await monitorAndManageOrders();
    } catch (err) {
      logger.warn('[OrderMonitorWorker] 订单监控失败', formatError(err));
    } finally {
      inFlight = false;
      if (drainResolve) {
        drainResolve();
      }

      drainResolve = null;
      void run();
    }
  }

  /**
   * 标记需要执行一次订单监控；若当前有任务在执行，则等待完成后再跑一轮。
   */
  function schedule(): void {
    if (!running) {
      return;
    }

    queued = true;
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
    queued = false;
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

  return {
    start,
    schedule,
    stopAndDrain,
  };
}
