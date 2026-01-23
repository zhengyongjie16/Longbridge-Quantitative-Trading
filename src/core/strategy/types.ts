/**
 * 策略模块类型定义
 */

import type { SignalConfigSet, VerificationConfig, Signal, IndicatorSnapshot, OrderRecorder } from '../../types/index.js';

/**
 * 策略配置类型
 */
export type StrategyConfig = {
  readonly signalConfig?: SignalConfigSet | null;
  readonly verificationConfig?: VerificationConfig;
};

/**
 * 信号生成结果类型
 */
export type SignalGenerationResult = {
  readonly immediateSignals: ReadonlyArray<Signal>;
  readonly delayedSignals: ReadonlyArray<Signal>;
};

/**
 * 恒生多指标策略接口
 */
export interface HangSengMultiIndicatorStrategy {
  /**
   * 生成卖出信号（卖出数量由智能平仓策略处理）和延迟验证的开仓信号
   * @param state 监控标的的指标状态
   * @param longSymbol 做多标的的代码
   * @param shortSymbol 做空标的的代码
   * @param orderRecorder 订单记录器（用于检查卖出信号是否有买入订单记录）
   * @returns 包含立即执行信号和延迟验证信号的对象
   */
  generateCloseSignals(
    state: IndicatorSnapshot | null,
    longSymbol: string,
    shortSymbol: string,
    orderRecorder: OrderRecorder,
  ): SignalGenerationResult;
}
