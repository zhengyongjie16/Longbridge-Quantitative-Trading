import type { Market } from 'longport';
import type { OrderTypeConfig, SignalType } from '../../types/signal.js';

/**
 * 对象池 - Signal（可池化交易信号）。
 * 类型用途：交易信号的可池化版本，供对象池复用以减少 GC 压力；属性可变以支持重置复用。
 * 数据来源：由策略模块生成，经延迟验证器和风险检查流水线处理后写入。
 * 使用范围：仅对象池内部使用，外部通过 acquire/release 访问。
 */
export type PoolableSignal = {
  symbol: string | null;
  symbolName: string | null;
  action: SignalType | null;
  reason?: string | null;
  orderTypeOverride?: OrderTypeConfig | null;
  isProtectiveLiquidation?: boolean | null;
  price?: number | null;
  lotSize?: number | null;
  quantity?: number | null;
  seatVersion?: number | null;
  /**
   * 信号触发时间（统一使用此字段）
   * - 立即信号：信号生成时间
   * - 延迟信号：延迟验证的基准时间（T0）
   * - 末日保护信号：信号生成时间
   */
  triggerTime?: Date | null;
  indicators1?: Record<string, number> | null;
  verificationHistory?: PoolableVerificationEntry[] | null;
  relatedBuyOrderIds?: readonly string[] | null;
};

/**
 * 对象池 - KDJ 指标（可池化）。
 * 类型用途：KDJ 技术指标的可池化版本，供对象池复用。
 * 数据来源：由策略模块计算后写入。
 * 使用范围：仅对象池内部使用，外部通过 acquire/release 访问。
 */
export type PoolableKDJ = {
  k: number | null;
  d: number | null;
  j: number | null;
};

/**
 * 对象池 - MACD 指标（可池化）。
 * 类型用途：MACD 技术指标的可池化版本，供对象池复用。
 * 数据来源：由策略模块计算后写入。
 * 使用范围：仅对象池内部使用，外部通过 acquire/release 访问。
 */
export type PoolableMACD = {
  macd: number | null;
  dif: number | null;
  dea: number | null;
};

/**
 * 对象池 - 监控数值（可池化）。
 * 类型用途：聚合单次主循环所需的全部技术指标数值，供对象池复用。
 * 数据来源：由行情服务和指标计算模块填充。
 * 使用范围：仅对象池内部使用，外部通过 acquire/release 访问。
 */
export type PoolableMonitorValues = {
  price: number | null;
  changePercent: number | null;
  ema: Record<number, number> | null;
  rsi: Record<number, number> | null;
  psy: Record<number, number> | null;
  mfi: number | null;
  kdj: PoolableKDJ | null;
  macd: PoolableMACD | null;
};

/**
 * 对象池 - Position（可池化持仓）。
 * 类型用途：持仓数据的可池化版本，供对象池复用；属性可变以支持重置复用。
 * 数据来源：由 LongPort SDK 账户持仓接口返回后转换填充。
 * 使用范围：仅对象池内部使用，外部通过 acquire/release 访问。
 */
export type PoolablePosition = {
  accountChannel: string | null;
  symbol: string | null;
  symbolName: string | null;
  quantity: number;
  availableQuantity: number;
  currency: string | null;
  costPrice: number;
  market: Market | string | null;
};

/**
 * 对象池 - VerificationEntry（可池化延迟验证条目）。
 * 类型用途：延迟验证历史记录条目的可池化版本，供对象池复用；属性可变以支持重置复用。
 * 数据来源：由延迟信号验证器写入，记录每次验证时的时间戳与指标快照。
 * 使用范围：仅对象池内部使用，外部通过 acquire/release 访问。
 */
export type PoolableVerificationEntry = {
  timestamp: Date | null;
  indicators: Record<string, number> | null;
};

/**
 * 对象池工厂函数类型。
 * 类型用途：定义对象池创建新对象的工厂函数签名，作为 createObjectPool 的参数。
 * 使用范围：仅对象池内部在对象不足时调用。
 */
export type Factory<T> = () => T;

/**
 * 对象池重置函数类型。
 * 类型用途：定义对象归还对象池时的重置函数签名，将对象属性清零以备复用，作为 createObjectPool 的参数。
 * 使用范围：仅对象池内部在 release 时自动调用。
 */
export type Reset<T> = (obj: T) => T;

/**
 * 对象池接口。
 * 类型用途：定义对象池的公开操作契约（获取、释放单个、批量释放）。
 * 数据来源：由 createObjectPool 实现并返回。
 * 使用范围：供业务模块通过 acquire/release/releaseAll 管理可复用对象的生命周期。
 */
export interface ObjectPool<T> {
  acquire: () => T;
  release: (obj: T | null | undefined) => void;
  releaseAll: (objects: ReadonlyArray<T> | null | undefined) => void;
}
