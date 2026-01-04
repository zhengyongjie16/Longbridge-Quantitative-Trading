/**
 * 信号处理模块类型定义
 */

import type { Quote, Position, AccountSnapshot, IndicatorSnapshot } from '../../types/index.js';
import type { OrderRecorder } from '../orderRecorder/index.js';
import type { Trader } from '../trader/index.js';
import type { RiskChecker } from '../risk/index.js';
import type { DoomsdayProtection } from '../doomsdayProtection/index.js';

/**
 * 风险检查上下文接口
 */
export interface RiskCheckContext {
  trader: Trader;
  riskChecker: RiskChecker;
  orderRecorder: OrderRecorder;
  longQuote: Quote | null;
  shortQuote: Quote | null;
  monitorQuote: Quote | null;
  monitorSnapshot: IndicatorSnapshot | null;
  longSymbol: string;
  shortSymbol: string;
  longSymbolName: string | null;
  shortSymbolName: string | null;
  account: AccountSnapshot | null;
  positions: Position[];
  lastState: {
    cachedAccount?: AccountSnapshot | null;
    cachedPositions?: Position[];
  };
  currentTime: Date;
  isHalfDay: boolean;
  doomsdayProtection: DoomsdayProtection;
}

/**
 * 卖出数量计算结果接口
 */
export interface SellQuantityResult {
  quantity: number | null;
  shouldHold: boolean;
  reason: string;
}

