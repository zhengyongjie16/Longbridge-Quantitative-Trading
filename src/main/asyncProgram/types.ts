/**
 * Program 模块共享类型定义
 */

/**
 * 处理器统计信息（买入/卖出处理器共用）
 */
export type ProcessorStats = {
  readonly processedCount: number;
  readonly successCount: number;
  readonly failedCount: number;
  readonly lastProcessTime: number | null;
};
