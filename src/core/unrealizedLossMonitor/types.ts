/**
 * 浮亏监控模块类型定义
 *
 * 定义浮亏监控相关的类型：
 * - UnrealizedLossMonitor：浮亏监控器接口
 * - UnrealizedLossMonitorDeps：浮亏监控器依赖（最大浮亏阈值）
 */

import type { Quote, RiskChecker, Trader, OrderRecorder } from '../../types/index.js';

/**
 * 浮亏监控器接口
 * 监控做多/做空标的的浮亏，超过阈值时触发保护性清仓
 */
export interface UnrealizedLossMonitor {
  /**
   * 监控做多和做空标的的浮亏
   * @param longQuote 做多标的行情
   * @param shortQuote 做空标的行情
   * @param longSymbol 做多标的代码
   * @param shortSymbol 做空标的代码
   * @param riskChecker 风险检查器
   * @param trader 交易执行器
   * @param orderRecorder 订单记录器
   */
  monitorUnrealizedLoss(
    longQuote: Quote | null,
    shortQuote: Quote | null,
    longSymbol: string,
    shortSymbol: string,
    riskChecker: RiskChecker,
    trader: Trader,
    orderRecorder: OrderRecorder,
  ): Promise<void>;
}

/**
 * 浮亏监控器依赖类型
 */
export type UnrealizedLossMonitorDeps = {
  /** 单标的最大浮亏阈值（港币），<=0 表示禁用浮亏监控 */
  readonly maxUnrealizedLossPerSymbol: number;
};
