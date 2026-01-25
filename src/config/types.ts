/**
 * 配置模块类型定义
 *
 * 仅 config 模块内部使用的类型，跨模块共用类型定义在 src/types/index.ts
 */

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

