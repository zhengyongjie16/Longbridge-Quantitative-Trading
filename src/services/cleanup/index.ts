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
export const createCleanup = (context: CleanupContext) => {
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
   * 执行清理
   */
  const execute = (): void => {
    logger.info('程序退出，正在清理资源...');
    // 停止 BuyProcessor 和 SellProcessor
    buyProcessor.stop();
    sellProcessor.stop();
    monitorTaskProcessor.stop();
    orderMonitorWorker.stop();
    postTradeRefresher.stop();
    // 销毁所有监控标的的 DelayedSignalVerifier
    for (const monitorContext of monitorContexts.values()) {
      monitorContext.delayedSignalVerifier.destroy();
    }
    // 清理 IndicatorCache
    indicatorCache.clearAll();
    // 释放快照对象
    releaseAllMonitorSnapshots(lastState.monitorStates);
  };

  /**
   * 注册退出处理函数
   */
  const registerExitHandlers = (): void => {
    process.once('SIGINT', () => {
      execute();
      process.exit(0);
    });
    process.once('SIGTERM', () => {
      execute();
      process.exit(0);
    });
  };

  return {
    execute,
    registerExitHandlers,
  };
};
