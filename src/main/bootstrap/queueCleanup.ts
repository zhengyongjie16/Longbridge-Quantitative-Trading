/**
 * 自动换标队列清理模块
 *
 * 职责：
 * - 清理指定监控标的方向下的延迟/买卖/监控任务
 * - 统一输出队列清理统计日志
 */
import { clearMonitorDirectionQueues } from '../processMonitor/utils.js';
import { getQueueClearTotalRemoved } from '../../utils/utils.js';
import type { ClearQueuesForDirectionWithLogParams } from './types.js';

/**
 * 清理指定监控标的方向下的所有待执行任务并按需输出统计日志。
 * 默认行为：monitorContext 不存在时直接返回；仅当存在移除任务时写 info 日志。
 *
 * @param params 清理参数，包含 monitorSymbol、direction、队列实例、释放回调与 logger
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
    releaseSignal,
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
    releaseSignal,
  });

  const totalRemoved = getQueueClearTotalRemoved(result);
  if (totalRemoved > 0) {
    logger.info(
      `[自动换标] ${monitorSymbol} ${direction} 清理待执行信号：延迟=${result.removedDelayed} 买入=${result.removedBuy} 卖出=${result.removedSell} 监控任务=${result.removedMonitorTasks}`,
    );
  }
}
