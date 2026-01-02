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

import { SignalType } from '../types/index.js';

// 重新导出 SignalType 枚举，保持向后兼容
export { SignalType };

/**
 * 判断信号是否为买入操作（开仓）
 * @param action 信号类型
 * @returns 如果是买入操作返回true
 */
export function isBuyAction(action: SignalType | string): boolean {
  return action === SignalType.BUYCALL || action === SignalType.BUYPUT;
}
