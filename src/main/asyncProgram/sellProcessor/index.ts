/**
 * 卖出处理器模块
 *
 * 功能：
 * - 消费 SellTaskQueue 中的卖出任务
 * - 使用 setImmediate 异步执行，不阻塞主循环
 * - 卖出信号不经过风险检查，直接计算卖出数量并执行
 * - 统一管理信号对象的生命周期（释放到对象池）
 *
 * 设计原因：
 * - 卖出操作的优先级高于买入，应优先允许执行
 * - 卖出信号不需要 API 调用的风险检查，执行路径更短
 * - 独立队列避免被买入任务阻塞
 *
 * 执行顺序：
 * 1. 从队列获取任务
 * 2. 获取监控上下文（行情、持仓数据）
 * 3. 调用 signalProcessor.processSellSignals() 计算卖出数量
 * 4. 如果信号未被转为 HOLD，执行 trader.executeSignals()
 * 5. 释放信号对象到对象池
 */
import { signalObjectPool } from '../../../utils/objectPool/index.js';
import { logger } from '../../../utils/logger/index.js';
import { formatError, formatSymbolDisplay } from '../../../utils/helpers/index.js';
import { isSeatReady, isSeatVersionMatch } from '../../../services/autoSymbolManager/utils.js';
import type { SellProcessor, SellProcessorDeps } from './types.js';
import type { SellTask } from '../tradeTaskQueue/types.js';

/**
 * 创建卖出处理器
 * @param deps 依赖注入
 * @returns SellProcessor 接口实例
 */
export function createSellProcessor(deps: SellProcessorDeps): SellProcessor {
  const { taskQueue, getMonitorContext, signalProcessor, trader, getLastState, refreshGate } = deps;

  // 内部状态
  let running = false;
  let immediateHandle: ReturnType<typeof setImmediate> | null = null;

  /**
   * 处理单个卖出任务
   */
  async function processTask(task: SellTask): Promise<boolean> {
    const { data: signal, monitorSymbol } = task;
    const symbolDisplay = formatSymbolDisplay(signal.symbol, signal.symbolName ?? null);

    try {
      await refreshGate.waitForFresh();
      // 获取监控上下文
      const ctx = getMonitorContext(monitorSymbol);
      if (!ctx) {
        logger.warn(`[SellProcessor] 无法获取监控上下文: ${formatSymbolDisplay(monitorSymbol, null)}`);
        return false;
      }

      // 注意：longQuote/shortQuote 必须来自 ctx（每秒更新）
      const { config, orderRecorder, longQuote, shortQuote, symbolRegistry } = ctx;
      const lastState = getLastState();

      const isLongSignal = signal.action === 'SELLCALL';
      const direction = isLongSignal ? 'LONG' : 'SHORT';
      const seatState = symbolRegistry.getSeatState(monitorSymbol, direction);
      const seatVersion = symbolRegistry.getSeatVersion(monitorSymbol, direction);

      if (!isSeatReady(seatState)) {
        logger.info(`[SellProcessor] 席位不可用，跳过信号: ${symbolDisplay} ${signal.action}`);
        return true;
      }
      if (!isSeatVersionMatch(signal.seatVersion, seatVersion)) {
        logger.info(`[SellProcessor] 席位版本不匹配，跳过信号: ${symbolDisplay} ${signal.action}`);
        return true;
      }
      if (signal.symbol !== seatState.symbol) {
        logger.info(`[SellProcessor] 标的已切换，跳过信号: ${symbolDisplay} ${signal.action}`);
        return true;
      }

      // 获取持仓数据（从 positionCache 获取）
      const longSeatState = symbolRegistry.getSeatState(monitorSymbol, 'LONG');
      const shortSeatState = symbolRegistry.getSeatState(monitorSymbol, 'SHORT');
      const longPosition = isSeatReady(longSeatState)
        ? lastState.positionCache.get(longSeatState.symbol)
        : null;
      const shortPosition = isSeatReady(shortSeatState)
        ? lastState.positionCache.get(shortSeatState.symbol)
        : null;

      // 卖出信号处理：计算卖出数量（不经过风险检查）
      // 原因：
      // 1. 卖出操作的优先级高于买入，应优先允许执行
      // 2. checkBeforeOrder 对卖出信号基本是直接放行（只有持仓市值限制检查，但对卖出无意义）
      // 3. applyRiskChecks 的冷却期检查会阻止 10 秒内的重复卖出，不适用于卖出场景
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
      if (!firstSignal || firstSignal.action === 'HOLD') {
        logger.info(`[SellProcessor] 卖出信号被跳过: ${symbolDisplay} ${signal.action}`);
        return true; // 处理成功（虽然跳过了）
      }

      // 执行卖出订单
      await trader.executeSignals([signal]);
      logger.info(`[SellProcessor] 卖出订单执行完成: ${symbolDisplay} ${signal.action}`);

      return true;
    } catch (err) {
      logger.error(`[SellProcessor] 处理任务失败: ${symbolDisplay} ${signal.action}`, formatError(err));
      return false;
    }
  }

  /**
   * 处理队列中的所有任务
   */
  async function processQueue(): Promise<void> {
    while (!taskQueue.isEmpty()) {
      const task = taskQueue.pop();
      if (!task) break;

      const { data: signal } = task;

      try {
        await processTask(task);
      } finally {
        // 统一在 finally 块释放信号对象到对象池
        signalObjectPool.release(signal);
      }
    }
  }

  /**
   * 调度下一次处理（使用 setImmediate）
   *
   * 设计说明：
   * - 队列有任务时：立即处理并在完成后继续调度
   * - 队列为空时：停止调度，等待 onTaskAdded 回调触发重新调度
   * - 避免忙等待（busy-waiting），防止 CPU 高占用
   */
  function scheduleNextProcess(): void {
    if (!running) return;

    // 如果队列为空，停止调度（等待新任务触发）
    if (taskQueue.isEmpty()) {
      immediateHandle = null;
      return;
    }

    immediateHandle = setImmediate(() => {
      if (!running) return;

      if (taskQueue.isEmpty()) {
        // 队列已空，停止调度（等待 onTaskAdded 回调触发重新调度）
        immediateHandle = null;
      } else {
        processQueue()
          .catch((err) => {
            logger.error('[SellProcessor] 处理队列时发生错误', formatError(err));
          })
          .finally(() => {
            scheduleNextProcess();
          });
      }
    });
  }

  /**
   * 启动处理器
   */
  function start(): void {
    if (running) {
      logger.warn('[SellProcessor] 处理器已在运行中');
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
  }

  /**
   * 停止处理器
   */
  function stop(): void {
    if (!running) {
      logger.warn('[SellProcessor] 处理器未在运行');
      return;
    }

    running = false;

    if (immediateHandle !== null) {
      clearImmediate(immediateHandle);
      immediateHandle = null;
    }
  }

  return {
    start,
    stop,
  };
}
