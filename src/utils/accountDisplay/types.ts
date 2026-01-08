/**
 * 账户显示模块类型定义
 */

import type { AccountSnapshot, Position, Quote } from '../../types/index.js';

/**
 * Trader 接口定义
 */
export type Trader = {
  getAccountSnapshot(): Promise<AccountSnapshot | null>;
  getStockPositions(): Promise<Position[]>;
};

/**
 * MarketDataClient 接口定义
 */
export type MarketDataClient = {
  getLatestQuote(symbol: string): Promise<Quote | null>;
};

/**
 * 状态对象接口
 */
export type LastState = {
  cachedAccount: AccountSnapshot | null;
  cachedPositions: Position[];
};
