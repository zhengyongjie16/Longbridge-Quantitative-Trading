import type { MonitorState } from '../../types/state.js';
import type { IndicatorSnapshot, Quote } from '../../types/quote.js';
import type { UnrealizedLossMetrics, WarrantDistanceInfo } from '../../types/services.js';

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
 * 类型用途：封装 monitorIndicatorChanges 所需的指标快照、行情、周期配置与 K 线时间戳，避免超参数函数签名。
 * 数据来源：由指标流水线（indicatorPipeline）基于实时 K 线与行情组装传入。
 * 使用范围：marketMonitor.monitorIndicatorChanges 入参。
 */
export type MonitorIndicatorChangesParams = Readonly<{
  readonly monitorSnapshot: IndicatorSnapshot | null;
  readonly monitorQuote: Quote | null;
  readonly monitorSymbol: string;
  readonly emaPeriods: ReadonlyArray<number>;
  readonly rsiPeriods: ReadonlyArray<number>;
  readonly psyPeriods: ReadonlyArray<number>;
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
