/**
 * 策略模块类型定义
 */

import type { SignalConfigSet, VerificationConfig, Signal, Position, IndicatorSnapshot } from '../../types/index.js';

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
   * 生成基于持仓成本价的清仓信号和延迟验证的开仓信号
   * @param state 监控标的的指标状态
   * @param longPosition 做多标的的持仓信息
   * @param shortPosition 做空标的的持仓信息
   * @param longSymbol 做多标的的代码
   * @param shortSymbol 做空标的的代码
   * @returns 包含立即执行信号和延迟验证信号的对象
   */
  generateCloseSignals(
    state: IndicatorSnapshot | null,
    longPosition: Position | null,
    shortPosition: Position | null,
    longSymbol: string,
    shortSymbol: string,
  ): SignalGenerationResult;
}
