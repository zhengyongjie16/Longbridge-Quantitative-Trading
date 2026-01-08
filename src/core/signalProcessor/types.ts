/**
 * 信号处理模块类型定义
 */

import type { Quote, Position, AccountSnapshot, IndicatorSnapshot, Signal, OrderRecorder, Trader, RiskChecker } from '../../types/index.js';
import type { DoomsdayProtection } from '../doomsdayProtection/types.js';

/**
 * 风险检查上下文类型
 */
export type RiskCheckContext = {
  readonly trader: Trader;
  readonly riskChecker: RiskChecker;
  readonly orderRecorder: OrderRecorder;
  readonly longQuote: Quote | null;
  readonly shortQuote: Quote | null;
  readonly monitorQuote: Quote | null;
  readonly monitorSnapshot: IndicatorSnapshot | null;
  readonly longSymbol: string;
  readonly shortSymbol: string;
  readonly longSymbolName: string | null;
  readonly shortSymbolName: string | null;
  readonly account: AccountSnapshot | null;
  readonly positions: ReadonlyArray<Position>;
  readonly lastState: {
    cachedAccount?: AccountSnapshot | null;
    cachedPositions?: Position[];
  };
  readonly currentTime: Date;
  readonly isHalfDay: boolean;
  readonly doomsdayProtection: DoomsdayProtection;
};

/**
 * 卖出数量计算结果类型
 */
export type SellQuantityResult = {
  readonly quantity: number | null;
  readonly shouldHold: boolean;
  readonly reason: string;
};

// ==================== 服务接口定义 ====================

/**
 * 信号处理器接口
 */
export interface SignalProcessor {
  processSellSignals(
    signals: Signal[],
    longPosition: Position | null,
    shortPosition: Position | null,
    longQuote: Quote | null,
    shortQuote: Quote | null,
    orderRecorder: OrderRecorder,
  ): Signal[];
  applyRiskChecks(signals: Signal[], context: RiskCheckContext): Promise<Signal[]>;
}

// ==================== 依赖类型定义 ====================

/**
 * 信号处理器依赖类型
 */
export type SignalProcessorDeps = Record<string, never>;

