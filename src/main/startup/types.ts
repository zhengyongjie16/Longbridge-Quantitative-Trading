import type { Logger } from '../../utils/logger/types.js';
import type { MonitorConfig, MultiMonitorTradingConfig } from '../../types/config.js';
import type { Position } from '../../types/account.js';
import type { GateMode, SeatSymbolSnapshotEntry, SymbolRegistry } from '../../types/seat.js';
import type { MarketDataClient, RawOrderFromAPI, TradingDayInfo } from '../../types/services.js';
import type { WarrantListCacheConfig } from '../../services/autoSymbolFinder/types.js';

/**
 * 启动门禁的依赖注入对象。
 * 由 createStartupGate() 消费，仅在启动流程内部使用。
 */
export type StartupGateDeps = {
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly resolveTradingDayInfo: (currentTime: Date) => Promise<TradingDayInfo>;
  readonly isInSession: (currentTime: Date, isHalfDay: boolean) => boolean;
  readonly isInMorningOpenProtection: (currentTime: Date, minutes: number) => boolean;
  readonly isInAfternoonOpenProtection: (currentTime: Date, minutes: number) => boolean;
  readonly openProtection: {
    readonly morning: {
      readonly enabled: boolean;
      readonly minutes: number | null;
    };
    readonly afternoon: {
      readonly enabled: boolean;
      readonly minutes: number | null;
    };
  };
  readonly intervalMs: number;
  readonly logger: Logger;
};

/**
 * 启动门禁接口。
 * 由 createStartupGate() 返回，供启动流程调用 wait() 阻塞等待交易条件满足。
 */
export interface StartupGate {
  wait(params: { readonly mode: GateMode }): Promise<TradingDayInfo>;
}

/** 启动门禁内部状态（用于日志与循环判断） */
export type StartupGateState =
  | 'notTradingDay'
  | 'outOfSession'
  | 'openProtection'
  | 'ready'
  | null;

/**
 * buildSeatSnapshot() 的输入参数。
 * 来源于启动时从 API 获取的持仓、订单及监控配置，仅在启动席位准备流程中使用。
 */
export type SeatSnapshotInput = {
  readonly monitors: ReadonlyArray<
    Pick<
      MonitorConfig,
      'monitorSymbol' | 'autoSearchConfig' | 'longSymbol' | 'shortSymbol' | 'orderOwnershipMapping'
    >
  >;
  readonly positions: ReadonlyArray<Position>;
  readonly orders: ReadonlyArray<RawOrderFromAPI>;
};

/**
 * buildSeatSnapshot() 的返回结果。
 * 包含所有监控标的的席位快照条目，供启动席位准备流程消费。
 */
export type SeatSnapshot = {
  readonly entries: ReadonlyArray<SeatSymbolSnapshotEntry>;
};

/**
 * prepareSeatsOnStartup() 的依赖注入对象。
 * 由启动流程构造并传入，仅在启动席位准备阶段使用。
 */
export type PrepareSeatsOnStartupDeps = {
  readonly tradingConfig: MultiMonitorTradingConfig;
  readonly symbolRegistry: SymbolRegistry;
  readonly positions: ReadonlyArray<Position>;
  readonly orders: ReadonlyArray<RawOrderFromAPI>;
  readonly marketDataClient: MarketDataClient;
  readonly now: () => Date;
  readonly logger: Logger;
  readonly getTradingMinutesSinceOpen: (currentTime: Date) => number;
  readonly isWithinMorningOpenProtection: (currentTime: Date, minutes: number) => boolean;
  readonly warrantListCacheConfig?: WarrantListCacheConfig;
};

/**
 * prepareSeatsOnStartup() 的返回结果。
 * 包含启动时已准备好的席位标的列表，供主程序初始化 symbolRegistry 使用。
 */
export type PreparedSeats = {
  readonly seatSymbols: ReadonlyArray<SeatSymbolSnapshotEntry>;
};
