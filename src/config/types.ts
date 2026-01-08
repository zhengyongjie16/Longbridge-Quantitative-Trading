/**
 * 配置模块类型定义
 *
 * 包含只被 config 模块使用的类型
 * 被多个模块共用的类型应定义在 src/types/index.ts 中
 */

/**
 * 区域 URL 配置接口
 */
export interface RegionUrls {
  httpUrl: string;
  quoteWsUrl: string;
  tradeWsUrl: string;
}

/**
 * 验证结果接口
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * 交易配置验证结果接口
 */
export interface TradingValidationResult extends ValidationResult {
  missingFields: string[];
}

/**
 * 标的验证结果接口
 */
export interface SymbolValidationResult {
  valid: boolean;
  name: string | null;
  error: string | null;
}

