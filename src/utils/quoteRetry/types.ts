import type { Quote } from '../../types/quote.js';

/**
 * 行情就绪要求枚举。
 * 类型用途：约束不同订单动作对 quote 字段的就绪条件。
 * 数据来源：由调用方根据业务动作（如下单、监控）传入。
 * 使用范围：quoteRetry 工具模块及其调用方。
 */
type QuoteRetryRequirement = 'PRICE' | 'PRICE_AND_LOT_SIZE';

/**
 * quote 就绪性判断参数。
 * 类型用途：统一描述就绪性判断所需的 quote 与字段要求输入。
 * 数据来源：由调用 isQuoteReadyForRequirement 的业务链路组装。
 * 使用范围：quoteRetry 工具模块内部及调用方。
 */
export type IsQuoteReadyForRequirementParams = Readonly<{
  quote: Quote | null | undefined;
  requirement: QuoteRetryRequirement;
}>;

/**
 * quote 重试推进参数。
 * 类型用途：统一描述重试推进计算所需的输入值（次数、时间、可选配置）。
 * 数据来源：由调用 resolveNextQuoteRetry 的业务链路传入。
 * 使用范围：quoteRetry 工具模块内部及调用方。
 */
export type ResolveNextQuoteRetryParams = Readonly<{
  attempts: number;
  nowMs: number;
  intervalMs?: number;
  maxAttempts?: number;
}>;

/**
 * quote 重试推进结果。
 * 类型用途：描述下一次重试状态（次数、调度时间、是否耗尽）。
 * 数据来源：由 resolveNextQuoteRetry 计算并返回。
 * 使用范围：quoteRetry 工具模块调用方。
 */
export type ResolveNextQuoteRetryResult = Readonly<{
  nextAttempts: number;
  nextRetryAt: number | null;
  exhausted: boolean;
}>;
