/**
 * app runtime 队列清理模块
 *
 * 职责：
 * - 清理指定监控标的方向下的延迟/买卖/监控任务
 * - 统一输出队列清理统计日志
 */
import {
  clearMonitorDirectionQueues,
  logDirectionQueueCleanup,
} from '../../main/processMonitor/utils.js';
import type { ClearQueuesForDirectionWithLogParams } from '../types.js';

/**
 * 清理指定监控标的方向下的所有待执行任务并按需输出统计日志。
 * 默认行为：monitorContext 不存在时直接返回；仅当存在移除任务时写 debug 日志。
 *
 * @param params 清理参数，包含 monitorSymbol、direction、队列实例与 logger
 * @returns 无返回值
 */
export function clearMonitorDirectionQueuesWithLog(
  params: ClearQueuesForDirectionWithLogParams,
): void {
  const {
    monitorSymbol,
    direction,
    monitorContexts,
    buyTaskQueue,
    sellTaskQueue,
    monitorTaskQueue,
    logger,
  } = params;

  const monitorContext = monitorContexts.get(monitorSymbol);
  if (!monitorContext) {
    return;
  }

  const result = clearMonitorDirectionQueues({
    monitorSymbol,
    direction,
    delayedSignalVerifier: monitorContext.delayedSignalVerifier,
    buyTaskQueue,
    sellTaskQueue,
    monitorTaskQueue,
  });

  logDirectionQueueCleanup({
    source: '自动换标',
    monitorSymbol,
    direction,
    result,
    logger,
  });
}
