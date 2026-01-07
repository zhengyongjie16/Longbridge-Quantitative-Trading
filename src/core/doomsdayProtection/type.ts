/**
 * DoomsdayProtection 模块类型定义
 */

import type { Position, Quote, Signal } from '../../types/index.js';

/**
 * 末日保护程序接口
 * 在收盘前执行保护性操作：
 * - 收盘前15分钟拒绝买入
 * - 收盘前5分钟自动清仓
 */
export interface DoomsdayProtection {
  /**
   * 检查是否应该拒绝买入（收盘前15分钟）
   * @param currentTime 当前时间
   * @param isHalfDay 是否是半日交易日
   * @returns true表示应该拒绝买入
   */
  shouldRejectBuy(currentTime: Date, isHalfDay: boolean): boolean;

  /**
   * 检查是否应该自动清仓（收盘前5分钟）
   * @param currentTime 当前时间
   * @param isHalfDay 是否是半日交易日
   * @returns true表示应该自动清仓
   */
  shouldClearPositions(currentTime: Date, isHalfDay: boolean): boolean;

  /**
   * 生成清仓信号（收盘前5分钟自动清仓）
   * @param positions 持仓列表
   * @param longQuote 做多标的行情
   * @param shortQuote 做空标的行情
   * @param longSymbol 做多标的代码
   * @param shortSymbol 做空标的代码
   * @param isHalfDay 是否是半日交易日
   * @returns 清仓信号列表
   */
  generateClearanceSignals(
    positions: ReadonlyArray<Position>,
    longQuote: Quote | null,
    shortQuote: Quote | null,
    longSymbol: string,
    shortSymbol: string,
    isHalfDay: boolean,
  ): ReadonlyArray<Signal>;
}
