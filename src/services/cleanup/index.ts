/**
 * 程序退出清理模块
 *
 * 功能：
 * - 创建程序退出时的资源清理函数
 * - 注册 SIGINT 和 SIGTERM 信号处理器
 * - 确保程序退出时正确释放所有资源
 *
 * 清理内容：
 * - 停止所有处理器（BuyProcessor、SellProcessor、MonitorTaskProcessor 等）
 * - 销毁所有 DelayedSignalVerifier
 * - 清空 IndicatorCache
 * - 释放所有监控快照对象
 */
import { logger } from '../../utils/logger/index.js';
import { CleanupContext } from './types.js';
import { releaseAllMonitorSnapshots } from './utils.js';

/**
 * 创建清理函数
 * @param context 清理上下文，包含需要清理的资源
 */
export function createCleanup(context: CleanupContext): {
  execute: () => Promise<void>;
  registerExitHandlers: () => void;
} {
  const {
    buyProcessor,
    sellProcessor,
    monitorTaskProcessor,
    orderMonitorWorker,
    postTradeRefresher,
    monitorContexts,
    indicatorCache,
    lastState,
  } = context;

  /**
   * 执行清理（stopAndDrain 确保 in-flight 任务排空）
   */
  async function execute(): Promise<void> {
    logger.info('Program exiting, cleaning up resources...');
    await buyProcessor.stopAndDrain();
    await sellProcessor.stopAndDrain();
    await monitorTaskProcessor.stopAndDrain();
    await orderMonitorWorker.stopAndDrain();
    await postTradeRefresher.stopAndDrain();
    for (const monitorContext of monitorContexts.values()) {
      monitorContext.delayedSignalVerifier.destroy();
    }
    indicatorCache.clearAll();
    releaseAllMonitorSnapshots(lastState.monitorStates);
  }

  /**
   * 注册退出处理函数
   */
  function registerExitHandlers(): void {
    const handler = (): void => {
      void execute().finally(() => process.exit(0));
    };
    process.once('SIGINT', handler);
    process.once('SIGTERM', handler);
  }

  return {
    execute,
    registerExitHandlers,
  };
}
