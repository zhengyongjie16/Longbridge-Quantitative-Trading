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
import { formatError } from '../../utils/helpers/index.js';
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
  let isExiting = false;

  /**
   * 执行清理（stopAndDrain 确保 in-flight 任务排空）
   */
  async function execute(): Promise<void> {
    logger.info('Program exiting, cleaning up resources...');
    const failures: Array<{ readonly step: string; readonly error: unknown }> = [];

    const runStep = async (
      step: string,
      handler: () => Promise<void> | void,
    ): Promise<void> => {
      try {
        await handler();
      } catch (err) {
        failures.push({ step, error: err });
        logger.error(`[Cleanup] ${step} 失败: ${formatError(err)}`);
      }
    };

    await runStep('停止 BuyProcessor', async () => {
      await buyProcessor.stopAndDrain();
    });
    await runStep('停止 SellProcessor', async () => {
      await sellProcessor.stopAndDrain();
    });
    await runStep('停止 MonitorTaskProcessor', async () => {
      await monitorTaskProcessor.stopAndDrain();
    });
    await runStep('停止 OrderMonitorWorker', async () => {
      await orderMonitorWorker.stopAndDrain();
    });
    await runStep('停止 PostTradeRefresher', async () => {
      await postTradeRefresher.stopAndDrain();
    });
    for (const [monitorSymbol, monitorContext] of monitorContexts) {
      await runStep(`销毁延迟验证器 ${monitorSymbol}`, () => {
        monitorContext.delayedSignalVerifier.destroy();
      });
    }
    await runStep('清空指标缓存', () => {
      indicatorCache.clearAll();
    });
    await runStep('释放监控快照对象', () => {
      releaseAllMonitorSnapshots(lastState.monitorStates);
    });

    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((item) => item.error),
        `[Cleanup] 资源清理失败，共 ${failures.length} 处`,
      );
    }
  }

  /**
   * 注册退出处理函数
   */
  function registerExitHandlers(): void {
    const handler = (): void => {
      if (isExiting) {
        return;
      }
      isExiting = true;
      void execute()
        .then(() => {
          process.exit(0);
        })
        .catch((err) => {
          logger.error('[Cleanup] 程序退出清理失败', formatError(err));
          process.exit(1);
        });
    };
    process.once('SIGINT', handler);
    process.once('SIGTERM', handler);
  }

  return {
    execute,
    registerExitHandlers,
  };
}
