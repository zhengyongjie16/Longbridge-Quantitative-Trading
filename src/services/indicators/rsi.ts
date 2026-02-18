/**
 * RSI（相对强弱指标）计算模块
 *
 * 指标特点：
 * - 周期可配置（通过参数传入）
 * - 使用本地算法计算并输出稳定数值
 * - 返回值范围 0-100
 */
import { logDebug } from './utils.js';
import { validatePercentage } from '../../utils/helpers/indicatorHelpers.js';

function roundToFixed2(value: number): number {
  return Number.parseFloat(value.toFixed(2));
}

function calculateRsiSeries(
  source: ReadonlyArray<number>,
  period: number,
  size: number = source.length,
): number[] {
  if (size <= period) {
    return [];
  }

  const output: number[] = [];
  const per = 1 / period;

  let smoothUp = 0;
  let smoothDown = 0;

  for (let i = 1; i <= period; i += 1) {
    const current = source[i];
    const previous = source[i - 1];
    if (
      current === undefined ||
      previous === undefined ||
      !Number.isFinite(current) ||
      !Number.isFinite(previous)
    ) {
      return [];
    }

    const upward = current > previous ? current - previous : 0;
    const downward = current < previous ? previous - current : 0;
    smoothUp += upward;
    smoothDown += downward;
  }

  smoothUp /= period;
  smoothDown /= period;
  output.push(100 * (smoothUp / (smoothUp + smoothDown)));

  for (let i = period + 1; i < size; i += 1) {
    const current = source[i];
    const previous = source[i - 1];
    if (
      current === undefined ||
      previous === undefined ||
      !Number.isFinite(current) ||
      !Number.isFinite(previous)
    ) {
      break;
    }
    const upward = current > previous ? current - previous : 0;
    const downward = current < previous ? previous - current : 0;

    smoothUp = (upward - smoothUp) * per + smoothUp;
    smoothDown = (downward - smoothDown) * per + smoothDown;
    output.push(100 * (smoothUp / (smoothUp + smoothDown)));
  }

  return output;
}

function normalizeRsiSeries(
  values: ReadonlyArray<number>,
  period: number,
): number[] {
  if (values.length <= period) {
    return [];
  }

  const result = calculateRsiSeries(values, period);
  return result.map((value) => {
    if (!Number.isFinite(value)) {
      // 在无下跌动量等边界场景下，统一返回上边界值，避免 NaN 传递
      return 100;
    }
    return roundToFixed2(value);
  });
}

/**
 * 计算 RSI（相对强弱指标）
 * @param validCloses 已过滤的收盘价数组（由 buildIndicatorSnapshot 预处理）
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
    // validCloses 已由 buildIndicatorSnapshot 预处理，无需再次过滤
    const rsiResult = normalizeRsiSeries(validCloses, period);

    if (!rsiResult || rsiResult.length === 0) {
      return null;
    }

    const rsi = rsiResult.at(-1);

    if (rsi === undefined || !validatePercentage(rsi)) {
      return null;
    }

    return rsi;
  } catch (err) {
    logDebug(`RSI计算失败 (period=${period})`, err);
    return null;
  }
}
