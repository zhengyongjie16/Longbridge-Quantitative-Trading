/**
 * 主程序初始化模块
 *
 * 职责：
 * - 类型定义（RunOnceContext, CleanupContext）
 * - 工具函数（extractEmaPeriods, initMonitorState 等）
 * - 工厂函数（createMonitorContext, createCleanup）
 */

// 直接导出函数和类型，避免 re-export 模式
// 使用者应直接从对应的子模块导入

export {
  extractEmaPeriods,
  extractRsiPeriodsWithDefault,
  initMonitorState,
  releaseSnapshotObjects,
  releaseAllMonitorSnapshots,
  getPositions,
} from './utils.js';

export { createMonitorContext } from './monitorContext.js';

export { createCleanup } from './cleanup.js';

export type { RunOnceContext, CleanupContext } from './types.js';
