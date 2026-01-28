/**
 * MarketMonitor 模块类型定义
 */

import type {
  IndicatorSnapshot,
  MonitorState,
  Quote,
  WarrantDistanceInfo,
} from '../../types/index.js';

/**
 * 行情监控器接口
 * 监控做多/做空标的价格变化、监控标的指标变化，并格式化显示
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
  monitorPriceChanges(
    longQuote: Quote | null,
    shortQuote: Quote | null,
    longSymbol: string,
    shortSymbol: string,
    monitorState: MonitorState,
    longWarrantDistanceInfo?: WarrantDistanceInfo | null,
    shortWarrantDistanceInfo?: WarrantDistanceInfo | null,
  ): boolean;

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
  monitorIndicatorChanges(
    monitorSnapshot: IndicatorSnapshot | null,
    monitorQuote: Quote | null,
    monitorSymbol: string,
    emaPeriods: ReadonlyArray<number>,
    rsiPeriods: ReadonlyArray<number>,
    psyPeriods: ReadonlyArray<number>,
    monitorState: MonitorState,
  ): boolean;
}
