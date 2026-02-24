/**
 * 席位状态枚举。
 * 类型用途：表示做多/做空席位的生命周期（READY 可用、SEARCHING 寻标中、SWITCHING 换标中、EMPTY 空席），用于 getSeatState/updateSeatState 等返回值及换标流程判断。
 * 数据来源：由 SymbolRegistry 内部状态维护。
 * 使用范围：SymbolRegistry、autoSymbolManager、启动/换标流程等；全项目可引用。
 */
export type SeatStatus = 'READY' | 'SEARCHING' | 'SWITCHING' | 'EMPTY';

/**
 * 席位状态信息。
 * 类型用途：描述单个席位的当前占用标的、状态、换标/寻标时间及回收价等，作为 getSeatState/updateSeatState 的入参与返回值。
 * 数据来源：由 SymbolRegistry 维护；callPrice 等来自配置 warrantList 透传。
 * 使用范围：SymbolRegistry、换标/寻标逻辑、setWarrantInfoFromCallPrice 等；全项目可引用。
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
  /** 最近一次进入 READY 状态时间戳（毫秒） */
  readonly lastSeatReadyAt: number | null;
  /** 回收价（从 warrantList 透传，做多/做空标的换标后用于 setWarrantInfoFromCallPrice） */
  readonly callPrice?: number | null;
  /** 当日连续寻标失败次数 */
  readonly searchFailCountToday: number;
  /** 当日冻结标记（值为 HK 日期 key，非 null 时表示冻结，midnight clear 重置） */
  readonly frozenTradingDayKey: string | null;
};

/**
 * 标的注册表接口。
 * 类型用途：依赖注入用接口，统一维护各监控标的做多/做空席位状态与版本号，供 resolveSeatBySymbol、换标流程等调用。
 * 数据来源：内部实现（如 startup/seat）维护；状态数据来自运行时更新。
 * 使用范围：主程序、MonitorContext、autoSymbolManager、orderRecorder 等；全项目可引用。
 */
export interface SymbolRegistry {
  /** 获取席位状态 */
  getSeatState: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => SeatState;
  /** 获取席位版本号 */
  getSeatVersion: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => number;
  /** 根据标的代码解析所属席位 */
  resolveSeatBySymbol: (symbol: string) => {
    monitorSymbol: string;
    direction: 'LONG' | 'SHORT';
    seatState: SeatState;
    seatVersion: number;
  } | null;
  /** 更新席位状态 */
  updateSeatState: (
    monitorSymbol: string,
    direction: 'LONG' | 'SHORT',
    nextState: SeatState,
  ) => SeatState;
  /** 递增席位版本号 */
  bumpSeatVersion: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => number;
}

/**
 * 运行模式。
 * 类型用途：区分生产/开发环境，影响日志级别、门禁等行为，作为启动与门禁逻辑的参数或配置。
 * 数据来源：配置（如环境变量）。
 * 使用范围：启动门禁、日志等；全项目可引用。
 */
export type RunMode = 'prod' | 'dev';

/**
 * 门禁模式。
 * 类型用途：控制启动与跨日流程中的门禁行为（strict 严格校验 / skip 跳过），作为 gate 等函数的参数。
 * 数据来源：配置或调用方传入。
 * 使用范围：startup/gate、跨日流程等；全项目可引用。
 */
export type GateMode = 'strict' | 'skip';

/**
 * 生命周期状态。
 * 类型用途：表示 7x24 跨日缓存治理的阶段性状态（ACTIVE / MIDNIGHT_CLEANING / MIDNIGHT_CLEANED / OPEN_REBUILDING / OPEN_REBUILD_FAILED），用于 LastState 与门禁判断。
 * 数据来源：lifecycle 模块内部状态机更新。
 * 使用范围：主循环、LastState、门禁、跨日流程等；全项目可引用。
 */
export type LifecycleState =
  | 'ACTIVE'
  | 'MIDNIGHT_CLEANING'
  | 'MIDNIGHT_CLEANED'
  | 'OPEN_REBUILDING'
  | 'OPEN_REBUILD_FAILED';

/**
 * 启动阶段的席位标的快照条目。
 * 类型用途：开盘重建与启动阶段快照的一条记录，表示某监控标的某方向的当前轮证代码。
 * 数据来源：启动时从 SymbolRegistry/席位状态序列化或从持久化恢复。
 * 使用范围：startup 开盘重建、席位快照；见调用方。
 */
export type SeatSymbolSnapshotEntry = {
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly symbol: string;
};
