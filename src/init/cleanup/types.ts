/**
 * 清理模块类型定义
 */

import type { IndicatorCache } from '../../main/asyncProgram/indicatorCache/types.js';
import type { BuyProcessor } from '../../main/asyncProgram/buyProcessor/types.js';
import type { SellProcessor } from '../../main/asyncProgram/sellProcessor/types.js';
import type { LastState, MonitorContext } from '../../types/index.js';

/**
 * 清理上下文接口
 * 包含程序退出时需要清理的资源
 */
export type CleanupContext = {
  readonly buyProcessor: BuyProcessor;
  readonly sellProcessor: SellProcessor;
  readonly monitorContexts: Map<string, MonitorContext>;
  readonly indicatorCache: IndicatorCache;
  readonly lastState: LastState;
};
