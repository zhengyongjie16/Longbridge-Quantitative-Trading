/**
 * LongPort Decimal 兼容接口。
 * 类型用途：将 LongPort SDK 返回的 Decimal 统一转为 number（toNumber）。
 * 数据来源：LongPort SDK 返回值。
 * 使用范围：仅 helpers 模块内部使用。
 */
export type DecimalLike = {
  toNumber: () => number;
};
