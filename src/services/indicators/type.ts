/**
 * 技术指标计算模块类型定义
 */

import type { CandleData, IndicatorSnapshot, KDJIndicator, MACDIndicator } from '../../types/index.js';

// ==================== 数据结构类型 ====================

/**
 * 对象池接口
 */
export type ObjectPool<T> = {
  acquire(): T;
  release(obj: T): void;
};

/**
 * 日志接口
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * 指标计算配置
 */
export type IndicatorConfig = {
  readonly debug?: boolean;
};

// ==================== 服务接口定义 ====================

/**
 * RSI 计算器接口
 */
export interface RSICalculator {
  calculate(validCloses: ReadonlyArray<number>, period: number): number | null;
}

/**
 * MFI 计算器接口
 */
export interface MFICalculator {
  calculate(candles: ReadonlyArray<CandleData>, period?: number): number | null;
}

/**
 * KDJ 计算器接口
 */
export interface KDJCalculator {
  calculate(candles: ReadonlyArray<CandleData>, period?: number): KDJIndicator | null;
}

/**
 * MACD 计算器接口
 */
export interface MACDCalculator {
  calculate(
    validCloses: ReadonlyArray<number>,
    fastPeriod?: number,
    slowPeriod?: number,
    signalPeriod?: number,
  ): MACDIndicator | null;
}

/**
 * EMA 计算器接口
 */
export interface EMACalculator {
  calculate(validCloses: ReadonlyArray<number>, period: number): number | null;
}

/**
 * 指标快照构建器接口
 */
export interface IndicatorSnapshotBuilder {
  build(
    symbol: string,
    candles: ReadonlyArray<CandleData>,
    rsiPeriods?: ReadonlyArray<number>,
    emaPeriods?: ReadonlyArray<number>,
  ): IndicatorSnapshot | null;
}

// ==================== 依赖类型定义 ====================

/**
 * 指标计算器依赖类型
 */
export type IndicatorCalculatorDeps = {
  readonly logger?: Logger;
  readonly config?: IndicatorConfig;
};

/**
 * KDJ 计算器依赖类型
 */
export type KDJCalculatorDeps = IndicatorCalculatorDeps & {
  readonly kdjObjectPool?: ObjectPool<{ k: number; d: number; j: number }>;
};

/**
 * MACD 计算器依赖类型
 */
export type MACDCalculatorDeps = IndicatorCalculatorDeps & {
  readonly macdObjectPool?: ObjectPool<{ dif: number; dea: number; macd: number }>;
};

/**
 * 指标快照构建器依赖类型
 */
export type IndicatorSnapshotBuilderDeps = {
  readonly rsiCalculator: RSICalculator;
  readonly mfiCalculator: MFICalculator;
  readonly kdjCalculator: KDJCalculator;
  readonly macdCalculator: MACDCalculator;
  readonly emaCalculator: EMACalculator;
};
