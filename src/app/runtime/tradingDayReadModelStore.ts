/**
 * 交易日读模型 Store
 *
 * 职责：
 * - 作为 cachedTradingDayInfo 与 tradingCalendarSnapshot 的唯一真相源
 * - 让 startup/lifecycle 不再直接散写 LastState 对应字段
 */
import type { TradingDayReadModelState, TradingDayReadModelStore } from './types.js';

/**
 * 创建交易日读模型 store。
 *
 * @param initialState 初始交易日读模型状态
 * @returns 交易日读模型 store
 */
export function createTradingDayReadModelStore(
  initialState: TradingDayReadModelState,
): TradingDayReadModelStore {
  const state: TradingDayReadModelState = {
    ...initialState,
  };

  return {
    getState: () => state,
    setCachedTradingDayInfo: (cachedTradingDayInfo) => {
      state.cachedTradingDayInfo = cachedTradingDayInfo;
    },
    setTradingCalendarSnapshot: (tradingCalendarSnapshot) => {
      state.tradingCalendarSnapshot = tradingCalendarSnapshot;
    },
  };
}
