/**
 * 交易信号类型定义
 * 使用更明确的命名以区分不同类型的操作
 */
export const SignalType = {
  // 做多标的（CALL）相关信号
  BUYCALL: "BUYCALL",   // 买入做多标的（做多操作）
  SELLCALL: "SELLCALL", // 卖出做多标的（清仓操作）
  
  // 做空标的（PUT）相关信号
  BUYPUT: "BUYPUT",     // 买入做空标的（做空操作）
  SELLPUT: "SELLPUT",   // 卖出做空标的（平空仓操作）
  
  // 其他
  HOLD: "HOLD",         // 持有，不操作
};

/**
 * 判断信号是否为买入操作（开仓）
 * @param {string} action 信号类型
 * @returns {boolean}
 */
export function isBuyAction(action) {
  return action === SignalType.BUYCALL || action === SignalType.BUYPUT;
}

/**
 * 判断信号是否为卖出操作（平仓）
 * @param {string} action 信号类型
 * @returns {boolean}
 */
export function isSellAction(action) {
  return action === SignalType.SELLCALL || action === SignalType.SELLPUT;
}

/**
 * 判断信号是否为做多标的相关操作
 * @param {string} action 信号类型
 * @returns {boolean}
 */
export function isCallAction(action) {
  return action === SignalType.BUYCALL || action === SignalType.SELLCALL;
}

/**
 * 判断信号是否为做空标的相关操作
 * @param {string} action 信号类型
 * @returns {boolean}
 */
export function isPutAction(action) {
  return action === SignalType.BUYPUT || action === SignalType.SELLPUT;
}

