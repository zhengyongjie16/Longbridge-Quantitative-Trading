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
import { formatSignalLog } from './utils.js';
import type { Signal } from '../../types/signal.js';
import type { SignalPipelineParams } from './types.js';
import { formatSymbolDisplay, isSellAction } from '../../utils/display/index.js';

/**
 * 执行信号处理流水线。
 * 普通信号门禁关闭时直接返回，不生成 immediate/delayed 候选信号。
 * 门禁打开后调用策略生成信号，完成席位校验（状态、版本、标的匹配），
 * 再按信号类型分流：立即信号入买卖队列，延迟信号交由 delayedSignalVerifier 管理。
 */
export function runSignalPipeline(params: SignalPipelineParams): void {
  const { monitorSymbol, monitorSnapshot, monitorContext, mainContext, runtimeFlags, seatInfo } =
    params;
  const { currentTime, openProtectionActive } = runtimeFlags;
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

  if (
    !ordinarySignalGuard({
      lastState,
      now: currentTime,
      doomsdayProtectionEnabled: tradingConfig.global.doomsdayProtection,
    })
  ) {
    return;
  }

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
   * 任一校验失败则返回 null。通过后返回携带席位版本的新信号对象。
   */
  function prepareSignal(signal: Signal): Signal | null {
    if (!signal.symbol) {
      logger.warn(`[跳过信号] 无效的信号对象: ${JSON.stringify(signal)}`);
      return null;
    }

    if (!VALID_SIGNAL_ACTIONS.has(signal.action)) {
      logger.warn(
        `[跳过信号] 未知的信号类型: ${signal.action}, 标的: ${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)}`,
      );
      return null;
    }

    const seatInfoForSignal = resolveSeatForSignal(signal);
    if (!seatInfoForSignal) {
      const isLongSignal = signal.action === 'BUYCALL' || signal.action === 'SELLCALL';
      const seatState = isLongSignal ? longSeatState : shortSeatState;
      logger.debug(`[跳过信号] ${describeSeatUnavailable(seatState)}: ${formatSignalLog(signal)}`);
      return null;
    }

    if (signal.symbol !== seatInfoForSignal.seatSymbol) {
      logger.debug(`[跳过信号] 席位已切换: ${formatSignalLog(signal)}`);
      return null;
    }

    return { ...signal, seatVersion: seatInfoForSignal.seatVersion };
  }

  for (const signal of immediateSignals) {
    const prepared = prepareSignal(signal);
    if (!prepared) {
      continue;
    }

    logger.debug(`[立即信号] ${formatSignalLog(prepared)}`);
    const isSellSignal = isSellAction(prepared.action);
    if (isSellSignal) {
      sellTaskQueue.push({
        type: 'IMMEDIATE_SELL',
        data: prepared,
        monitorSymbol,
      });
    } else {
      buyTaskQueue.push({
        type: 'IMMEDIATE_BUY',
        data: prepared,
        monitorSymbol,
      });
    }
  }

  for (const signal of delayedSignals) {
    const prepared = prepareSignal(signal);
    if (!prepared) {
      continue;
    }

    logger.debug(`[延迟验证信号] ${formatSignalLog(prepared)}`);
    const verificationIndicators = isBuyAction(prepared.action)
      ? indicatorProfile.verificationIndicatorsBySide.buy
      : indicatorProfile.verificationIndicatorsBySide.sell;
    delayedSignalVerifier.addSignal({
      signal: prepared,
      monitorSymbol,
      verificationIndicators,
    });
  }
}
