import { logger } from '../../utils/logger/index.js';
import type { BaseProcessorConfig, Processor } from './types.js';
import type { TaskAddedCallback } from './tradeTaskQueue/types.js';
import type { Trader } from '../../types/services.js';
import type { Signal } from '../../types/signal.js';
import { formatError } from '../../utils/error/index.js';

/**
 * 在生命周期门禁通过时执行信号并记录成功日志；门禁关闭时仅打日志并返回 true（视为跳过）。
 * 调用方负责 catch 异常并打错误日志、返回 false。
 *
 * @param params 参数（getCanProcessTask、trader、signal、symbolDisplay、loggerPrefix、successMessage）
 * @returns 门禁关闭或执行成功时返回 true；trader.executeSignals 抛错时由调用方捕获
 */
/* eslint-disable sonarjs/no-invariant-returns -- 门禁跳过与执行成功均返回 true，仅异常时由调用方返回 false */
export async function executeSignalsWithLifecycleGate(params: {
  readonly getCanProcessTask?: (() => boolean) | undefined;
  readonly trader: Trader;
  readonly signal: Signal;
  readonly symbolDisplay: string;
  readonly loggerPrefix: string;
  readonly successMessage: string;
}): Promise<boolean> {
  const {
    getCanProcessTask,
    trader,
    signal,
    symbolDisplay,
    loggerPrefix,
    successMessage,
  } = params;
  if (getCanProcessTask !== undefined && !getCanProcessTask()) {
    logger.info(
      `[${loggerPrefix}] 生命周期门禁关闭，放弃执行: ${symbolDisplay} ${signal.action}`,
    );
    return true;
  }
  await trader.executeSignals([signal]);
  logger.info(`[${loggerPrefix}] ${successMessage}: ${symbolDisplay} ${signal.action}`);
  return true; // 门禁跳过与执行成功均返回 true，仅抛错时由调用方 catch 返回 false
}

/**
 * 记录处理器任务失败日志。供 buyProcessor/sellProcessor 在 catch 中统一调用。
 *
 * @param loggerPrefix 日志前缀（如 BuyProcessor、SellProcessor）
 * @param symbolDisplay 标的展示名
 * @param action 信号动作
 * @param err 异常对象
 * @returns 无返回值
 */
export function logProcessorTaskFailure(
  loggerPrefix: string,
  symbolDisplay: string,
  action: string,
  err: unknown,
): void {
  logger.error(
    `[${loggerPrefix}] 处理任务失败: ${symbolDisplay} ${action}`,
    formatError(err),
  );
}

/**
 * 在处理器运行且当前无待执行调度时触发下一轮调度。默认行为：不满足条件时不做任何操作。
 *
 * @param running 处理器是否处于运行态
 * @param immediateHandle 当前是否已有待执行 setImmediate 句柄
 * @param scheduleNextProcess 下一轮调度函数
 * @returns 无返回值
 */
export function scheduleWhenTaskAdded(
  running: boolean,
  immediateHandle: ReturnType<typeof setImmediate> | null,
  scheduleNextProcess: () => void,
): void {
  if (running && immediateHandle === null) {
    scheduleNextProcess();
  }
}

/**
 * 通知所有任务入队回调。默认行为：回调列表为空时不执行任何操作。
 *
 * @param callbacks 已注册回调列表
 * @returns 无返回值
 */
export function notifyTaskAddedCallbacks(callbacks: ReadonlyArray<TaskAddedCallback>): void {
  for (const callback of callbacks) {
    callback();
  }
}

/**
 * 注册任务入队回调并返回注销函数。默认行为：若回调已不存在，注销函数无副作用。
 *
 * @param callbacks 回调存储数组
 * @param callback 待注册回调
 * @returns 注销函数
 */
export function registerTaskAddedCallback(
  callbacks: TaskAddedCallback[],
  callback: TaskAddedCallback,
): () => void {
  callbacks.push(callback);
  return () => {
    const idx = callbacks.indexOf(callback);
    if (idx !== -1) {
      callbacks.splice(idx, 1);
    }
  };
}

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
   * @returns 无返回值
   */
  async function processQueue(): Promise<void> {
    while (running && !taskQueue.isEmpty()) {
      const task = taskQueue.pop();
      if (!task) break;
      const signal = task.data;
      const canProcess = getCanProcessTask ? getCanProcessTask() : true;
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
   * @returns 无返回值
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
          .catch((err: unknown) => {
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
   * 启动处理器，注册任务入队回调并立即调度一次队列处理
   * @returns 无返回值
   */
  function start(): void {
    if (running) {
      logger.warn(`[${loggerPrefix}] 处理器已在运行中`);
      return;
    }
    running = true;
    taskAddedUnregister = taskQueue.onTaskAdded(() => {
      scheduleWhenTaskAdded(running, immediateHandle, scheduleNextProcess);
    });
    scheduleNextProcess();
  }

  /**
   * 停止处理器，注销任务入队回调并取消待执行的 setImmediate
   * 不等待在途任务完成，如需等待请使用 stopAndDrain
   * @returns 无返回值
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
   * @returns 无返回值
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
   * @returns 无返回值
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
