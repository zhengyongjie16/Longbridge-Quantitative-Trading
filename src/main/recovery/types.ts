import type { Logger } from '../../utils/logger/types.js';
import type { MonitorConfig, MultiMonitorTradingConfig } from '../../types/config.js';
import type { Position } from '../../types/account.js';
import type { SeatSymbolSnapshotEntry, SymbolRegistry } from '../../types/seat.js';
import type { MarketDataClient, RawOrderFromAPI } from '../../types/services.js';
import type { WarrantListCacheConfig } from '../../services/autoSymbolFinder/types.js';

/**
 * resolveSeatSnapshot() 的输入参数。
 * 类型用途：构建席位快照的入参，包含监控配置、持仓、订单。
 * 数据来源：启动时从 API 获取的持仓与订单，以及配置中的 monitors。
 * 使用范围：仅席位恢复流程（prepareSeatsForRuntime 等）使用。
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
 * resolveSeatSnapshot() 的返回结果。
 * 类型用途：包含所有监控标的的席位快照条目，供后续席位恢复与 symbolRegistry 初始化使用。
 * 数据来源：由 resolveSeatSnapshot(SeatSnapshotInput) 根据持仓、订单、配置计算返回。
 * 使用范围：仅席位恢复流程内部使用。
 */
export type SeatSnapshot = {
  readonly entries: ReadonlyArray<SeatSymbolSnapshotEntry>;
};

/**
 * prepareSeatsForRuntime() 的依赖注入对象。
 * 类型用途：统一表达交易日快照加载时恢复席位所需的配置、持仓、订单、行情客户端与时间依赖。
 * 数据来源：由运行时快照加载链路组装传入。
 * 使用范围：仅席位恢复流程使用。
 */
export type PrepareSeatsForRuntimeDeps = {
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
 * prepareSeatsForRuntime() 的返回结果。
 * 类型用途：包含当前恢复后已准备好的席位标的列表（seatSymbols）。
 * 数据来源：由 prepareSeatsForRuntime(PrepareSeatsForRuntimeDeps) 执行后返回。
 * 使用范围：仅运行时快照加载与相关测试使用。
 */
export type PreparedSeats = {
  readonly seatSymbols: ReadonlyArray<SeatSymbolSnapshotEntry>;
};

/**
 * 收集就绪席位标的列表的入参。
 * 类型用途：统一 collectSeatSymbols 所需的 monitors 与 symbolRegistry。
 * 数据来源：由 prepareSeatsForRuntime 在恢复完成后组装传入。
 * 使用范围：仅运行时席位恢复流程内部使用。
 */
export type CollectSeatSymbolsParams = Readonly<{
  monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol'>>;
  symbolRegistry: SymbolRegistry;
}>;

/**
 * 运行时恢复寻标参数。
 * 类型用途：封装 searchSeatSymbol 所需的监控标的、方向、自动寻标配置与当前时间。
 * 数据来源：由 prepareSeatsForRuntime 在尝试补空席位时组装传入。
 * 使用范围：仅运行时席位恢复流程内部使用。
 */
export type RuntimeRecoverySearchParams = Readonly<{
  monitorSymbol: string;
  direction: 'LONG' | 'SHORT';
  autoSearchConfig: MonitorConfig['autoSearchConfig'];
  currentTime: Date;
}>;
