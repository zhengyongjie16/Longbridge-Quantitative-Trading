/**
 * 订单执行模块
 *
 * 职责：
 * - 执行交易信号（BUYCALL/SELLCALL/BUYPUT/SELLPUT）
 * - 管理同方向买入频率限制（防止重复开仓）
 * - 协调订单提交流程与追踪登记
 */
import { logger } from '../../../utils/logger/index.js';
import { LOG_COLORS } from '../../../constants/index.js';
import { formatSymbolDisplay } from '../../../utils/display/index.js';
import { isSeatVersionMatch } from '../../../utils/seat/guards.js';
import type { MonitorConfig } from '../../../types/config.js';
import type { Signal } from '../../../types/signal.js';
import type { OrderExecutor, OrderExecutorDeps } from '../types.js';
import { createSubmitTargetOrder } from './submitFlow.js';
import { createBuyThrottle } from './buyThrottle.js';
import {
  getActionDescription,
  isLiquidationSignal,
  isStaleCrossDaySignal,
  resolveOrderSide,
} from './utils.js';

/**
 * 创建订单执行器（核心业务流程：信号执行与订单提交）。
 *
 * @param deps 依赖注入（ctxPromise、rateLimiter、cacheManager、orderMonitor、orderRecorder、tradingConfig、symbolRegistry、isExecutionAllowed）
 * @returns OrderExecutor 接口实例
 */
export function createOrderExecutor(deps: OrderExecutorDeps): OrderExecutor {
  const {
    ctxPromise,
    rateLimiter,
    cacheManager,
    orderMonitor,
    orderRecorder,
    tradingConfig,
    symbolRegistry,
    isExecutionAllowed,
  } = deps;
  const { global, monitors } = tradingConfig;

  /**
   * 通过信号标的解析监控配置与方向，未找到时返回 null。
   *
   * @param signalSymbol 信号标的
   * @returns 监控配置与方向信息
   */
  function resolveMonitorConfigBySymbol(
    signalSymbol: string,
  ): { monitorConfig: MonitorConfig; isShortSymbol: boolean; seatVersion: number } | null {
    const resolvedSeat = symbolRegistry.resolveSeatBySymbol(signalSymbol);
    if (!resolvedSeat) {
      logger.warn(`[订单执行] 未找到席位标的，跳过信号: ${signalSymbol}`);
      return null;
    }

    const monitorConfig = monitors.find(
      (config) => config.monitorSymbol === resolvedSeat.monitorSymbol,
    );
    if (!monitorConfig) {
      logger.warn(`[订单执行] 未找到监控配置，跳过信号: ${signalSymbol}`);
      return null;
    }

    return {
      monitorConfig,
      isShortSymbol: resolvedSeat.direction === 'SHORT',
      seatVersion: resolvedSeat.seatVersion,
    };
  }

  /**
   * 校验信号携带的席位版本是否与执行时席位版本一致。
   * 仅当信号携带有限 seatVersion 时启用该校验；未携带 seatVersion 的信号沿用原流程。
   *
   * @param signal 信号对象
   * @param currentSeatVersion 当前席位版本号
   * @returns true 表示通过校验，false 表示应跳过
   */
  function validateSignalSeatVersionAtExecution(
    signal: Signal,
    currentSeatVersion: number,
  ): boolean {
    if (!Number.isFinite(signal.seatVersion)) {
      return true;
    }

    if (!isSeatVersionMatch(signal.seatVersion, currentSeatVersion)) {
      logger.debug(
        `[执行门禁] 席位版本不匹配，跳过信号: ${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)} ${signal.action}`,
      );
      return false;
    }

    return true;
  }

  /**
   * 检查执行门禁。
   *
   * @param signal 信号
   * @param stage 阶段标识
   * @returns true 表示允许继续执行
   */
  function canExecuteSignal(signal: Signal, stage: string): boolean {
    if (isExecutionAllowed()) {
      return true;
    }

    logger.debug(
      `[执行门禁] ${stage} 门禁关闭，跳过信号: ${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)} ${signal.action}`,
    );
    return false;
  }

  const buyThrottle = createBuyThrottle();

  const submitTargetOrder = createSubmitTargetOrder({
    rateLimiter,
    cacheManager,
    orderMonitor,
    orderRecorder,
    globalConfig: global,
    canExecuteSignal,
    recordBuyAttempt: buyThrottle.recordBuyAttempt,
  });

  /**
   * 执行交易信号，返回实际提交数量与订单 ID 列表。
   *
   * @param signals 待执行信号
   * @returns 提交统计
   */
  async function executeSignals(
    signals: Signal[],
  ): Promise<{ submittedCount: number; submittedOrderIds: ReadonlyArray<string> }> {
    if (!isExecutionAllowed()) {
      logger.debug('[执行门禁] 门禁关闭，跳过本次下单，不提交任何订单');
      return { submittedCount: 0, submittedOrderIds: [] };
    }

    const ctx = await ctxPromise;
    let submittedCount = 0;
    const submittedOrderIds: string[] = [];

    for (const signal of signals) {
      if (!signal.symbol || typeof signal.symbol !== 'string') {
        logger.warn(`[跳过信号] 信号缺少有效的标的代码: ${JSON.stringify(signal)}`);
        continue;
      }

      const signalSymbolDisplay = formatSymbolDisplay(signal.symbol, signal.symbolName ?? null);

      if (signal.action === 'HOLD') {
        const holdReason =
          signal.reason === null || signal.reason === undefined || signal.reason === ''
            ? '持有'
            : signal.reason;
        logger.info(`[HOLD] ${signalSymbolDisplay} - ${holdReason}`);
        continue;
      }

      if (!isLiquidationSignal(signal) && isStaleCrossDaySignal(signal, new Date())) {
        logger.debug(
          `[执行门禁] 跨日或触发时间无效信号，跳过执行: ${signalSymbolDisplay} ${signal.action}`,
        );
        continue;
      }

      if (!isExecutionAllowed()) {
        logger.debug(`[执行门禁] 门禁已关闭，跳过信号: ${signalSymbolDisplay} ${signal.action}`);
        continue;
      }

      const side = resolveOrderSide(signal.action);
      if (!side) {
        logger.warn(`[跳过信号] 未知的信号类型: ${signal.action}, 标的: ${signalSymbolDisplay}`);
        continue;
      }

      const resolved = resolveMonitorConfigBySymbol(signal.symbol);
      if (!resolved) {
        logger.warn(`[跳过信号] 无法找到信号标的 ${signalSymbolDisplay} 对应的监控配置`);
        continue;
      }

      const { monitorConfig, isShortSymbol, seatVersion } = resolved;
      if (!validateSignalSeatVersionAtExecution(signal, seatVersion)) {
        continue;
      }

      const actualAction = getActionDescription(signal.action);
      const symbolDisplay = formatSymbolDisplay(signal.symbol, signal.symbolName);
      const planReason =
        signal.reason === null || signal.reason === undefined || signal.reason === ''
          ? '策略信号'
          : signal.reason;
      logger.info(
        `${LOG_COLORS.green}[交易计划] ${actualAction} ${symbolDisplay} - ${planReason}${LOG_COLORS.reset}`,
      );

      const submittedOrderId = await submitTargetOrder(
        ctx,
        signal,
        signal.symbol,
        isShortSymbol,
        monitorConfig,
      );
      if (submittedOrderId !== null) {
        submittedCount += 1;
        submittedOrderIds.push(submittedOrderId);
      }
    }

    return { submittedCount, submittedOrderIds };
  }

  return {
    canTradeNow: buyThrottle.canTradeNow,
    executeSignals,
    resetBuyThrottle: buyThrottle.resetBuyThrottle,
  };
}
