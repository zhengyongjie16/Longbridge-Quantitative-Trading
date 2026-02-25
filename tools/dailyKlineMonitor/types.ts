import type { QuoteContext } from 'longport';
import type { IndicatorSnapshot, Quote } from '../../src/types/quote.js';

/**
 * 监控状态类型：用于记录上一次输出的指标值，支持变化检测。
 * 数据来源：由实时监控循环逐轮更新。
 * 使用范围：仅 `tools/dailyKlineMonitor` 工具内部。
 */
export type MonitorState = {
  lastPrice: number | null;
  lastChangePercent: number | null;
  lastEma: Readonly<Record<number, number>> | null;
  lastRsi: Readonly<Record<number, number>> | null;
  lastMfi: number | null;
  lastKdj: IndicatorSnapshot['kdj'] | null;
  lastMacd: IndicatorSnapshot['macd'] | null;
};

/**
 * 监控上下文类型：聚合行情上下文、标的代码与可变状态。
 * 数据来源：监控初始化阶段创建。
 * 使用范围：仅 `tools/dailyKlineMonitor` 工具内部。
 */
export type MonitorContext = {
  readonly ctx: QuoteContext;
  readonly monitorSymbol: string;
  readonly state: MonitorState;
};

/**
 * 指标周期配置类型：用于控制 EMA/RSI 显示与变化检测的周期集合。
 * 数据来源：工具配置常量。
 * 使用范围：仅 `tools/dailyKlineMonitor` 工具内部。
 */
export type IndicatorPeriods = {
  readonly emaPeriods: ReadonlyArray<number>;
  readonly rsiPeriods: ReadonlyArray<number>;
};

/**
 * 变化检测配置类型：用于定义价格与指标触发输出的阈值。
 * 数据来源：工具配置常量。
 * 使用范围：仅 `tools/dailyKlineMonitor` 工具内部。
 */
export type ChangeDetectConfig = {
  readonly changeThreshold: number;
  readonly indicatorPeriods: IndicatorPeriods;
};

/**
 * 显示上下文类型：用于渲染日志时传递行情、快照和标的信息。
 * 数据来源：单次监控循环计算结果。
 * 使用范围：仅 `tools/dailyKlineMonitor` 工具内部。
 */
export type DisplayContext = {
  readonly snapshot: IndicatorSnapshot;
  readonly quote: Quote | null;
  readonly monitorSymbol: string;
  readonly indicatorPeriods: IndicatorPeriods;
};
