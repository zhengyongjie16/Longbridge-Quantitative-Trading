/**
 * 席位状态
 */
export type SeatStatus = 'READY' | 'SEARCHING' | 'SWITCHING' | 'EMPTY';

/**
 * 席位状态信息
 */
export type SeatState = {
  /** 当前占用标的 */
  readonly symbol: string | null;
  /** 席位状态 */
  readonly status: SeatStatus;
  /** 上次换标时间戳（毫秒） */
  readonly lastSwitchAt: number | null;
  /** 上次寻标时间戳（毫秒） */
  readonly lastSearchAt: number | null;
  /** 回收价（从 warrantList 透传，做多/做空标的换标后用于 setWarrantInfoFromCallPrice） */
  readonly callPrice?: number | null;
  /** 当日连续寻标失败次数 */
  readonly searchFailCountToday: number;
  /** 当日冻结标记（值为 HK 日期 key，非 null 时表示冻结，midnight clear 重置） */
  readonly frozenTradingDayKey: string | null;
};

/**
 * 标的注册表接口
 * 统一维护席位状态与版本号
 */
export interface SymbolRegistry {
  /** 获取席位状态 */
  getSeatState(monitorSymbol: string, direction: 'LONG' | 'SHORT'): SeatState;
  /** 获取席位版本号 */
  getSeatVersion(monitorSymbol: string, direction: 'LONG' | 'SHORT'): number;
  /** 根据标的代码解析所属席位 */
  resolveSeatBySymbol(symbol: string): {
    monitorSymbol: string;
    direction: 'LONG' | 'SHORT';
    seatState: SeatState;
    seatVersion: number;
  } | null;
  /** 更新席位状态 */
  updateSeatState(
    monitorSymbol: string,
    direction: 'LONG' | 'SHORT',
    nextState: SeatState,
  ): SeatState;
  /** 递增席位版本号 */
  bumpSeatVersion(monitorSymbol: string, direction: 'LONG' | 'SHORT'): number;
}

/**
 * 运行模式
 */
export type RunMode = 'prod' | 'dev';

/**
 * 门禁模式（启动门禁与运行时门禁共用）
 */
export type GateMode = 'strict' | 'skip';

/**
 * 生命周期状态（7x24 跨日缓存治理）
 */
export type LifecycleState =
  | 'ACTIVE'
  | 'MIDNIGHT_CLEANING'
  | 'MIDNIGHT_CLEANED'
  | 'OPEN_REBUILDING'
  | 'OPEN_REBUILD_FAILED';

/**
 * 启动阶段的席位标的快照条目
 */
export type SeatSymbolSnapshotEntry = {
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly symbol: string;
};
