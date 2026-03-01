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
   * @param monitorSnapshot 监控标的指标快照
   * @param monitorQuote 监控标的行情数据
   * @param monitorSymbol 监控标的代码
   * @param emaPeriods EMA周期数组
   * @param rsiPeriods RSI周期数组
   * @param psyPeriods PSY周期数组
   * @param monitorState 监控标的状态（包含 monitorValues）
   * @returns 指标是否发生变化
   */
  monitorIndicatorChanges: (
    monitorSnapshot: IndicatorSnapshot | null,
    monitorQuote: Quote | null,
    monitorSymbol: string,
    emaPeriods: ReadonlyArray<number>,
    rsiPeriods: ReadonlyArray<number>,
    psyPeriods: ReadonlyArray<number>,
    monitorState: MonitorState,
  ) => boolean;
}
