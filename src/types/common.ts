/**
 * 公共工具类型
 *
 * 功能：
 * - 定义通用的工具类型
 */

/**
 * 可转换为数字的值类型
 * 兼容 LongPort SDK 的 Decimal 类型
 */
export type DecimalLikeValue = string | number | null;
