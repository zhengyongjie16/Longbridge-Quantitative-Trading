/**
 * 买入处理器模块
 *
 * 功能：
 * - 消费 BuyTaskQueue 中的买入任务
 * - 使用 setImmediate 异步执行，不阻塞主循环
 * - 执行风险检查和订单提交
 * - 统一管理信号对象的生命周期（释放到对象池）
 *
 * 注意：卖出信号由独立的 SellProcessor 处理，以避免被买入风险检查阻塞
 *
 * 执行顺序：
 * 1. 从任务队列获取任务
 * 2. 获取监控上下文（行情、持仓数据）
 * 3. 执行风险检查（买入信号需要 API 调用）
 * 4. 提交订单执行
 * 5. 释放信号对象到对象池
 */
import { signalObjectPool } from '../../../utils/objectPool/index.js';
import { createBaseProcessor } from '../utils.js';
import { logger } from '../../../utils/logger/index.js';
import { formatError, formatSymbolDisplay, isBuyAction } from '../../../utils/helpers/index.js';
import { isSeatReady, isSeatVersionMatch } from '../../../services/autoSymbolManager/utils.js';
import type { Processor } from '../types.js';
import type { BuyProcessorDeps } from './types.js';
import type { BuyTask } from '../tradeTaskQueue/types.js';
import type { RiskCheckContext } from '../../../types/index.js';

/**
 * 创建买入处理器
 * @param deps 依赖注入
 * @returns 实现 Processor 接口的买入处理器实例
 */
export function createBuyProcessor(deps: BuyProcessorDeps): Processor {
  const { taskQueue, getMonitorContext, signalProcessor, trader, doomsdayProtection, getLastState, getIsHalfDay } = deps;

  /**
   * 处理单个买入任务
   * 注意：卖出信号由 SellProcessor 处理，此处只处理买入信号
   */
  async function processTask(task: BuyTask): Promise<boolean> {
    const signal = task.data;
    const monitorSymbol = task.monitorSymbol;
    // 缓存格式化后的标的显示（用于日志）
    const symbolDisplay = formatSymbolDisplay(signal.symbol, signal.symbolName ?? null);

    try {
      // 验证信号类型：此处理器只处理买入信号
      const isBuySignal = isBuyAction(signal.action);
      if (!isBuySignal) {
        logger.warn(`[BuyProcessor] 收到非买入信号，跳过: ${symbolDisplay} ${signal.action}`);
        return true; // 非预期信号，但不算失败
      }

      // 获取监控上下文
      const ctx = getMonitorContext(monitorSymbol);
      if (!ctx) {
        logger.warn(`[BuyProcessor] 无法获取监控上下文: ${formatSymbolDisplay(monitorSymbol, null)}`);
        return false;
      }

      const { config, state, orderRecorder, riskChecker } = ctx;

      // 获取行情数据（从 MonitorContext 缓存中获取，主循环每秒更新）
      // 注意：必须使用 ctx.longQuote/shortQuote/monitorQuote，这些字段每秒更新
      // 不能使用 state.longPrice/shortPrice，因为这些只在价格变化超过阈值时才更新
      const longQuote = ctx.longQuote;
      const shortQuote = ctx.shortQuote;
      const monitorQuote = ctx.monitorQuote;

      const isLongSignal = signal.action === 'BUYCALL';
      const direction = isLongSignal ? 'LONG' : 'SHORT';
      const seatState = ctx.symbolRegistry.getSeatState(monitorSymbol, direction);
      const seatVersion = ctx.symbolRegistry.getSeatVersion(monitorSymbol, direction);

      if (!isSeatReady(seatState)) {
        logger.info(`[BuyProcessor] 席位不可用，跳过信号: ${symbolDisplay} ${signal.action}`);
        return true;
      }
      if (!isSeatVersionMatch(signal.seatVersion, seatVersion)) {
        logger.info(`[BuyProcessor] 席位版本不匹配，跳过信号: ${symbolDisplay} ${signal.action}`);
        return true;
      }
      if (signal.symbol !== seatState.symbol) {
        logger.info(`[BuyProcessor] 标的已切换，跳过信号: ${symbolDisplay} ${signal.action}`);
        return true;
      }

      // 获取全局状态
      const lastState = getLastState();
      const isHalfDay = getIsHalfDay();

      // 买入信号：执行风险检查（需要 API 调用获取最新账户和持仓）
      // 构建风险检查上下文
      const longSeatState = ctx.symbolRegistry.getSeatState(monitorSymbol, 'LONG');
      const shortSeatState = ctx.symbolRegistry.getSeatState(monitorSymbol, 'SHORT');
      const longSymbol = isSeatReady(longSeatState) ? longSeatState.symbol : '';
      const shortSymbol = isSeatReady(shortSeatState) ? shortSeatState.symbol : '';

      const riskCheckContext: RiskCheckContext = {
        trader,
        riskChecker,
        orderRecorder,
        longQuote,
        shortQuote,
        monitorQuote,
        monitorSnapshot: state.lastMonitorSnapshot,
        longSymbol,
        shortSymbol,
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
        const rejectReason = signal.reason?.trim();
        const reasonSuffix = rejectReason ? ` - ${rejectReason}` : '';
        logger.info(
          `[BuyProcessor] 买入信号被风险检查拦截: ${symbolDisplay} ${signal.action}${reasonSuffix}`,
        );
        return true; // 处理成功（虽然被拦截了）
      }

      // 执行买入订单
      await trader.executeSignals([signal]);
      logger.info(`[BuyProcessor] 买入订单执行完成: ${symbolDisplay} ${signal.action}`);

      return true;
    } catch (err) {
      logger.error(`[BuyProcessor] 处理任务失败: ${symbolDisplay} ${signal.action}`, formatError(err));
      return false;
    }
  }

  return createBaseProcessor({
    loggerPrefix: 'BuyProcessor',
    taskQueue,
    processTask,
    releaseAfterProcess: (signal) => signalObjectPool.release(signal),
  });
}
