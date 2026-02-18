import type { OrderTypeConfig } from './signal.js';
import type { SignalConfig } from './signalConfig.js';

/**
 * 单个延迟验证配置
 * 用于配置买入或卖出的延迟验证参数
 */
export type SingleVerificationConfig = {
  /** 延迟验证时间（秒） */
  readonly delaySeconds: number;
  /** 需验证的指标列表（null 表示不验证） */
  readonly indicators: ReadonlyArray<string> | null;
};

/**
 * 延迟验证配置
 * 分别配置买入和卖出的延迟验证
 */
export type VerificationConfig = {
  /** 买入信号验证配置 */
  readonly buy: SingleVerificationConfig;
  /** 卖出信号验证配置 */
  readonly sell: SingleVerificationConfig;
};

/**
 * 数值范围配置
 * 用于解析 min/max 形式的范围参数
 */
export type NumberRange = {
  readonly min: number;
  readonly max: number;
};

/**
 * 自动寻标配置（单监控标的）
 */
export type AutoSearchConfig = {
  /** 自动寻标开关 */
  readonly autoSearchEnabled: boolean;
  /** 牛证最低距回收价百分比阈值（小数，正值，配置层百分比数值经 /100 转换而来） */
  readonly autoSearchMinDistancePctBull: number | null;
  /** 熊证最低距回收价百分比阈值（小数，负值，配置层百分比数值经 /100 转换而来） */
  readonly autoSearchMinDistancePctBear: number | null;
  /** 牛证分均成交额阈值 */
  readonly autoSearchMinTurnoverPerMinuteBull: number | null;
  /** 熊证分均成交额阈值 */
  readonly autoSearchMinTurnoverPerMinuteBear: number | null;
  /** 到期日最小月份 */
  readonly autoSearchExpiryMinMonths: number;
  /** 开盘延迟分钟数（仅早盘生效） */
  readonly autoSearchOpenDelayMinutes: number;
  /** 牛证距回收价换标阈值范围 */
  readonly switchDistanceRangeBull: NumberRange | null;
  /** 熊证距回收价换标阈值范围 */
  readonly switchDistanceRangeBear: NumberRange | null;
};

/**
 * 信号配置集
 * 包含四种交易信号的配置
 */
export type SignalConfigSet = {
  /** 买入做多配置 */
  readonly buycall: SignalConfig | null;
  /** 卖出做多配置 */
  readonly sellcall: SignalConfig | null;
  /** 买入做空配置 */
  readonly buyput: SignalConfig | null;
  /** 卖出做空配置 */
  readonly sellput: SignalConfig | null;
};

/**
 * 保护性清仓后的买入冷却配置
 */
export type LiquidationCooldownConfig =
  | {
      readonly mode: 'minutes';
      readonly minutes: number;
    }
  | {
      readonly mode: 'half-day';
    }
  | {
      readonly mode: 'one-day';
    };

/**
 * 单个监控标的的完整配置
 * 包含交易标的、风控参数和信号配置
 */
export type MonitorConfig = {
  /** 原始环境变量索引（对应 _1, _2 等后缀） */
  readonly originalIndex: number;
  /** 监控标的代码（如恒指期货） */
  readonly monitorSymbol: string;
  /** 做多标的代码（牛证） */
  readonly longSymbol: string;
  /** 做空标的代码（熊证） */
  readonly shortSymbol: string;
  /** 自动寻标配置 */
  readonly autoSearchConfig: AutoSearchConfig;
  /** 订单归属映射（stockName 缩写列表） */
  readonly orderOwnershipMapping: ReadonlyArray<string>;
  /** 单次目标交易金额 */
  readonly targetNotional: number;
  /** 单标的最大持仓市值 */
  readonly maxPositionNotional: number;
  /** 单日最大亏损 */
  readonly maxDailyLoss: number;
  /** 单标的最大浮亏 */
  readonly maxUnrealizedLossPerSymbol: number;
  /** 买入间隔时间（秒） */
  readonly buyIntervalSeconds: number;
  /** 保护性清仓后买入冷却配置（未配置时为 null） */
  readonly liquidationCooldown: LiquidationCooldownConfig | null;
  /** 延迟验证配置 */
  readonly verificationConfig: VerificationConfig;
  /** 信号配置集 */
  readonly signalConfig: SignalConfigSet;
  /** 智能平仓开关（true 时仅卖出盈利订单） */
  readonly smartCloseEnabled: boolean;
};

/**
 * 全局配置
 * 非监控标的特定的系统级配置
 */
export type GlobalConfig = {
  /** 末日保护开关（收盘前清仓） */
  readonly doomsdayProtection: boolean;
  /** 调试模式 */
  readonly debug: boolean;
  /** 开盘保护配置（早盘 + 午盘） */
  readonly openProtection: {
    /** 早盘开盘保护 */
    readonly morning: {
      /** 是否启用早盘开盘保护 */
      readonly enabled: boolean;
      /** 保护时长（分钟） */
      readonly minutes: number | null;
    };
    /** 午盘开盘保护 */
    readonly afternoon: {
      /** 是否启用午盘开盘保护 */
      readonly enabled: boolean;
      /** 保护时长（分钟） */
      readonly minutes: number | null;
    };
  };
  /** 订单价格修改最小间隔（秒） */
  readonly orderMonitorPriceUpdateInterval: number;
  /** 正常交易订单类型 */
  readonly tradingOrderType: OrderTypeConfig;
  /** 清仓订单类型 */
  readonly liquidationOrderType: OrderTypeConfig;
  /** 买入订单超时配置 */
  readonly buyOrderTimeout: {
    /** 是否启用超时检测 */
    readonly enabled: boolean;
    /** 超时时间（秒） */
    readonly timeoutSeconds: number;
  };
  /** 卖出订单超时配置 */
  readonly sellOrderTimeout: {
    /** 是否启用超时检测 */
    readonly enabled: boolean;
    /** 超时时间（秒） */
    readonly timeoutSeconds: number;
  };
};

/**
 * 多标的交易配置
 * 系统完整配置，包含所有监控标的和全局设置
 */
export type MultiMonitorTradingConfig = {
  /** 监控标的配置列表 */
  readonly monitors: ReadonlyArray<MonitorConfig>;
  /** 全局配置 */
  readonly global: GlobalConfig;
};
