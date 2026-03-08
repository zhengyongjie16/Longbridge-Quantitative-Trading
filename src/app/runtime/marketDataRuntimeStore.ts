/**
 * 行情运行态 Store
 *
 * 职责：
 * - 统一维护主循环目标标的集合
 * - 统一维护 quote/candlestick 的真实订阅集合
 * - 替代 mainProgram 与 quoteClient 中的分散私有集合
 */
import type { MarketDataRuntimeStore, MarketDataRuntimeState } from './types.js';

/**
 * 创建行情运行态 store。
 *
 * @returns market data runtime store
 */
export function createMarketDataRuntimeStore(): MarketDataRuntimeStore {
  const state: MarketDataRuntimeState = {
    activeTradingSymbols: new Set(),
    subscribedQuoteSymbols: new Set(),
    subscribedCandlesticks: new Map(),
  };

  return {
    getState: () => state,
    replaceActiveTradingSymbols: (symbols) => {
      state.activeTradingSymbols.clear();
      for (const symbol of symbols) {
        state.activeTradingSymbols.add(symbol);
      }
    },
    hasSubscribedQuoteSymbol: (symbol) => state.subscribedQuoteSymbols.has(symbol),
    addSubscribedQuoteSymbols: (symbols) => {
      for (const symbol of symbols) {
        state.subscribedQuoteSymbols.add(symbol);
      }
    },
    removeSubscribedQuoteSymbols: (symbols) => {
      for (const symbol of symbols) {
        state.subscribedQuoteSymbols.delete(symbol);
      }
    },
    hasSubscribedCandlestick: (key) => state.subscribedCandlesticks.has(key),
    setSubscribedCandlestick: (key, period) => {
      state.subscribedCandlesticks.set(key, period);
    },
    deleteSubscribedCandlestick: (key) => {
      state.subscribedCandlesticks.delete(key);
    },
  };
}
