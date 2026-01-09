/**
 * 配置模块类型定义
 *
 * 包含只被 config 模块使用的类型
 * 被多个模块共用的类型应定义在 src/types/index.ts 中
 */

/**
 * 区域 URL 配置类型
 */
export type RegionUrls = {
  readonly httpUrl: string;
  readonly quoteWsUrl: string;
  readonly tradeWsUrl: string;
};

/**
 * 验证结果类型
 */
export type ValidationResult = {
  readonly valid: boolean;
  readonly errors: ReadonlyArray<string>;
};

/**
 * 交易配置验证结果类型
 */
export type TradingValidationResult = ValidationResult & {
  readonly missingFields: ReadonlyArray<string>;
};

/**
 * 标的验证结果类型
 */
export type SymbolValidationResult = {
  readonly valid: boolean;
  readonly name: string | null;
  readonly error: string | null;
};

