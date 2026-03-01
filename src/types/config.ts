import type { OrderTypeConfig } from './signal.js';
import type { SignalConfig } from './signalConfig.js';

/**
 * 单个延迟验证配置。
 * 类型用途：配置买入或卖出的延迟验证时间与需验证的指标列表，作为 VerificationConfig 的 buy/sell 字段类型。
 * 数据来源：配置解析（如 MonitorConfig.verificationConfig）。
 * 使用范围：延迟验证器、配置校验等；全项目可引用。
 */
export type SingleVerificationConfig = {

  /** 延迟验证时间（秒） */
  readonly delaySeconds: number;

  /** 需验证的指标列表（null 表示不验证） */
  readonly indicators: ReadonlyArray<string> | null;
};

/**
 * 延迟验证配置。
 * 类型用途：分别配置买入与卖出的延迟验证参数，作为 MonitorConfig.verificationConfig 的类型。
 * 数据来源：配置解析。
 * 使用范围：MonitorConfig、DelayedSignalVerifier 等；全项目可引用。
 */
export type VerificationConfig = {

  /** 买入信号验证配置 */
  readonly buy: SingleVerificationConfig;

  /** 卖出信号验证配置 */
  readonly sell: SingleVerificationConfig;
};

/**
 * 数值范围配置。
 * 类型用途：表示 min/max 形式的数值区间，作为 AutoSearchConfig 中换标阈值范围等字段类型。
 * 数据来源：配置解析。
 * 使用范围：AutoSearchConfig、自动寻标等；全项目可引用。
 */
export type NumberRange = {
  readonly min: number;
  readonly max: number;
};

/**
 * 自动寻标配置（单监控标的）。
 * 类型用途：单监控标的的自动寻标/换标参数，作为 MonitorConfig.autoSearchConfig 的类型。
 * 数据来源：配置解析。
 * 使用范围：MonitorConfig、autoSymbolManager、autoSymbolFinder 等；全项目可引用。
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

  /** 周期换标间隔（分钟，0 表示关闭） */
  readonly switchIntervalMinutes: number;

  /** 牛证距回收价换标阈值范围 */
  readonly switchDistanceRangeBull: NumberRange | null;

  /** 熊证距回收价换标阈值范围 */
  readonly switchDistanceRangeBear: NumberRange | null;
};

/**
 * 信号配置集。
 * 类型用途：四种交易信号（买多/卖多/买空/卖空）的配置集合，作为 MonitorConfig.signalConfig 的类型。
 * 数据来源：配置解析。
 * 使用范围：MonitorConfig、策略、信号处理等；全项目可引用。
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
 * 保护性清仓后的买入冷却配置。
 * 类型用途：保护性清仓后一段时间内禁止买入的策略（按分钟/半日/一日），作为 MonitorConfig.liquidationCooldown 的类型。
 * 数据来源：配置解析。
 * 使用范围：MonitorConfig、liquidationCooldown 服务等；全项目可引用。
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
 * 单个监控标的的完整配置。
 * 类型用途：单监控标的的交易标的、风控参数、信号配置与延迟验证等，作为 MonitorContext.config、RiskCheckContext.config 等类型。
 * 数据来源：配置解析（环境变量/配置文件）。
 * 使用范围：主循环、MonitorContext、信号处理、风控等；全项目可引用。
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

  /** 智能平仓开关（true 时启用三阶段智能平仓） */
  readonly smartCloseEnabled: boolean;

  /** 智能平仓第三阶段超时阈值（分钟，null 表示关闭） */
  readonly smartCloseTimeoutMinutes: number | null;
};

/**
 * 全局配置。
 * 类型用途：非监控标的特定的系统级配置（末日保护、开盘保护、订单类型与超时等），作为 MultiMonitorTradingConfig.global 的类型。
 * 数据来源：配置解析。
 * 使用范围：主程序、doomsdayProtection、orderMonitor 等；全项目可引用。
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
 * 多标的交易配置。
 * 类型用途：系统完整配置根类型，包含所有监控标的列表与全局配置，作为启动与主循环的配置入参。
 * 数据来源：配置解析（环境变量/配置文件）。
 * 使用范围：启动、主程序、gate 等；全项目可引用。
 */
export type MultiMonitorTradingConfig = {

  /** 监控标的配置列表 */
  readonly monitors: ReadonlyArray<MonitorConfig>;

  /** 全局配置 */
  readonly global: GlobalConfig;
};
