import type { Decimal, TradeContext } from 'longport';
import type { MonitorConfig, GlobalConfig } from '../../../types/config.js';
import type { Signal, SignalType } from '../../../types/signal.js';
import type { OrderCacheManager, OrderMonitor } from '../types.js';
import type { OrderRecorder, RateLimiter, TradeCheckResult } from '../../../types/services.js';

/**
 * 买入数量来源判定结果。
 * 类型用途：统一表达显式数量/按金额换算/无效输入三种分支。
 * 数据来源：由买入数量解析逻辑根据 signal.quantity 和 signal.lotSize 计算。
 * 使用范围：仅 orderExecutor 模块内部使用。
 */
export type BuyQuantitySource =
  | { readonly source: 'NOTIONAL' }
  | { readonly source: 'EXPLICIT'; readonly quantity: number; readonly lotSize: number }
  | { readonly source: 'INVALID'; readonly reason: string };

/**
 * 提交目标订单函数签名。
 * 类型用途：约束 submitFlow 对外暴露的核心提交流程函数形状。
 * 数据来源：由 createSubmitTargetOrder 工厂返回。
 * 使用范围：仅 orderExecutor/index.ts 调用。
 */
export type SubmitTargetOrder = (
  ctx: TradeContext,
  signal: Signal,
  targetSymbol: string,
  isShortSymbol: boolean,
  monitorConfig?: MonitorConfig | null,
) => Promise<string | null>;

/**
 * 目标订单提交流程依赖。
 * 类型用途：集中注入 submitFlow 所需的上下文、服务与回调，避免内部直接构造依赖。
 * 数据来源：由 createOrderExecutor 装配。
 * 使用范围：仅 orderExecutor/submitFlow.ts 使用。
 */
export type SubmitTargetOrderDeps = {
  readonly rateLimiter: RateLimiter;
  readonly cacheManager: OrderCacheManager;
  readonly orderMonitor: OrderMonitor;
  readonly orderRecorder: OrderRecorder;
  readonly globalConfig: GlobalConfig;
  readonly canExecuteSignal: (signal: Signal, stage: string) => boolean;
  readonly updateLastBuyTime: (
    signalAction: SignalType,
    monitorConfig?: MonitorConfig | null,
  ) => void;
};

/**
 * 买入节流器接口。
 * 类型用途：封装买入频率限制状态与操作，供 orderExecutor 主流程与提交流程共用。
 * 数据来源：由 createBuyThrottle 工厂创建并维护内部 Map 状态。
 * 使用范围：仅 orderExecutor 目录内部使用。
 */
export interface BuyThrottle {
  canTradeNow: (signalAction: SignalType, monitorConfig?: MonitorConfig | null) => TradeCheckResult;
  markBuyAttempt: (signalAction: SignalType, monitorConfig?: MonitorConfig | null) => void;
  resetBuyThrottle: () => void;
  updateLastBuyTime: (signalAction: SignalType, monitorConfig?: MonitorConfig | null) => void;
}

/**
 * 数量解析器接口。
 * 类型用途：统一封装买入/卖出数量计算逻辑，避免 submitFlow 混入数量解析细节。
 * 数据来源：由 createQuantityResolver 工厂创建。
 * 使用范围：仅 orderExecutor 目录内部使用。
 */
export interface QuantityResolver {
  calculateSellQuantity: (ctx: TradeContext, symbol: string, signal: Signal) => Promise<Decimal>;
  resolveBuyQuantity: (signal: Signal, isShortSymbol: boolean, targetNotional: number) => Decimal;
}
