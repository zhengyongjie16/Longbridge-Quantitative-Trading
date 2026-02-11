/**
 * asyncProgram 模块工具函数
 *
 * 职责：
 * - 提供买入/卖出处理器的公共生命周期逻辑（createBaseProcessor）
 */
import { logger } from '../../utils/logger/index.js';
import { formatError } from '../../utils/helpers/index.js';
import type { BaseProcessorConfig, Processor } from './types.js';

/**
 * 创建基础任务处理器
 *
 * 封装 processQueue、scheduleNextProcess、start、stop 的公共逻辑，
 * 供买入处理器和卖出处理器复用。
 *
 * @param config 处理器配置
 * @returns 实现 Processor 接口的处理器实例
 */
export function createBaseProcessor<TType extends string>(
  config: BaseProcessorConfig<TType>,
): Processor {
  const { loggerPrefix, taskQueue, processTask, releaseAfterProcess, getCanProcessTask } = config;

  let running = false;
  let immediateHandle: ReturnType<typeof setImmediate> | null = null;
  let inFlightPromise: Promise<void> | null = null;
  let taskAddedUnregister: (() => void) | null = null;

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

  function handleTaskAdded(): void {
    if (running && immediateHandle === null) {
      scheduleNextProcess();
    }
  }

  function start(): void {
    if (running) {
      logger.warn(`[${loggerPrefix}] 处理器已在运行中`);
      return;
    }

    running = true;
    taskAddedUnregister = taskQueue.onTaskAdded(handleTaskAdded);

    scheduleNextProcess();
  }

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
