/**
 * 信号处理模块类型定义
 */

import type {
  Quote,
  Position,
  Signal,
  OrderRecorder,
  RiskCheckContext,
  MultiMonitorTradingConfig,
} from '../../types/index.js';

/**
 * 卖出数量计算结果类型
 */
export type SellQuantityResult = {
  readonly quantity: number | null;
  readonly shouldHold: boolean;
  readonly reason: string;
};

/**
 * 卖出上下文校验结果
 */
export type SellContextValidationResult =
  | {
      readonly valid: true;
      readonly availableQuantity: number;
      readonly currentPrice: number;
    }
  | {
      readonly valid: false;
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
    smartCloseEnabled: boolean,
  ): Signal[];
  applyRiskChecks(signals: Signal[], context: RiskCheckContext): Promise<Signal[]>;
}

// ==================== 依赖类型定义 ====================

/**
 * 信号处理器依赖类型
 */
export type SignalProcessorDeps = {
  readonly tradingConfig: MultiMonitorTradingConfig;
};

