/**
 * @module types/common
 * @description 公共工具类型定义
 *
 * 定义通用的工具类型
 */

/**
 * 可转换为数字的值类型
 * 兼容 LongPort SDK 的 Decimal 类型
 */
export type DecimalLikeValue = string | number | null;
