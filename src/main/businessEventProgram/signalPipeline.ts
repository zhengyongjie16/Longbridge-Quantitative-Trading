/**
 * 信号处理流水线模块
 *
 * 功能：
 * - 接收策略生成的交易信号（立即信号和延迟验证信号）
 * - 进行席位状态校验（席位就绪、版本匹配、标的匹配）
 * - 根据信号类型分流到对应的任务队列
 *
 * 信号分流规则：
 * - 立即买入信号 → buyTaskQueue (IMMEDIATE_BUY)
 * - 立即卖出信号 → sellTaskQueue (IMMEDIATE_SELL)
 * - 延迟验证信号 → delayedSignalVerifier
 *
 * 席位校验条件：
 * 1. 席位状态必须为 ACTIVE
 * 2. 信号中的席位版本必须与当前席位版本匹配
 * 3. 信号标的必须与席位当前标的匹配
 */
import { logger } from '../../utils/logger/index.js';
import { isBuyAction } from '../../utils/helpers/index.js';
import { VALID_SIGNAL_ACTIONS } from '../../constants/index.js';
import { ordinarySignalGuard } from '../ordinarySignalGuard/index.js';
import { isSeatActive } from '../../utils/seat/guards.js';
import { describeSeatUnavailable } from '../../services/autoSymbolManager/utils.js';
import { formatSignalLog } from '../processMonitor/utils.js';
import type { Signal } from '../../types/signal.js';
import type { SignalPipelineParams } from './types.js';
import { formatSymbolDisplay, isSellAction } from '../../utils/display/index.js';

/**
 * 执行信号处理流水线。
 * 调用策略生成平仓信号后，对每个信号进行席位校验（状态、版本、标的匹配），
 * 再按信号类型分流：立即信号入买卖队列，延迟信号交由 delayedSignalVerifier 管理。
 * 非交易时段或门禁关闭时记录日志并释放信号对象。
 */
export function runSignalPipeline(params: SignalPipelineParams): void {
  const {
    monitorSymbol,
    monitorSnapshot,
    monitorContext,
    mainContext,
    runtimeFlags,
    seatInfo,
    releaseSignal,
  } = params;
  const { currentTime, canTradeNow, openProtectionActive, isTradingEnabled } = runtimeFlags;
  const { strategy, orderRecorder, delayedSignalVerifier, indicatorProfile } = monitorContext;
  const { lastState, buyTaskQueue, sellTaskQueue, tradingConfig } = mainContext;
  const {
    longSeatState,
    shortSeatState,
    longSeatVersion,
    shortSeatVersion,
    longSymbol,
    shortSymbol,
  } = seatInfo;

  if (openProtectionActive) {
    return;
  }

  const canEnqueue = ordinarySignalGuard({
    lastState,
    now: currentTime,
    doomsdayProtectionEnabled: tradingConfig.global.doomsdayProtection,
  });

  const { immediateSignals, delayedSignals } = strategy.generateSignals(
    monitorSnapshot,
    longSymbol,
    shortSymbol,
    orderRecorder,
    indicatorProfile,
  );

  function resolveSeatForSignal(signal: Signal): Readonly<{
    seatSymbol: string;
    seatVersion: number;
  }> | null {
    const isLongSignal = signal.action === 'BUYCALL' || signal.action === 'SELLCALL';
    const seatState = isLongSignal ? longSeatState : shortSeatState;
    if (!isSeatActive(seatState)) {
      return null;
    }

    const seatSymbol = seatState.symbol;
    const seatVersion = isLongSignal ? longSeatVersion : shortSeatVersion;
    return { seatSymbol, seatVersion };
  }

  /**
   * 校验信号合法性。
   * 依次检查信号字段完整性、action 合法性、席位就绪状态与标的匹配；
   * 任一校验失败则释放信号对象并返回 false。通过后写入席位版本。
   */
  function prepareSignal(signal: Signal): boolean {
    if (!signal.symbol) {
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
      logger.debug(`[跳过信号] ${describeSeatUnavailable(seatState)}: ${formatSignalLog(signal)}`);
      releaseSignal(signal);
      return false;
    }

    if (signal.symbol !== seatInfoForSignal.seatSymbol) {
      logger.debug(`[跳过信号] 席位已切换: ${formatSignalLog(signal)}`);
      releaseSignal(signal);
      return false;
    }

    signal.seatVersion = seatInfoForSignal.seatVersion;
    return true;
  }

  for (const signal of immediateSignals) {
    if (!prepareSignal(signal)) {
      continue;
    }

    if (canEnqueue) {
      logger.debug(`[立即信号] ${formatSignalLog(signal)}`);
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
      const reason =
        isTradingEnabled && canTradeNow ? '普通信号门禁关闭，暂不执行' : '交易门禁关闭，暂不执行';
      logger.debug(`[立即信号] ${formatSignalLog(signal)}（${reason}）`);
      releaseSignal(signal);
    }
  }

  for (const signal of delayedSignals) {
    if (!prepareSignal(signal)) {
      continue;
    }

    if (canEnqueue) {
      logger.debug(`[延迟验证信号] ${formatSignalLog(signal)}`);
      const verificationIndicators = isBuyAction(signal.action)
        ? indicatorProfile.verificationIndicatorsBySide.buy
        : indicatorProfile.verificationIndicatorsBySide.sell;
      delayedSignalVerifier.addSignal({
        signal,
        monitorSymbol,
        verificationIndicators,
      });
    } else {
      const reason =
        isTradingEnabled && canTradeNow
          ? '普通信号门禁关闭，暂不添加验证'
          : '交易门禁关闭，暂不添加验证';
      logger.debug(`[延迟验证信号] ${formatSignalLog(signal)}（${reason}）`);
      releaseSignal(signal);
    }
  }
}
