/**
 * 程序退出清理模块
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
