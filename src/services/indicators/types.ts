/**
 * 技术指标模块类型定义
 *
 * 仅 indicators 模块内部使用的类型，跨模块类型在 src/types/index.js
 */
import type { IndicatorSnapshot } from '../../types/index.js';

/** 指标计算缓存条目 */
export type IndicatorCalculationCacheEntry = {
  readonly snapshot: IndicatorSnapshot;
  readonly timestamp: number;
  readonly dataFingerprint: string;
};
