/**
 * Utils 模块共享类型定义
 */

/**
 * 指标状态接口（用于获取指标值）
 */
export type IndicatorState = {
  readonly rsi?: Record<number, number> | null;
  readonly mfi?: number | null;
  readonly kdj?: { readonly k?: number; readonly d?: number; readonly j?: number } | null;
  readonly macd?: { readonly macd?: number; readonly dif?: number; readonly dea?: number } | null;
  readonly ema?: Record<number, number> | null;
};
