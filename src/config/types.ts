/**
 * 配置模块类型定义
 *
 * 仅 config 模块内部使用的类型，跨模块共用类型定义在 src/types/index.ts
 */

import type { MonitorConfig } from '../types/index.js';

/** LongPort API 区域端点 URL */
export type RegionUrls = {
  readonly httpUrl: string;
  readonly quoteWsUrl: string;
  readonly tradeWsUrl: string;
};

/** 配置验证错误（含缺失字段列表） */
export type ConfigValidationError = Error & {
  readonly name: 'ConfigValidationError';
  readonly missingFields: ReadonlyArray<string>;
};

/** 受限数值配置 */
export type BoundedNumberConfig = {
  readonly env: NodeJS.ProcessEnv;
  readonly envKey: string;
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
};

/** 验证结果 */
export type ValidationResult = {
  readonly valid: boolean;
  readonly errors: ReadonlyArray<string>;
};

/** 交易配置验证结果（含缺失字段列表） */
export type TradingValidationResult = ValidationResult & {
  readonly missingFields: ReadonlyArray<string>;
};

export type SymbolValidationContext = {
  readonly prefix: string;
  readonly symbol: string;
  readonly envKey: string;
  readonly errors: string[];
  readonly missingFields: string[];
};

export type DuplicateSymbol = {
  readonly symbol: string;
  readonly index: number;
  readonly previousIndex: number;
};

export type RuntimeSymbolValidationInput = {
  readonly symbol: string;
  readonly label: string;
  readonly requireLotSize: boolean;
  readonly required: boolean;
};

export type RuntimeSymbolValidationResult = {
  readonly valid: boolean;
  readonly errors: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
};

export type SignalConfigKey = keyof MonitorConfig['signalConfig'];

