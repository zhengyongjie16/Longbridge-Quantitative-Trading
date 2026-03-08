import type { Position } from '../../types/account.js';
import type { MultiMonitorTradingConfig } from '../../types/config.js';
import type { DoomsdayProtection } from '../../core/doomsdayProtection/types.js';
import type { LossOffsetLifecycleCoordinator } from '../../core/riskController/lossOffsetLifecycleCoordinator/types.js';
import type { DayLifecycleManager } from '../../main/lifecycle/types.js';
import type { LastState, MonitorContext } from '../../types/state.js';
import type { MarketDataClient, Trader } from '../../types/services.js';
import type { GateMode } from '../../types/seat.js';
import type { Logger } from '../../utils/logger/types.js';
import type { SystemRuntimeStateStore, GatePolicySnapshot } from '../runtime/types.js';
import type { Quote } from '../../types/quote.js';
import type { MainProgramContext } from '../../main/mainProgram/types.js';

/**
 * 单次 tick 的交易日运行时输入。
 * 类型用途：承载 lifecycle tick 与最终门禁快照都需要复用的交易日/时段事实。
 * 数据来源：由 GatePolicyResolver 在读取交易日历与时段规则后生成。
 * 使用范围：仅 app/tradingDay 切片内部使用。
 */
export type TradingDayRuntimeInputs = {
  readonly currentTime: Date;
  readonly dayKey: string | null;
  readonly isTradingDay: boolean;
  readonly isHalfDay: boolean;
  readonly canTradeNow: boolean;
  readonly openProtectionActive: boolean;
};

/**
 * 门禁解析结果。
 * 类型用途：承载单次 trading-day tick 的完整门禁状态，供 tradingDayTick/mainProgram/monitor tick 共享。
 * 数据来源：由 GatePolicyResolver 与 lifecycle tick 联合解析得到。
 * 使用范围：app/tradingDay 切片内部与 mainProgram 调用方。
 */
export type ResolvedGatePolicy = GatePolicySnapshot & {
  readonly currentTime: Date;
};

/**
 * 门禁解析器依赖。
 * 类型用途：创建 GatePolicyResolver 时注入主循环门禁所需依赖。
 * 数据来源：由主入口装配层组装。
 * 使用范围：仅 app/tradingDay/gatePolicyResolver 使用。
 */
export type GatePolicyResolverDeps = {
  readonly marketDataClient: Pick<MarketDataClient, 'isTradingDay'>;
  readonly lastState: LastState;
  readonly tradingConfig: Pick<MultiMonitorTradingConfig, 'global'>;
  readonly monitorContexts: ReadonlyMap<string, MonitorContext>;
  readonly runtimeGateMode: GateMode;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  readonly getHKDateKey: (currentTime: Date) => string | null;
  readonly isInContinuousHKSession: (currentTime: Date, isHalfDay: boolean) => boolean;
  readonly isWithinMorningOpenProtection: (currentTime: Date, minutes: number) => boolean;
  readonly isWithinAfternoonOpenProtection: (currentTime: Date, minutes: number) => boolean;
  readonly systemRuntimeStateStore?: SystemRuntimeStateStore;
};

/**
 * 门禁解析器契约。
 * 类型用途：封装主循环单次 tick 的 lifecycle 输入解析与最终门禁快照生成流程。
 * 数据来源：由 createGatePolicyResolver 返回。
 * 使用范围：TradingDayTickUseCase。
 */
export interface GatePolicyResolver {
  resolveLifecycleInputs: (currentTime: Date) => Promise<TradingDayRuntimeInputs>;
  resolveFinalPolicy: (params: {
    readonly runtimeInputs: TradingDayRuntimeInputs;
    readonly lifecycleState: ResolvedGatePolicy['lifecycleState'];
    readonly isTradingEnabled: boolean;
  }) => ResolvedGatePolicy;
}

/**
 * TradingDayTickUseCase 的依赖。
 * 类型用途：创建 trading-day tick 用例时注入 lifecycle、doomsday 与 runtime store 等依赖。
 * 数据来源：由主入口装配层组装。
 * 使用范围：仅 app/tradingDay/tradingDayTickUseCase 使用。
 */
export type TradingDayTickUseCaseDeps = {
  readonly gatePolicyResolver: GatePolicyResolver;
  readonly lastState: LastState;
  readonly marketDataClient: MarketDataClient;
  readonly tradingConfig: MultiMonitorTradingConfig;
  readonly monitorContexts: ReadonlyMap<string, MonitorContext>;
  readonly trader: Trader;
  readonly doomsdayProtection: DoomsdayProtection;
  readonly lossOffsetLifecycleCoordinator: LossOffsetLifecycleCoordinator;
  readonly dayLifecycleManager: DayLifecycleManager;
  readonly logger: Pick<Logger, 'info'>;
};

/**
 * TradingDayTickUseCase 的执行结果。
 * 类型用途：向 mainProgram 返回当前 tick 的门禁结果、持仓快照与后续编排决策。
 * 数据来源：由 TradingDayTickUseCase.execute 生成。
 * 使用范围：mainProgram。
 */
export type TradingDayTickResult = {
  readonly gatePolicy: ResolvedGatePolicy;
  readonly positions: ReadonlyArray<Position>;
  readonly shouldProcessMainFlow: boolean;
};

/**
 * MonitorTickUseCase 执行参数。
 * 类型用途：封装单 monitor tick 所需的上下文、行情与门禁快照。
 * 数据来源：由 mainProgram 遍历 monitorContexts 时组装。
 * 使用范围：仅 app/tradingDay/monitorTickUseCase 使用。
 */
export type MonitorTickParams = {
  readonly monitorContext: MonitorContext;
  readonly quotesMap: ReadonlyMap<string, Quote | null>;
  readonly gatePolicy: ResolvedGatePolicy;
};

/**
 * MonitorTickUseCase 的依赖。
 * 类型用途：创建单 monitor tick 用例时注入主程序共享上下文。
 * 数据来源：由主入口装配层组装。
 * 使用范围：仅 app/tradingDay/monitorTickUseCase 使用。
 */
export type MonitorTickUseCaseDeps = {
  readonly mainContext: MainProgramContext;
};
