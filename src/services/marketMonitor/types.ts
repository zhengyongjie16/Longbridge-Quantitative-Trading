import type { DisplayIndicatorItem, IndicatorUsageProfile } from '../../types/indicatorProfile.js';
import type { IndicatorSnapshot, Quote } from '../../types/quote.js';
import type {
  QuoteUpdatedEvent,
  UnrealizedLossMetrics,
  WarrantDistanceInfo,
} from '../../types/services.js';

/**
 * 编译后的单项显示计划。
 * 类型用途：把 displayPlan 中的原始指标项解析为可直接渲染的结构化项。
 * 数据来源：由 createMarketMonitor 基于 indicatorProfile.displayPlan 编译。
 * 使用范围：仅 marketMonitor 模块内部使用。
 */
export type CompiledDisplayPlanItem =
  | { readonly item: 'price'; readonly kind: 'price' }
  | { readonly item: 'changePercent'; readonly kind: 'changePercent' }
  | { readonly item: 'MFI'; readonly kind: 'mfi' }
  | { readonly item: 'K'; readonly kind: 'kdj'; readonly field: 'k' }
  | { readonly item: 'D'; readonly kind: 'kdj'; readonly field: 'd' }
  | { readonly item: 'J'; readonly kind: 'kdj'; readonly field: 'j' }
  | { readonly item: 'ADX'; readonly kind: 'adx' }
  | { readonly item: 'MACD'; readonly kind: 'macd'; readonly field: 'macd' }
  | { readonly item: 'DIF'; readonly kind: 'macd'; readonly field: 'dif' }
  | { readonly item: 'DEA'; readonly kind: 'macd'; readonly field: 'dea' }
  | { readonly item: DisplayIndicatorItem; readonly kind: 'ema'; readonly period: number }
  | { readonly item: DisplayIndicatorItem; readonly kind: 'rsi'; readonly period: number }
  | { readonly item: DisplayIndicatorItem; readonly kind: 'psy'; readonly period: number };

/**
 * 编译后的显示计划。
 * 类型用途：缓存 displayPlan 解析结果，避免每次渲染重复解析指标项。
 * 数据来源：由 createMarketMonitor 基于 indicatorProfile.displayPlan 编译。
 * 使用范围：仅 marketMonitor 模块内部使用。
 */
export type CompiledDisplayPlan = Readonly<{
  items: ReadonlyArray<CompiledDisplayPlanItem>;
}>;

/**
 * 交易标的价格显示附加信息。
 * 类型用途：承载 trading quote 显示所需的距回收价、浮亏与订单数信息。
 * 数据来源：由 tradingRiskEventRuntime 路由链路按当前 route 组装。
 * 使用范围：仅 marketMonitor 交易标的显示链路使用。
 */
export type PriceDisplayInfo = {
  readonly warrantDistanceInfo: WarrantDistanceInfo | null;
  readonly unrealizedLossMetrics: UnrealizedLossMetrics | null;
  readonly orderCount: number | null;
};

/**
 * monitor indicator 渲染参数。
 * 类型用途：封装纯渲染 monitor indicators 所需的 snapshot、quote、显示画像与 K 线时间。
 * 数据来源：由 monitorDisplayRuntime 在补齐 monitor quote 后组装。
 * 使用范围：仅 marketMonitor.renderMonitorIndicators 使用。
 */
export type RenderMonitorIndicatorsParams = Readonly<{
  readonly monitorSnapshot: IndicatorSnapshot;
  readonly monitorQuote: Quote | null;
  readonly monitorSymbol: string;
  readonly indicatorProfile: IndicatorUsageProfile;
  readonly klineTimestamp: number | null;
}>;

/**
 * trading quote 渲染参数。
 * 类型用途：封装纯渲染交易标的行情所需的 quote 事件、route 信息、monitor quote 与附加展示信息。
 * 数据来源：由 tradingQuoteDisplayRuntime 在 route 校验与补齐 monitor quote 后组装。
 * 使用范围：仅 marketMonitor.renderTradingQuote 使用。
 */
export type RenderTradingQuoteParams = Readonly<{
  readonly event: QuoteUpdatedEvent;
  readonly tradingSymbol: string;
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly monitorQuote: Quote | null;
  readonly displayInfo: PriceDisplayInfo | null;
}>;

/**
 * 终端显示纯渲染器契约。
 * 类型用途：统一 monitor indicators 与 trading quote 的纯输出端口。
 * 数据来源：由 createMarketMonitor 创建。
 * 使用范围：显示 runtime 与 app 组装链路使用。
 */
export interface MarketMonitor {
  readonly renderTradingQuote: (params: RenderTradingQuoteParams) => void;
  readonly renderMonitorIndicators: (params: RenderMonitorIndicatorsParams) => void;
}
