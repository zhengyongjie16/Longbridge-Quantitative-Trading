/**
 * 信号处理模块类型定义
 */

import type { Quote, Position, AccountSnapshot, IndicatorSnapshot, Signal, OrderRecorder, Trader, RiskChecker, MonitorConfig, PositionCache } from '../../types/index.js';
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
  /** 账户缓存（仅用于日志显示，不用于风险检查） */
  readonly account: AccountSnapshot | null;
  /** 持仓缓存（仅用于日志显示，不用于风险检查） */
  readonly positions: ReadonlyArray<Position>;
  readonly lastState: {
    cachedAccount?: AccountSnapshot | null;
    cachedPositions?: Position[];
    /** 持仓缓存，使用 Map 提供 O(1) 查找性能 */
    positionCache: PositionCache;
  };
  readonly currentTime: Date;
  readonly isHalfDay: boolean;
  readonly doomsdayProtection: DoomsdayProtection;
  readonly config: MonitorConfig;
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
    smartCloseEnabled?: boolean,
  ): Signal[];
  applyRiskChecks(signals: Signal[], context: RiskCheckContext): Promise<Signal[]>;
}

// ==================== 依赖类型定义 ====================

/**
 * 信号处理器依赖类型
 */
export type SignalProcessorDeps = Record<string, never>;

