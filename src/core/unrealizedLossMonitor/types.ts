/**
 * 浮亏监控模块类型定义
 *
 * 定义浮亏监控相关的类型：
 * - UnrealizedLossMonitor：浮亏监控器接口
 * - UnrealizedLossMonitorDeps：浮亏监控器依赖（最大浮亏阈值）
 */
import type { Quote, RiskChecker, Trader, OrderRecorder } from '../../types/index.js';
import type { DailyLossTracker } from '../risk/types.js';

/**
 * 浮亏监控上下文
 */
export type UnrealizedLossMonitorContext = {
  readonly longQuote: Quote | null;
  readonly shortQuote: Quote | null;
  readonly longSymbol: string;
  readonly shortSymbol: string;
  readonly monitorSymbol: string;
  readonly riskChecker: RiskChecker;
  readonly trader: Trader;
  readonly orderRecorder: OrderRecorder;
  readonly dailyLossTracker: DailyLossTracker;
};

/**
 * 浮亏监控器接口
 * 监控做多/做空标的的浮亏，超过阈值时触发保护性清仓
 */
export interface UnrealizedLossMonitor {
  /**
   * 监控做多和做空标的的浮亏
   * @param context 浮亏监控上下文
   */
  monitorUnrealizedLoss(context: UnrealizedLossMonitorContext): Promise<void>;
}

/**
 * 浮亏监控器依赖类型
 */
export type UnrealizedLossMonitorDeps = {
  /** 单标的最大浮亏阈值（港币），<=0 表示禁用浮亏监控 */
  readonly maxUnrealizedLossPerSymbol: number;
};
