import type { DisplayIndicatorItem, IndicatorUsageProfile } from '../../types/indicatorProfile.js';
import type { MonitorState } from '../../types/state.js';
import type { IndicatorSnapshot, Quote } from '../../types/quote.js';
import type { UnrealizedLossMetrics, WarrantDistanceInfo } from '../../types/services.js';

/**
 * 编译后的展示项描述。
 * 类型用途：将 displayPlan 的字符串项预编译为结构化描述，供 marketMonitor 在主循环中复用。
 * 数据来源：marketMonitor 根据 IndicatorUsageProfile.displayPlan 编译生成。
 * 使用范围：仅 services/marketMonitor 模块内部。
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
 * 编译后的展示计划。
 * 类型用途：缓存 displayPlan 对应的结构化执行结果，避免主循环重复解析周期项和扫描展示集合。
 * 数据来源：marketMonitor 根据 IndicatorUsageProfile.displayPlan 编译生成。
 * 使用范围：仅 services/marketMonitor 模块内部。
 */
export type CompiledDisplayPlan = {
  readonly items: ReadonlyArray<CompiledDisplayPlanItem>;
  readonly emaPeriods: ReadonlyArray<number>;
  readonly rsiPeriods: ReadonlyArray<number>;
  readonly psyPeriods: ReadonlyArray<number>;
  readonly needsMfi: boolean;
  readonly needsAdx: boolean;
  readonly needsKdj: boolean;
  readonly needsMacd: boolean;
};

/**
 * 价格展示附加信息。
 * 类型用途：封装做多/做空标的价格日志所需的距回收价、持仓市值/持仓盈亏、订单数量。
 * 数据来源：processMonitor.riskTasks 从 RiskChecker 与 OrderRecorder 聚合生成。
 * 使用范围：marketMonitor.monitorPriceChanges 入参。
 */
export type PriceDisplayInfo = {
  /** 距回收价信息 */
  readonly warrantDistanceInfo: WarrantDistanceInfo | null;

  /** 浮亏实时指标 */
  readonly unrealizedLossMetrics: UnrealizedLossMetrics | null;

  /** 未平仓买入订单数量（笔数） */
  readonly orderCount: number | null;
};

/**
 * 指标监控参数。
 * 类型用途：封装 monitorIndicatorChanges 所需的指标快照、行情、指标画像与 K 线时间戳，避免超参数函数签名。
 * 数据来源：由指标流水线（indicatorPipeline）基于实时 K 线与行情组装传入。
 * 使用范围：marketMonitor.monitorIndicatorChanges 入参。
 */
export type MonitorIndicatorChangesParams = Readonly<{
  readonly monitorSnapshot: IndicatorSnapshot | null;
  readonly monitorQuote: Quote | null;
  readonly monitorSymbol: string;
  readonly indicatorProfile: IndicatorUsageProfile;
  readonly klineTimestamp: number | null;
  readonly monitorState: MonitorState;
}>;

/**
 * 行情监控器接口。
 * 类型用途：对外暴露价格与指标监控方法，供主循环驱动控制台输出。
 * 数据来源：主循环传入行情快照与 MonitorState，由本模块计算是否变化。
 * 使用范围：主循环调用，仅用于控制台输出。
 */
export interface MarketMonitor {
  /**
   * 监控并显示做多和做空标的的价格变化
   * @param longQuote 做多标的行情数据
   * @param shortQuote 做空标的行情数据
   * @param longSymbol 做多标的代码
   * @param shortSymbol 做空标的代码
   * @param monitorState 监控标的状态（包含 longPrice, shortPrice）
   * @returns 价格是否发生变化
   */
  monitorPriceChanges: (
    longQuote: Quote | null,
    shortQuote: Quote | null,
    longSymbol: string,
    shortSymbol: string,
    monitorState: MonitorState,
    longDisplayInfo?: PriceDisplayInfo | null,
    shortDisplayInfo?: PriceDisplayInfo | null,
  ) => boolean;

  /**
   * 监控并显示监控标的的指标变化
   * @param params 指标监控参数（含快照、行情、周期配置、K线时间戳与状态）
   * @returns 指标是否发生变化
   */
  monitorIndicatorChanges: (params: MonitorIndicatorChangesParams) => boolean;
}
