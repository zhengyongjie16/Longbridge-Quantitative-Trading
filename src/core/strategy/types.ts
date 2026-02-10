/**
 * 策略模块类型定义
 *
 * 定义交易策略相关的类型接口，包括：
 * - 策略配置（信号条件、验证配置）
 * - 信号生成结果（立即信号、延迟信号）
 * - 策略接口
 */
import type { SignalConfigSet, VerificationConfig, Signal, IndicatorSnapshot, OrderRecorder } from '../../types/index.js';

/** 信号类型分类：立即执行或延迟验证 */
export type SignalTypeCategory = 'immediate' | 'delayed';

/** 带分类标记的信号（策略内部使用） */
export type SignalWithCategory = {
  readonly signal: Signal;
  readonly isImmediate: boolean;
};

/**
 * 策略配置
 * @property signalConfig - 信号触发条件配置（BUYCALL/SELLCALL/BUYPUT/SELLPUT）
 * @property verificationConfig - 延迟验证配置（验证时间、验证指标）
 */
export type StrategyConfig = {
  readonly signalConfig?: SignalConfigSet | null;
  readonly verificationConfig?: VerificationConfig;
};

/**
 * 信号生成结果
 * @property immediateSignals - 立即执行的信号（无需延迟验证）
 * @property delayedSignals - 需要延迟验证的信号
 */
export type SignalGenerationResult = {
  readonly immediateSignals: ReadonlyArray<Signal>;
  readonly delayedSignals: ReadonlyArray<Signal>;
};

/**
 * 恒生多指标策略接口
 *
 * 基于技术指标生成交易信号的策略实现
 */
export interface HangSengMultiIndicatorStrategy {
  /**
   * 生成交易信号
   *
   * 根据当前指标状态评估信号条件，生成买入/卖出信号。
   * 卖出信号需要有对应的买入订单记录才会生成。
   *
   * @param state 当前指标快照
   * @param longSymbol 做多标的代码
   * @param shortSymbol 做空标的代码
   * @param orderRecorder 订单记录器
   * @returns 立即信号和延迟信号
   */
  generateCloseSignals(
    state: IndicatorSnapshot | null,
    longSymbol: string,
    shortSymbol: string,
    orderRecorder: OrderRecorder,
  ): SignalGenerationResult;
}
