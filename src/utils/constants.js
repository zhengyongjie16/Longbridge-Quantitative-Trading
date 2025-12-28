/**
 * 常量定义模块
 *
 * 功能：
 * - 定义所有交易信号类型
 * - 提供信号类型判断函数
 *
 * 信号类型：
 * - BUYCALL：买入做多标的
 * - SELLCALL：卖出做多标的
 * - BUYPUT：买入做空标的
 * - SELLPUT：卖出做空标的
 * - HOLD：持有，不操作
 *
 * 辅助函数：
 * - isBuyAction()：判断是否为买入操作（开仓）
 */

// ==================== 交易信号类型 ====================

/**
 * 交易信号类型定义
 * 使用更明确的命名以区分不同类型的操作
 */
export const SignalType = {
  // 做多标的（CALL）相关信号
  BUYCALL: "BUYCALL", // 买入做多标的（做多操作）
  SELLCALL: "SELLCALL", // 卖出做多标的（清仓操作）

  // 做空标的（PUT）相关信号
  BUYPUT: "BUYPUT", // 买入做空标的（做空操作）
  SELLPUT: "SELLPUT", // 卖出做空标的（平空仓操作）

  // 其他
  HOLD: "HOLD", // 持有，不操作
};

/**
 * 判断信号是否为买入操作（开仓）
 * @param {string} action 信号类型
 * @returns {boolean}
 */
export function isBuyAction(action) {
  return action === SignalType.BUYCALL || action === SignalType.BUYPUT;
}
