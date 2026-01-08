/**
 * 信号验证模块类型定义
 */

import type { IndicatorSnapshot, Quote, Signal, LastState } from '../../types/index.js';

/**
 * 信号验证管理器接口
 * 管理延迟信号的验证流程：记录历史、执行验证、清理数据
 */
export interface SignalVerificationManager {
  /**
   * 添加延迟信号到待验证列表
   * @param delayedSignals 延迟信号列表
   * @param lastState 状态对象（包含 pendingDelayedSignals）
   */
  addDelayedSignals(delayedSignals: ReadonlyArray<Signal>, lastState: LastState): void;

  /**
   * 为所有待验证信号记录当前监控标的值（每秒调用一次）
   * @param monitorSnapshot 监控标的指标快照
   * @param lastState 状态对象（包含 pendingDelayedSignals）
   */
  recordVerificationHistory(monitorSnapshot: IndicatorSnapshot | null, lastState: LastState): void;

  /**
   * 验证所有到期的待验证信号
   * @param lastState 状态对象（包含 pendingDelayedSignals）
   * @param longQuote 做多标的行情
   * @param shortQuote 做空标的行情
   * @returns 验证通过的信号列表
   */
  verifyPendingSignals(
    lastState: LastState,
    longQuote: Quote | null,
    shortQuote: Quote | null,
  ): ReadonlyArray<Signal>;
}
