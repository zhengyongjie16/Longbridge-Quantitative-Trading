/**
 * 策略模块工具函数
 *
 * 纯工具：指标校验、延迟验证判断、指标显示字符串、信号分流。
 */
import { isValidNumber } from '../../utils/helpers/indicatorHelpers.js';
import type { IndicatorSnapshot } from '../../types/quote.js';
import type { Signal } from '../../types/signal.js';
import type { SingleVerificationConfig } from '../../types/config.js';
import type { SignalWithCategory } from './types.js';

/**
 * 判断是否需要延迟验证
 * @param config 验证配置
 * @returns true 需要延迟验证，false 立即执行
 */
export function needsDelayedVerification(config: SingleVerificationConfig): boolean {
  return config.delaySeconds > 0 && (config.indicators?.length ?? 0) > 0;
}

function hasValidRsiValue(rsi: IndicatorSnapshot['rsi']): boolean {
  return rsi != null && typeof rsi === 'object' && Object.values(rsi).some((v) => isValidNumber(v));
}

/**
 * 验证基本指标有效性（RSI、MFI、KDJ）
 * @returns true 所有基本指标有效
 */
export function validateBasicIndicators(state: IndicatorSnapshot): boolean {
  const { rsi, mfi, kdj } = state;
  return (
    hasValidRsiValue(rsi) &&
    isValidNumber(mfi) &&
    kdj !== null &&
    isValidNumber(kdj.d) &&
    isValidNumber(kdj.j)
  );
}

/**
 * 验证所有指标有效性（基本指标 + MACD + 价格）
 * @returns true 所有指标有效
 */
export function validateAllIndicators(state: IndicatorSnapshot): boolean {
  const { macd, price } = state;
  return (
    validateBasicIndicators(state) &&
    macd !== null &&
    isValidNumber(macd.macd) &&
    isValidNumber(price)
  );
}

function formatKdjSegment(kdj: IndicatorSnapshot['kdj']): string {
  if (kdj == null) return '';
  const kdjParts: string[] = [];
  if (isValidNumber(kdj.k)) kdjParts.push(`K=${kdj.k.toFixed(3)}`);
  if (isValidNumber(kdj.d)) kdjParts.push(`D=${kdj.d.toFixed(3)}`);
  if (isValidNumber(kdj.j)) kdjParts.push(`J=${kdj.j.toFixed(3)}`);
  return kdjParts.length > 0 ? `KDJ(${kdjParts.join(',')})` : '';
}

/**
 * 构建指标状态显示字符串
 * @returns 格式化的指标值字符串，用于日志记录
 */
export function buildIndicatorDisplayString(state: IndicatorSnapshot): string {
  const { rsi, mfi, kdj } = state;
  const parts: string[] = [];

  if (rsi && typeof rsi === 'object') {
    const periods = Object.keys(rsi)
      .map((p) => Number.parseInt(p, 10))
      .filter((p) => Number.isFinite(p))
      .sort((a, b) => a - b);
    for (const period of periods) {
      const rsiValue = rsi[period];
      if (isValidNumber(rsiValue)) {
        parts.push(`RSI${period}(${rsiValue.toFixed(3)})`);
      }
    }
  }
  if (isValidNumber(mfi)) {
    parts.push(`MFI(${mfi.toFixed(3)})`);
  }
  const kdjStr = formatKdjSegment(kdj);
  if (kdjStr) parts.push(kdjStr);

  return parts.join('、');
}

/** 将信号按类型分流到对应数组 */
export function pushSignalToCorrectArray(
  result: SignalWithCategory | null,
  immediateSignals: Signal[],
  delayedSignals: Signal[],
): void {
  if (result === null) return;
  if (result.isImmediate) {
    immediateSignals.push(result.signal);
  } else {
    delayedSignals.push(result.signal);
  }
}
