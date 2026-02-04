/**
 * @module processMonitor/signalPipeline
 * @description 信号生成→席位校验→分流
 */

import { logger } from '../../utils/logger/index.js';
import { formatSignalLog, formatSymbolDisplay } from '../../utils/helpers/index.js';
import { VALID_SIGNAL_ACTIONS } from '../../constants/index.js';
import { isSeatReady } from '../../services/autoSymbolManager/utils.js';
import { getPositions } from './utils.js';
import type { Quote, Signal } from '../../types/index.js';
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
  const { canTradeNow, openProtectionActive } = runtimeFlags;
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

    function enrichSignal(signal: Signal): void {
      const sigSymbol = signal.symbol;
      if (sigSymbol === longSymbol && longQuote) {
        if (signal.symbolName == null && longQuote.name != null) signal.symbolName = longQuote.name;
        signal.price ??= longQuote.price;
        if (signal.lotSize == null && longQuote.lotSize != null) signal.lotSize = longQuote.lotSize;
      } else if (sigSymbol === shortSymbol && shortQuote) {
        if (signal.symbolName == null && shortQuote.name != null) signal.symbolName = shortQuote.name;
        signal.price ??= shortQuote.price;
        if (signal.lotSize == null && shortQuote.lotSize != null) signal.lotSize = shortQuote.lotSize;
      }
    }

    function resolveSeatForSignal(signal: Signal): {
      seatSymbol: string;
      seatVersion: number;
      quote: Quote | null;
      isBuySignal: boolean;
    } | null {
      const isBuySignal = signal.action === 'BUYCALL' || signal.action === 'BUYPUT';
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
        logger.info(`[跳过信号] 席位不可用: ${formatSignalLog(signal)}`);
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

      if (canTradeNow) {
        logger.info(`[立即信号] ${formatSignalLog(signal)}`);

        const isSellSignal = signal.action === 'SELLCALL' || signal.action === 'SELLPUT';

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
        logger.info(`[立即信号] ${formatSignalLog(signal)}（非交易时段，暂不执行）`);
        releaseSignal(signal);
      }
    }

    for (const signal of delayedSignals) {
      if (!prepareSignal(signal)) {
        continue;
      }

      if (canTradeNow) {
        logger.info(`[延迟验证信号] ${formatSignalLog(signal)}`);
        delayedSignalVerifier.addSignal(signal, monitorSymbol);
      } else {
        logger.info(`[延迟验证信号] ${formatSignalLog(signal)}（非交易时段，暂不添加验证）`);
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
