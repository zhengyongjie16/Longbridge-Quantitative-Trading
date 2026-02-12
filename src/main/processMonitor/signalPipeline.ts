/**
 * 信号处理流水线模块
 *
 * 功能：
 * - 接收策略生成的交易信号（立即信号和延迟验证信号）
 * - 进行席位状态校验（席位就绪、版本匹配、标的匹配）
 * - 丰富信号数据（添加标的名称、价格、最小买卖单位）
 * - 根据信号类型分流到对应的任务队列
 *
 * 信号分流规则：
 * - 立即买入信号 → buyTaskQueue (IMMEDIATE_BUY)
 * - 立即卖出信号 → sellTaskQueue (IMMEDIATE_SELL)
 * - 延迟验证信号 → delayedSignalVerifier
 *
 * 席位校验条件：
 * 1. 席位状态必须为 READY
 * 2. 信号中的席位版本必须与当前席位版本匹配
 * 3. 信号标的必须与席位当前标的匹配
 *
 * @param params 流水线参数，包含信号、席位信息、上下文等
 */
import { logger } from '../../utils/logger/index.js';
import { formatSignalLog, formatSymbolDisplay, isBuyAction, isSellAction } from '../../utils/helpers/index.js';
import { VALID_SIGNAL_ACTIONS } from '../../constants/index.js';
import { isSeatReady, describeSeatUnavailable } from '../../services/autoSymbolManager/utils.js';
import { getPositions } from './utils.js';
import type { Quote } from '../../types/quote.js';
import type { Signal } from '../../types/signal.js';
import type { SignalPipelineParams } from './types.js';

export function runSignalPipeline(params: SignalPipelineParams): void {
  const {
    monitorSymbol,
    monitorSnapshot,
    monitorContext,
    mainContext,
    runtimeFlags,
    seatInfo,
    releaseSignal,
    releasePosition,
  } = params;
  const { canTradeNow, openProtectionActive, isTradingEnabled } = runtimeFlags;
  const canEnqueue = isTradingEnabled && canTradeNow;
  const { strategy, orderRecorder, delayedSignalVerifier } = monitorContext;
  const { lastState, buyTaskQueue, sellTaskQueue } = mainContext;
  const {
    longSeatState,
    shortSeatState,
    longSeatVersion,
    shortSeatVersion,
    longSymbol,
    shortSymbol,
    longQuote,
    shortQuote,
  } = seatInfo;

  const { longPosition, shortPosition } = getPositions(
    lastState.positionCache,
    longSymbol,
    shortSymbol,
  );

  try {
    if (openProtectionActive) {
      return;
    }

    const { immediateSignals, delayedSignals } = strategy.generateCloseSignals(
      monitorSnapshot,
      longSymbol,
      shortSymbol,
      orderRecorder,
    );

    /**
     * 丰富信号：名称、价格、lotSize。
     * 买卖信号的 price/lotSize 均不在此处写入，由买卖处理器在执行时按「执行时行情」写入，保证委托价与当前价一致。
     */
    function enrichSignal(signal: Signal): void {
      const sigSymbol = signal.symbol;
      if (sigSymbol === longSymbol && longQuote) {
        if (signal.symbolName == null && longQuote.name != null) {
          signal.symbolName = longQuote.name;
        }
        return;
      }
      if (sigSymbol === shortSymbol && shortQuote) {
        if (signal.symbolName == null && shortQuote.name != null) {
          signal.symbolName = shortQuote.name;
        }
      }
    }

    function resolveSeatForSignal(signal: Signal): Readonly<{
      seatSymbol: string;
      seatVersion: number;
      quote: Quote | null;
      isBuySignal: boolean;
    }> | null {
      const isBuySignal = isBuyAction(signal.action);
      const isLongSignal = signal.action === 'BUYCALL' || signal.action === 'SELLCALL';
      const seatState = isLongSignal ? longSeatState : shortSeatState;
      if (!isSeatReady(seatState)) {
        return null;
      }
      const seatSymbol = seatState.symbol;
      const seatVersion = isLongSignal ? longSeatVersion : shortSeatVersion;
      const quote = isLongSignal ? longQuote : shortQuote;
      return { seatSymbol, seatVersion, quote, isBuySignal };
    }

    function prepareSignal(signal: Signal): boolean {
      if (!signal?.symbol || !signal?.action) {
        logger.warn(`[跳过信号] 无效的信号对象: ${JSON.stringify(signal)}`);
        releaseSignal(signal);
        return false;
      }
      if (!VALID_SIGNAL_ACTIONS.has(signal.action)) {
        logger.warn(
          `[跳过信号] 未知的信号类型: ${signal.action}, 标的: ${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)}`,
        );
        releaseSignal(signal);
        return false;
      }

      const seatInfoForSignal = resolveSeatForSignal(signal);
      if (!seatInfoForSignal) {
        const isLongSignal = signal.action === 'BUYCALL' || signal.action === 'SELLCALL';
        const seatState = isLongSignal ? longSeatState : shortSeatState;
        logger.info(`[跳过信号] ${describeSeatUnavailable(seatState)}: ${formatSignalLog(signal)}`);
        releaseSignal(signal);
        return false;
      }
      if (signal.symbol !== seatInfoForSignal.seatSymbol) {
        logger.info(`[跳过信号] 席位已切换: ${formatSignalLog(signal)}`);
        releaseSignal(signal);
        return false;
      }
      if (seatInfoForSignal.isBuySignal && !seatInfoForSignal.quote) {
        logger.info(`[跳过信号] 行情未就绪: ${formatSignalLog(signal)}`);
        releaseSignal(signal);
        return false;
      }

      signal.seatVersion = seatInfoForSignal.seatVersion;
      enrichSignal(signal);
      return true;
    }

    for (const signal of immediateSignals) {
      if (!prepareSignal(signal)) {
        continue;
      }

      if (canEnqueue) {
        logger.info(`[立即信号] ${formatSignalLog(signal)}`);

        const isSellSignal = isSellAction(signal.action);

        if (isSellSignal) {
          sellTaskQueue.push({
            type: 'IMMEDIATE_SELL',
            data: signal,
            monitorSymbol,
          });
        } else {
          buyTaskQueue.push({
            type: 'IMMEDIATE_BUY',
            data: signal,
            monitorSymbol,
          });
        }
      } else {
        const reason = isTradingEnabled
          ? '非交易时段，暂不执行'
          : '交易门禁关闭，暂不执行';
        logger.info(`[立即信号] ${formatSignalLog(signal)}（${reason}）`);
        releaseSignal(signal);
      }
    }

    for (const signal of delayedSignals) {
      if (!prepareSignal(signal)) {
        continue;
      }

      if (canEnqueue) {
        logger.info(`[延迟验证信号] ${formatSignalLog(signal)}`);
        delayedSignalVerifier.addSignal(signal, monitorSymbol);
      } else {
        const reason = isTradingEnabled
          ? '非交易时段，暂不添加验证'
          : '交易门禁关闭，暂不添加验证';
        logger.info(`[延迟验证信号] ${formatSignalLog(signal)}（${reason}）`);
        releaseSignal(signal);
      }
    }
  } finally {
    if (longPosition) {
      releasePosition(longPosition);
    }
    if (shortPosition) {
      releasePosition(shortPosition);
    }
  }
}
