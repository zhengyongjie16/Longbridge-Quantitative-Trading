/**
 * Longbridge Decimal 兼容接口。
 * 类型用途：将 Longbridge SDK 返回的 Decimal 统一转为 number（toNumber）。
 * 数据来源：Longbridge SDK 返回值。
 * 使用范围：helpers、services 类型边界与依赖 Longbridge Decimal 的内部模块共享使用。
 */
export type DecimalLike = {
  toNumber: () => number;
};
