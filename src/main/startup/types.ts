/**
 * 启动流程类型定义模块
 *
 * 定义启动门禁和席位准备流程相关的类型：
 * - StartupGateDeps：启动门禁依赖项
 * - StartupGate：启动门禁接口（等待交易时段）
 * - SeatSnapshotInput / SeatSnapshot：席位快照输入和结果
 * - PrepareSeatsOnStartupDeps / PreparedSeats：启动席位准备依赖和结果
 *
 * 启动门禁模式：
 * - strict：严格模式，等待交易时段开始
 * - skip：跳过模式，用于开发测试
 */
import type { Logger } from '../../utils/logger/types.js';
import type {
  MarketDataClient,
  MonitorConfig,
  MultiMonitorTradingConfig,
  Position,
  RawOrderFromAPI,
  SeatSymbolSnapshotEntry,
  StartupGateMode,
  SymbolRegistry,
  TradingDayInfo,
} from '../../types/index.js';
import type { WarrantListCacheConfig } from '../../services/autoSymbolFinder/types.js';

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

export type StartupGate = {
  wait(params: { readonly mode: StartupGateMode }): Promise<TradingDayInfo>;
};

/** 启动门禁内部状态（用于日志与循环判断） */
export type StartupGateState =
  | 'notTradingDay'
  | 'outOfSession'
  | 'openProtection'
  | 'ready'
  | null;

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

export type SeatSnapshot = {
  readonly entries: ReadonlyArray<SeatSymbolSnapshotEntry>;
};

export type PrepareSeatsOnStartupDeps = {
  readonly tradingConfig: MultiMonitorTradingConfig;
  readonly symbolRegistry: SymbolRegistry;
  readonly positions: ReadonlyArray<Position>;
  readonly orders: ReadonlyArray<RawOrderFromAPI>;
  readonly marketDataClient: MarketDataClient;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => Date;
  readonly intervalMs: number;
  readonly logger: Logger;
  readonly getTradingMinutesSinceOpen: (currentTime: Date) => number;
  readonly isWithinMorningOpenProtection: (currentTime: Date, minutes: number) => boolean;
  readonly warrantListCacheConfig?: WarrantListCacheConfig;
};

export type PreparedSeats = {
  readonly seatSymbols: ReadonlyArray<SeatSymbolSnapshotEntry>;
};
