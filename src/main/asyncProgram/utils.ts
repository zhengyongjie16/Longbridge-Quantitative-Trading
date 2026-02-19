import { logger } from '../../utils/logger/index.js';
import { formatError } from '../../utils/helpers/index.js';
import type { BaseProcessorConfig, Processor } from './types.js';

/**
 * 创建基础任务处理器。
 * 封装 processQueue、scheduleNextProcess、start、stop、stopAndDrain、restart 的公共逻辑，
 * 供买入处理器和卖出处理器复用；门禁关闭时仅释放信号不执行业务逻辑。
 *
 * @param config 处理器配置（loggerPrefix、taskQueue、processTask、releaseAfterProcess、可选 getCanProcessTask）
 * @returns 实现 Processor 接口的处理器实例（start、stop、stopAndDrain、restart）
 */
export function createBaseProcessor<TType extends string>(
  config: BaseProcessorConfig<TType>,
): Processor {
  const { loggerPrefix, taskQueue, processTask, releaseAfterProcess, getCanProcessTask } = config;

  let running = false;
  let immediateHandle: ReturnType<typeof setImmediate> | null = null;
  let inFlightPromise: Promise<void> | null = null;
  let taskAddedUnregister: (() => void) | null = null;

  /**
   * 循环消费队列中的任务，直到队列为空或处理器停止
   * 门禁关闭时仅释放信号，不执行业务逻辑
   */
  async function processQueue(): Promise<void> {
    while (running && !taskQueue.isEmpty()) {
      const task = taskQueue.pop();
      if (!task) break;

      const signal = task.data;

      const canProcess = running && (getCanProcessTask ? getCanProcessTask() : true);
      if (!canProcess) {
        releaseAfterProcess(signal);
        continue;
      }

      try {
        await processTask(task);
      } finally {
        releaseAfterProcess(signal);
      }
    }
  }

  /**
   * 通过 setImmediate 调度下一次队列处理，避免阻塞事件循环
   * 队列为空时不调度，等待 onTaskAdded 回调触发
   */
  function scheduleNextProcess(): void {
    if (!running) return;

    if (taskQueue.isEmpty()) {
      immediateHandle = null;
      return;
    }

    immediateHandle = setImmediate(() => {
      if (!running) return;

      if (taskQueue.isEmpty()) {
        immediateHandle = null;
      } else {
        inFlightPromise = processQueue()
          .catch((err) => {
            logger.error(`[${loggerPrefix}] 处理队列时发生错误`, formatError(err));
          })
          .finally(() => {
            inFlightPromise = null;
            scheduleNextProcess();
          });
      }
    });
  }

  /**
   * 任务入队回调：仅在处理器运行且无待执行调度时触发调度
   */
  function handleTaskAdded(): void {
    if (running && immediateHandle === null) {
      scheduleNextProcess();
    }
  }

  /**
   * 启动处理器，注册任务入队回调并立即调度一次队列处理
   */
  function start(): void {
    if (running) {
      logger.warn(`[${loggerPrefix}] 处理器已在运行中`);
      return;
    }

    running = true;
    taskAddedUnregister = taskQueue.onTaskAdded(handleTaskAdded);

    scheduleNextProcess();
  }

  /**
   * 停止处理器，注销任务入队回调并取消待执行的 setImmediate
   * 不等待在途任务完成，如需等待请使用 stopAndDrain
   */
  function stop(): void {
    if (!running) {
      logger.warn(`[${loggerPrefix}] 处理器未在运行`);
      return;
    }

    running = false;
    taskAddedUnregister?.();
    taskAddedUnregister = null;

    if (immediateHandle !== null) {
      clearImmediate(immediateHandle);
      immediateHandle = null;
    }
  }

  /**
   * 停止处理器并等待当前在途任务完成，确保优雅退出
   */
  async function stopAndDrain(): Promise<void> {
    running = false;
    taskAddedUnregister?.();
    taskAddedUnregister = null;

    if (immediateHandle !== null) {
      clearImmediate(immediateHandle);
      immediateHandle = null;
    }

    if (inFlightPromise !== null) {
      await inFlightPromise;
    }
  }

  /**
   * 重启处理器：先 stop 再 start，用于跨日重置等生命周期场景
   */
  function restart(): void {
    if (running) {
      stop();
    }
    start();
  }

  return {
    start,
    stop,
    stopAndDrain,
    restart,
  };
}
