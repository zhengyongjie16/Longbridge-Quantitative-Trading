import type { Logger } from '../../utils/logger/types.js';
import type { MonitorConfig, MultiMonitorTradingConfig } from '../../types/config.js';
import type { Position } from '../../types/account.js';
import type { GateMode, SeatSymbolSnapshotEntry, SymbolRegistry } from '../../types/seat.js';
import type { MarketDataClient, RawOrderFromAPI, TradingDayInfo } from '../../types/services.js';
import type { WarrantListCacheConfig } from '../../services/autoSymbolFinder/types.js';

/**
 * 启动门禁的依赖注入对象（创建 StartupGate 时的参数）。
 * 类型用途：createStartupGate() 的入参，提供时间、交易日解析、时段判断、开盘保护、轮询间隔、日志等。
 * 数据来源：由启动流程（gate/seat）组装并传入 createStartupGate。
 * 使用范围：仅启动流程内部使用。
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
 * 启动门禁接口（行为契约）。
 * 类型用途：启动时阻塞等待交易条件满足（wait），由 createStartupGate() 返回。
 * 数据来源：createStartupGate(StartupGateDeps) 返回；wait 内部依赖 TradingDayInfo 等。
 * 使用范围：仅启动流程（如 main/index）调用，内部使用。
 */
export interface StartupGate {
  wait: (params: { readonly mode: GateMode }) => Promise<TradingDayInfo>;
}

/**
 * 启动门禁内部状态（轮询结果状态）。
 * 类型用途：门禁内部用于日志与轮询判断，表示当前未开市原因或已就绪。
 * 数据来源：由 StartupGate 实现根据当前时间与配置计算得出。
 * 使用范围：仅启动门禁模块内部使用。
 */
export type StartupGateState = 'notTradingDay' | 'outOfSession' | 'openProtection' | 'ready' | null;

/**
 * buildSeatSnapshot() 的输入参数。
 * 类型用途：构建席位快照的入参，包含监控配置、持仓、订单。
 * 数据来源：启动时从 API 获取的持仓与订单，以及配置中的 monitors。
 * 使用范围：仅启动席位准备流程（prepareSeatsOnStartup 等）使用。
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
 * 类型用途：包含所有监控标的的席位快照条目，供后续席位准备与 symbolRegistry 初始化使用。
 * 数据来源：由 buildSeatSnapshot(SeatSnapshotInput) 根据持仓、订单、配置计算返回。
 * 使用范围：仅启动席位准备流程内部使用。
 */
export type SeatSnapshot = {
  readonly entries: ReadonlyArray<SeatSymbolSnapshotEntry>;
};

/**
 * prepareSeatsOnStartup() 的依赖注入对象（启动席位准备时的参数）。
 * 类型用途：启动时准备席位所需的配置、持仓、订单、行情客户端、时间与保护判断等。
 * 数据来源：由启动流程从配置与已获取的持仓/订单等组装并传入。
 * 使用范围：仅启动席位准备阶段使用。
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
 * 类型用途：包含启动时已准备好的席位标的列表（seatSymbols），供主程序初始化 symbolRegistry。
 * 数据来源：由 prepareSeatsOnStartup(PrepareSeatsOnStartupDeps) 执行后返回。
 * 使用范围：仅启动流程与主程序初始化使用。
 */
export type PreparedSeats = {
  readonly seatSymbols: ReadonlyArray<SeatSymbolSnapshotEntry>;
};
