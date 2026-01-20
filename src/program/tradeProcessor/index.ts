/**
 * 交易处理器模块
 *
 * 功能：
 * - 消费 TradeTaskQueue 中的交易任务
 * - 使用 setImmediate 异步执行，不阻塞主循环
 * - 执行风险检查和订单提交
 * - 统一管理信号对象的生命周期（释放到对象池）
 *
 * 执行顺序：
 * 1. 从任务队列获取任务
 * 2. 获取监控上下文（行情、持仓数据）
 * 3. 执行风险检查
 * 4. 计算卖出数量（卖出信号）
 * 5. 提交订单执行
 * 6. 释放信号对象到对象池
 */

import { signalObjectPool } from '../../utils/objectPool/index.js';
import { logger } from '../../utils/logger/index.js';
import { formatError, formatSymbolDisplay } from '../../utils/helpers/index.js';
import type { ProcessorStats, TradeProcessor, TradeProcessorDeps } from './types.js';
import type { TradeTask } from '../tradeTaskQueue/types.js';
import type { RiskCheckContext } from '../../core/signalProcessor/types.js';

// 导出类型
export type { TradeProcessor, TradeProcessorDeps, ProcessorStats } from './types.js';

/**
 * 创建交易处理器
 * @param deps 依赖注入
 * @returns TradeProcessor 接口实例
 */
export const createTradeProcessor = (deps: TradeProcessorDeps): TradeProcessor => {
  const { taskQueue, getMonitorContext, signalProcessor, trader, doomsdayProtection, getLastState, getIsHalfDay } = deps;

  // 内部状态
  let running = false;
  let processedCount = 0;
  let successCount = 0;
  let failedCount = 0;
  let lastProcessTime: number | null = null;
  let immediateHandle: ReturnType<typeof setImmediate> | null = null;

  /**
   * 处理单个任务
   */
  const processTask = async (task: TradeTask): Promise<boolean> => {
    const signal = task.data;
    const monitorSymbol = task.monitorSymbol;
    // 缓存格式化后的标的显示（用于日志）
    const symbolDisplay = formatSymbolDisplay(signal.symbol, signal.symbolName ?? null);

    try {
      // 获取监控上下文
      const ctx = getMonitorContext(monitorSymbol);
      if (!ctx) {
        logger.warn(`[TradeProcessor] 无法获取监控上下文: ${formatSymbolDisplay(monitorSymbol, null)}`);
        return false;
      }

      const { config, state, orderRecorder, riskChecker } = ctx;

      // 获取行情数据（从 MonitorContext 缓存中获取，主循环每秒更新）
      // 注意：必须使用 ctx.longQuote/shortQuote/monitorQuote，这些字段每秒更新
      // 不能使用 state.longPrice/shortPrice，因为这些只在价格变化超过阈值时才更新
      const longQuote = ctx.longQuote;
      const shortQuote = ctx.shortQuote;
      const monitorQuote = ctx.monitorQuote;

      // 获取全局状态
      const lastState = getLastState();
      const isHalfDay = getIsHalfDay();

      // 获取持仓数据（从 positionCache 获取）
      const longPosition = lastState.positionCache.get(ctx.normalizedLongSymbol);
      const shortPosition = lastState.positionCache.get(ctx.normalizedShortSymbol);

      // 判断信号类型
      const isBuySignal = signal.action === 'BUYCALL' || signal.action === 'BUYPUT';
      const isSellSignal = signal.action === 'SELLCALL' || signal.action === 'SELLPUT';

      // 卖出信号：直接处理卖出数量计算（不经过风险检查）
      // 原因：
      // 1. 卖出操作的优先级高于买入，应优先允许执行
      // 2. checkBeforeOrder 对卖出信号基本是直接放行（只有持仓市值限制检查，但对卖出无意义）
      // 3. applyRiskChecks 的冷却期检查会阻止 10 秒内的重复卖出，不适用于卖出场景
      if (isSellSignal) {
        const processedSignals = signalProcessor.processSellSignals(
          [signal],
          longPosition,
          shortPosition,
          longQuote,
          shortQuote,
          orderRecorder,
          config.smartCloseEnabled,
        );

        // 如果信号被转为 HOLD，跳过执行
        const firstSignal = processedSignals[0];
        if (processedSignals.length === 0 || !firstSignal || firstSignal.action === 'HOLD') {
          logger.info(`[TradeProcessor] 卖出信号被跳过: ${symbolDisplay} ${signal.action}`);
          return true; // 处理成功（虽然跳过了）
        }
      }

      // 买入信号：执行风险检查
      if (isBuySignal) {
        // 构建风险检查上下文
        const riskCheckContext: RiskCheckContext = {
          trader,
          riskChecker,
          orderRecorder,
          longQuote,
          shortQuote,
          monitorQuote,
          monitorSnapshot: state.lastMonitorSnapshot,
          longSymbol: config.longSymbol,
          shortSymbol: config.shortSymbol,
          longSymbolName: ctx.longSymbolName,
          shortSymbolName: ctx.shortSymbolName,
          account: lastState.cachedAccount,
          positions: lastState.cachedPositions,
          lastState: {
            cachedAccount: lastState.cachedAccount,
            cachedPositions: lastState.cachedPositions,
            positionCache: lastState.positionCache,
          },
          currentTime: new Date(),
          isHalfDay,
          doomsdayProtection,
          config,
        };

        const checkedSignals = await signalProcessor.applyRiskChecks([signal], riskCheckContext);

        // 如果信号被风险检查拦截，跳过执行
        if (checkedSignals.length === 0) {
          logger.info(`[TradeProcessor] 买入信号被风险检查拦截: ${symbolDisplay} ${signal.action}`);
          return true; // 处理成功（虽然被拦截了）
        }
      }

      // 执行订单
      await trader.executeSignals([signal]);
      logger.info(`[TradeProcessor] 订单执行完成: ${symbolDisplay} ${signal.action}`);

      return true;
    } catch (err) {
      logger.error(`[TradeProcessor] 处理任务失败: ${symbolDisplay} ${signal.action}`, formatError(err));
      return false;
    }
  };

  /**
   * 处理队列中的所有任务
   */
  const processQueue = async (): Promise<void> => {
    while (!taskQueue.isEmpty()) {
      const task = taskQueue.pop();
      if (!task) break;

      const signal = task.data;

      try {
        processedCount++;
        const success = await processTask(task);

        if (success) {
          successCount++;
        } else {
          failedCount++;
        }

        lastProcessTime = Date.now();
      } finally {
        // 统一在 finally 块释放信号对象到对象池
        signalObjectPool.release(signal);
      }
    }
  };

  /**
   * 调度下一次处理（使用 setImmediate）
   *
   * 设计说明：
   * - 队列有任务时：立即处理并在完成后继续调度
   * - 队列为空时：停止调度，等待 onTaskAdded 回调触发重新调度
   * - 避免忙等待（busy-waiting），防止 CPU 高占用
   */
  const scheduleNextProcess = (): void => {
    if (!running) return;

    // 如果队列为空，停止调度（等待新任务触发）
    if (taskQueue.isEmpty()) {
      immediateHandle = null;
      return;
    }

    immediateHandle = setImmediate(() => {
      if (!running) return;

      if (!taskQueue.isEmpty()) {
        processQueue()
          .catch((err) => {
            logger.error('[TradeProcessor] 处理队列时发生错误', formatError(err));
          })
          .finally(() => {
            scheduleNextProcess();
          });
      } else {
        // 队列已空，停止调度（等待 onTaskAdded 回调触发重新调度）
        immediateHandle = null;
      }
    });
  };

  /**
   * 启动处理器
   */
  const start = (): void => {
    if (running) {
      logger.warn('[TradeProcessor] 处理器已在运行中');
      return;
    }

    running = true;

    // 注册任务添加回调，有新任务时触发处理
    taskQueue.onTaskAdded(() => {
      if (running && immediateHandle === null) {
        scheduleNextProcess();
      }
    });

    // 启动调度循环
    scheduleNextProcess();
  };

  /**
   * 停止处理器
   */
  const stop = (): void => {
    if (!running) {
      logger.warn('[TradeProcessor] 处理器未在运行');
      return;
    }

    running = false;

    if (immediateHandle !== null) {
      clearImmediate(immediateHandle);
      immediateHandle = null;
    }

    logger.info('[TradeProcessor] 处理器已停止');
  };

  /**
   * 立即处理队列中的所有任务（同步等待完成）
   */
  const processNow = async (): Promise<void> => {
    await processQueue();
  };

  /**
   * 检查处理器是否正在运行
   */
  const isRunning = (): boolean => running;

  /**
   * 获取处理器统计信息
   */
  const getStats = (): ProcessorStats => ({
    processedCount,
    successCount,
    failedCount,
    lastProcessTime,
  });

  return {
    start,
    stop,
    processNow,
    isRunning,
    getStats,
  };
};
