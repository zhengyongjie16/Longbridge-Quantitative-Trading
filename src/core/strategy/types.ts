import type { Signal } from '../../types/signal.js';
import type { IndicatorSnapshot } from '../../types/quote.js';
import type { SignalConfigSet, VerificationConfig } from '../../types/config.js';
import type { OrderRecorder } from '../../types/services.js';

/**
 * 信号类型分类。
 * 类型用途：区分信号是否需要延迟验证（immediate 立即执行，delayed 需等待验证窗口确认）。
 * 数据来源：如适用。
 * 使用范围：仅在策略模块内部使用。
 */
export type SignalTypeCategory = 'immediate' | 'delayed';

/**
 * 带分类标记的信号。
 * 类型用途：策略生成信号后附加分类标记，供 asyncProgram 分发到立即队列或延迟验证队列。
 * 数据来源：策略模块根据 SignalTypeCategory 构造。
 * 使用范围：仅在策略模块内部使用。
 */
export type SignalWithCategory = {
  readonly signal: Signal;
  readonly isImmediate: boolean;
};

/**
 * 策略配置。
 * 类型用途：策略工厂或主程序注入的配置，供信号生成使用。
 * 数据来源：如适用（来自主配置等）。
 * 使用范围：仅策略模块使用。
 */
export type StrategyConfig = {
  readonly signalConfig?: SignalConfigSet | null;
  readonly verificationConfig?: VerificationConfig;
};

/**
 * 信号生成结果。
 * 数据来源为 HangSengMultiIndicatorStrategy.generateCloseSignals。
 */
export type SignalGenerationResult = {
  readonly immediateSignals: ReadonlyArray<Signal>;
  readonly delayedSignals: ReadonlyArray<Signal>;
};

/**
 * 恒生多指标策略接口。
 * 类型用途：依赖注入，基于技术指标生成交易信号（立即/延迟分类）。
 * 数据来源：如适用。
 * 使用范围：主程序持有并调用；仅 strategy 模块实现。
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
