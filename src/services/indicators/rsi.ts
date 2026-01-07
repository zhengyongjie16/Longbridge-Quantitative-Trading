/**
 * RSI（相对强弱指标）计算模块
 *
 * 指标参数：
 * - RSI：周期 6，Wilder's Smoothing 平滑
 */

import { RSI } from 'technicalindicators';
import { validatePercentage } from '../../utils/indicatorHelpers/index.js';
import { toNumber, logDebug } from './utils.js';

/**
 * 计算 RSI（相对强弱指标）
 * @param validCloses 收盘价数组，按时间顺序排列
 * @param period RSI周期，例如：6（RSI6）
 * @returns RSI值（0-100），如果无法计算则返回null
 */
export function calculateRSI(validCloses: ReadonlyArray<number>, period: number): number | null {
  if (
    !validCloses ||
    validCloses.length <= period ||
    !Number.isFinite(period) ||
    period <= 0
  ) {
    return null;
  }

  try {
    // 过滤无效数据
    const filteredCloses = validCloses
      .map((c) => toNumber(c))
      .filter((v) => Number.isFinite(v) && v > 0);

    if (filteredCloses.length <= period) {
      return null;
    }

    // 使用 technicalindicators 库计算 RSI
    const rsiResult = RSI.calculate({ values: filteredCloses, period });

    if (!rsiResult || rsiResult.length === 0) {
      return null;
    }

    // 获取最后一个 RSI 值（当前值）
    const rsi = rsiResult.at(-1);

    // 验证 RSI 结果有效性（0-100 范围）
    if (rsi === undefined || !validatePercentage(rsi)) {
      return null;
    }

    return rsi;
  } catch (err) {
    logDebug(`RSI计算失败 (period=${period})`, err);
    return null;
  }
}
