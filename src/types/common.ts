/**
 * 可转换为数字的值类型。
 * 类型用途：兼容 LongPort SDK 返回的 Decimal 与原始数值，用于价格、数量等字段的类型声明（如 RawOrderFromAPI）。
 * 数据来源：如适用；来自 LongPort API 返回或本地数字。
 * 使用范围：services、订单解析等；全项目可引用。
 */
export type DecimalLikeValue = string | number | null;
