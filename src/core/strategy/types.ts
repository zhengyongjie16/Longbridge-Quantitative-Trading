import type { SignalConfigSet, VerificationConfig } from '../../types/config.js';
import type { Signal } from '../../types/signal.js';
import type { IndicatorUsageProfile } from '../../types/indicatorProfile.js';
import type { IndicatorSnapshot } from '../../types/quote.js';
import type { OrderRecorder } from '../../types/services.js';

/**
 * 交易信号策略配置。
 * 类型用途：表达 app 装配层传给策略工厂的最小配置子集。
 * 数据来源：来自 monitorConfig.signalConfig 与 monitorConfig.verificationConfig。
 * 使用范围：策略工厂、app 装配层与相关测试使用。
 */
export type TradingSignalStrategyConfig = Readonly<{
  signalConfig: SignalConfigSet | null;
  verificationConfig: VerificationConfig;
}>;

/**
 * 交易信号生成结果。
 * 类型用途：表达策略输出的立即信号与延迟验证信号集合。
 * 数据来源：由策略端口 generateSignals 返回。
 * 使用范围：app 组装层、signalPipeline 与策略实现模块使用。
 */
export type TradingSignalGenerationResult = {
  readonly immediateSignals: ReadonlyArray<Signal>;
  readonly delayedSignals: ReadonlyArray<Signal>;
};

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
 * 信号配置评估结果。
 * 类型用途：描述单次 evaluateSignalConfig 的触发状态、命中条件组索引、命中数量与原因文案。
 * 使用范围：仅 strategy 模块内部与调用方诊断日志使用。
 * 数据来源：由当前模块的入参、返回值或运行时派生数据提供（如适用）。
 */
export type EvaluationResult = {
  readonly triggered: boolean;
  readonly satisfiedGroupIndex: number;
  readonly satisfiedCount: number;
  readonly reason: string;
};

/**
 * 条件组评估结果。
 * 类型用途：描述单个条件组是否满足及满足的条件数量。
 * 使用范围：仅 strategy 模块内部条件组评估流程使用。
 * 数据来源：由当前模块的入参、返回值或运行时派生数据提供（如适用）。
 */
export type ConditionGroupResult = {
  readonly satisfied: boolean;
  readonly count: number;
};

/**
 * 交易信号策略端口。
 * 类型用途：约束调用侧仅依赖 generateSignals 能力，避免装配层绑定具体策略实现命名。
 * 数据来源：由具体策略实现提供。
 * 使用范围：MonitorContext、createMonitorContexts、signalPipeline 等调用链路使用。
 */
export interface TradingSignalStrategy {
  generateSignals: (
    state: IndicatorSnapshot | null,
    longSymbol: string,
    shortSymbol: string,
    orderRecorder: OrderRecorder,
    indicatorProfile: IndicatorUsageProfile,
  ) => TradingSignalGenerationResult;
}

/**
 * 交易信号策略工厂。
 * 类型用途：按策略配置创建策略实例，供 app 组装层注入默认或自定义策略实现。
 * 数据来源：由 strategy 模块实现或测试注入。
 * 使用范围：createMonitorContexts 及相关测试使用。
 */
export type TradingSignalStrategyFactory = (
  strategyConfig: TradingSignalStrategyConfig,
) => TradingSignalStrategy;
