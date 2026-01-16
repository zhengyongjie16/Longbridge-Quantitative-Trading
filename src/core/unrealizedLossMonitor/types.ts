/**
 * 浮亏监控模块类型定义
 */

import type { Quote, RiskChecker, Trader, OrderRecorder } from '../../types/index.js';

// ==================== 服务接口定义 ====================

/**
 * 浮亏监控器接口
 */
export interface UnrealizedLossMonitor {
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

// ==================== 依赖类型定义 ====================

/**
 * 浮亏监控器依赖类型
 */
export type UnrealizedLossMonitorDeps = {
  readonly maxUnrealizedLossPerSymbol: number;
};
