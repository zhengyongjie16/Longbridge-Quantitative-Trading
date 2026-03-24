/**
 * 策略端口与工厂契约模块
 *
 * 职责：
 * - 定义策略调用侧最小依赖端口（仅 generateSignals）
 * - 定义按策略配置创建策略实例的工厂契约
 */
import type { IndicatorUsageProfile } from '../../types/indicatorProfile.js';
import type { IndicatorSnapshot } from '../../types/quote.js';
import type { OrderRecorder } from '../../types/services.js';
import type { TradingSignalGenerationResult, TradingSignalStrategyConfig } from './types.js';

/**
 * 交易信号策略端口。
 * 类型用途：约束调用侧仅依赖 generateSignals 能力，避免装配层绑定具体策略实现命名。
 * 数据来源：由具体策略实现（如 HangSeng）提供。
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
