import type { LiquidationCooldownConfig } from '../../../types/config.js';
import type { LiquidationCooldownTracker } from '../../../services/liquidationCooldown/types.js';
import type { DailyLossTracker } from '../types.js';
import type { Logger } from '../../../utils/logger/types.js';

/**
 * 亏损偏移生命周期协调器接口。
 * 类型用途：在主循环每轮 tick 前调用 sync，扫描冷却过期事件并触发 dailyLossTracker 分段切换。
 * 数据来源：由 createLossOffsetLifecycleCoordinator 实现。
 * 使用范围：主程序 mainProgram 及 lifecycle 模块使用。
 */
export interface LossOffsetLifecycleCoordinator {
  /**
   * 同步冷却过期事件与分段切换。
   * 即使 canTradeNow=false 也必须调用，防止分段边界漂移。
   */
  readonly sync: (currentTimeMs: number) => void;
}

/**
 * 亏损偏移生命周期协调器依赖。
 * 类型用途：createLossOffsetLifecycleCoordinator 的依赖注入。
 * 数据来源：由主程序启动时组装传入。
 * 使用范围：仅 riskController/lossOffsetLifecycleCoordinator 模块使用。
 */
export type LossOffsetLifecycleCoordinatorDeps = {
  readonly liquidationCooldownTracker: LiquidationCooldownTracker;
  readonly dailyLossTracker: DailyLossTracker;
  readonly logger: Pick<Logger, 'info' | 'warn'>;

  /** 根据 monitorSymbol 和 direction 解析冷却配置 */
  readonly resolveCooldownConfig: (
    monitorSymbol: string,
    direction: 'LONG' | 'SHORT',
  ) => LiquidationCooldownConfig | null;
};
