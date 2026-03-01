import type { IndicatorState } from './types.js';

/**
 * 验证周期是否为指定区间内的有限数字（内部复用）。
 *
 * @param period 待校验周期
 * @param min 最小值（含）
 * @param max 最大值（含）
 * @returns 符合区间且为有限数字时返回 true，否则返回 false
 */
function validatePeriodInRange(period: unknown, min: number, max: number): period is number {
  return typeof period === 'number' && Number.isFinite(period) && period >= min && period <= max;
}

/**
 * 从指标状态中提取指定指标的值（用于延迟验证等）。默认行为：state 为 null 或指标名不支持时返回 null；支持 K/D/J、MACD/DIF/DEA、EMA:n、PSY:n。
 *
 * @param state 指标状态对象（kdj、macd、ema、psy）
 * @param indicatorName 指标名称（K、D、J、MACD、DIF、DEA、EMA:n、PSY:n）
 * @returns 指标值，无效时返回 null
 */
export function getIndicatorValue(
  state: IndicatorState | null,
  indicatorName: string,
): number | null {
  if (!state) return null;

  const { kdj, macd, ema, psy } = state;

  // 处理 EMA:n 格式（例如 EMA:5, EMA:10）
  if (indicatorName.startsWith('EMA:')) {
    const periodStr = indicatorName.substring(4); // 提取周期部分
    const period = Number.parseInt(periodStr, 10);

    // 验证周期是否有效
    if (!validateEmaPeriod(period)) {
      return null;
    }

    // 从 ema 对象中提取对应周期的值
    const emaValue = ema?.[period];
    return emaValue !== undefined && Number.isFinite(emaValue) ? emaValue : null;
  }

  if (indicatorName.startsWith('PSY:')) {
    const periodStr = indicatorName.substring(4);
    const period = Number.parseInt(periodStr, 10);

    if (!validatePsyPeriod(period)) {
      return null;
    }

    const psyValue = psy?.[period];
    return psyValue !== undefined && Number.isFinite(psyValue) ? psyValue : null;
  }

  switch (indicatorName) {
    case 'K': {
      return kdj && Number.isFinite(kdj.k) ? (kdj.k ?? null) : null;
    }

    case 'D': {
      return kdj && Number.isFinite(kdj.d) ? (kdj.d ?? null) : null;
    }

    case 'J': {
      return kdj && Number.isFinite(kdj.j) ? (kdj.j ?? null) : null;
    }

    case 'MACD': {
      return macd && Number.isFinite(macd.macd) ? (macd.macd ?? null) : null;
    }

    case 'DIF': {
      return macd && Number.isFinite(macd.dif) ? (macd.dif ?? null) : null;
    }

    case 'DEA': {
      return macd && Number.isFinite(macd.dea) ? (macd.dea ?? null) : null;
    }

    default: {
      return null;
    }
  }
}

/**
 * 检查值是否为有效的有限数字。默认行为：非 number 或 NaN/Infinity 返回 false。
 *
 * @param value 待检查的值
 * @returns 为有限数字时返回 true，否则返回 false
 */
export function isValidNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 验证 EMA 周期是否在有效范围（1-250）。默认行为：非 number 或超出范围返回 false。
 *
 * @param period 待验证的 EMA 周期
 * @returns 在 1-250 范围内返回 true，否则返回 false
 */
export function validateEmaPeriod(period: unknown): period is number {
  return validatePeriodInRange(period, 1, 250);
}

/**
 * 验证 RSI 周期是否在有效范围（1-100）。默认行为：非 number 或超出范围返回 false。
 *
 * @param period 待验证的 RSI 周期
 * @returns 在 1-100 范围内返回 true，否则返回 false
 */
export function validateRsiPeriod(period: unknown): period is number {
  return validatePeriodInRange(period, 1, 100);
}

/**
 * 验证 PSY 周期是否在有效范围（1-100）。默认行为：非 number 或超出范围返回 false。
 *
 * @param period 待验证的 PSY 周期
 * @returns 在 1-100 范围内返回 true，否则返回 false
 */
export function validatePsyPeriod(period: unknown): period is number {
  return validatePeriodInRange(period, 1, 100);
}
