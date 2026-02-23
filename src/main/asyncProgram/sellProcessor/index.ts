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
import { createBaseProcessor } from '../utils.js';
import { logger } from '../../../utils/logger/index.js';
import { formatError, formatSymbolDisplay } from '../../../utils/helpers/index.js';
import {
  isSeatReady,
  isSeatVersionMatch,
  describeSeatUnavailable,
} from '../../../services/autoSymbolManager/utils.js';
import type { Processor } from '../types.js';
import type { SellProcessorDeps } from './types.js';
import type { Task, SellTaskType } from '../tradeTaskQueue/types.js';

/**
 * 创建卖出处理器。
 * 消费 SellTaskQueue 中的卖出任务，经 RefreshGate 等待缓存刷新后计算卖出数量并执行；独立于买入处理器，保证卖出优先、不被风险检查阻塞。
 *
 * @param deps 依赖注入（任务队列、getMonitorContext、signalProcessor、trader、getLastState、refreshGate、可选 getCanProcessTask）
 * @returns 实现 Processor 接口的卖出处理器实例（start/stop/stopAndDrain/restart）
 */
export function createSellProcessor(deps: SellProcessorDeps): Processor {
  const {
    taskQueue,
    getMonitorContext,
    signalProcessor,
    trader,
    getLastState,
    refreshGate,
    getCanProcessTask,
  } = deps;

  /**
   * 处理单个卖出任务
   */
  async function processTask(task: Task<SellTaskType>): Promise<boolean> {
    const { data: signal, monitorSymbol } = task;
    const symbolDisplay = formatSymbolDisplay(signal.symbol, signal.symbolName ?? null);

    try {
      await refreshGate.waitForFresh();
      // 获取监控上下文
      const ctx = getMonitorContext(monitorSymbol);
      if (!ctx) {
        logger.warn(
          `[SellProcessor] 无法获取监控上下文: ${formatSymbolDisplay(monitorSymbol, null)}`,
        );
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
        logger.info(
          `[SellProcessor] ${describeSeatUnavailable(seatState)}，跳过信号: ${symbolDisplay} ${signal.action}`,
        );
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

      // 二次门禁：避免跨日门禁切换期间在途任务继续下单
      if (getCanProcessTask && !getCanProcessTask()) {
        logger.info(
          `[SellProcessor] 生命周期门禁关闭，放弃执行: ${symbolDisplay} ${signal.action}`,
        );
        return true;
      }

      // 执行卖出订单
      await trader.executeSignals([signal]);
      logger.info(`[SellProcessor] 卖出订单执行完成: ${symbolDisplay} ${signal.action}`);

      return true;
    } catch (err) {
      logger.error(
        `[SellProcessor] 处理任务失败: ${symbolDisplay} ${signal.action}`,
        formatError(err),
      );
      return false;
    }
  }

  return createBaseProcessor({
    loggerPrefix: 'SellProcessor',
    taskQueue,
    processTask,
    releaseAfterProcess: (signal) => { signalObjectPool.release(signal); },
    ...(getCanProcessTask ? { getCanProcessTask } : {}),
  });
}
