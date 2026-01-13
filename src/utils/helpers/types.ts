/**
 * 工具函数模块类型定义
 */

import type { AccountSnapshot, Position, Quote, SignalConfig } from '../../types/index.js';

/**
 * LongPort Decimal 类型接口
 */
export type DecimalLike = {
  toNumber(): number;
};

/**
 * 时间格式化选项
 */
export type TimeFormatOptions = {
  readonly format?: 'iso' | 'log';
};

/**
 * 行情显示格式化结果
 */
export type QuoteDisplayResult = {
  readonly nameText: string;
  readonly codeText: string;
  readonly priceText: string;
  readonly changeAmountText: string;
  readonly changePercentText: string;
};

// ============= signalConfigParser 类型定义 =============

/**
 * 解析后的条件（带可选周期）
 */
export type ParsedCondition = {
  readonly indicator: string;
  readonly period?: number;
  readonly operator: '<' | '>';
  readonly threshold: number;
};

/**
 * 解析后的条件组
 */
export type ParsedConditionGroup = {
  readonly conditions: ReadonlyArray<ParsedCondition>;
  readonly minSatisfied: number;
};

/**
 * 信号配置验证结果接口
 */
export type SignalValidationResult = {
  readonly valid: boolean;
  readonly error: string | null;
  readonly config: SignalConfig | null;
};

/**
 * 评估结果接口
 */
export type EvaluationResult = {
  readonly triggered: boolean;
  readonly satisfiedGroupIndex: number;
  readonly satisfiedCount: number;
  readonly reason: string;
};

/**
 * 条件组评估结果接口
 */
export type ConditionGroupResult = {
  readonly satisfied: boolean;
  readonly count: number;
};

// ============= accountDisplay 类型定义 =============

/**
 * Trader 接口定义
 */
export type Trader = {
  getAccountSnapshot(): Promise<AccountSnapshot | null>;
  getStockPositions(): Promise<Position[]>;
};

/**
 * MarketDataClient 接口定义
 */
export type MarketDataClient = {
  getLatestQuote(symbol: string): Promise<Quote | null>;
  getQuotes(symbols: ReadonlyArray<string>): Promise<Map<string, Quote | null>>;
};

/**
 * 状态对象接口
 */
export type LastState = {
  cachedAccount: AccountSnapshot | null;
  cachedPositions: Position[];
};

// ============= tradingTime 类型定义 =============

/**
 * 香港时间结构
 */
export type HKTime = {
  readonly hkHour: number;
  readonly hkMinute: number;
};
