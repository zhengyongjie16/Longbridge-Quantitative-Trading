/**
 * 全局常量模块
 *
 * 统一管理项目中使用的所有常量，包括：
 * - 时间相关：毫秒换算、时区偏移
 * - 交易相关：目标金额、K线配置、主循环间隔
 * - 验证相关：延迟信号验证的时间窗口配置
 * - 日志相关：流超时配置
 * - API相关：重试策略、缓存TTL
 * - 监控相关：价格/指标变化检测阈值
 * - 信号相关：交易信号类型定义
 */
import { OrderStatus } from 'longport';
import type { OrderTypeConfig, SignalType } from '../types/index.js';

type OrderStatusValue = typeof OrderStatus[keyof typeof OrderStatus];

/** 时间相关常量 */
export const TIME = {
  /** 每秒的毫秒数 */
  MILLISECONDS_PER_SECOND: 1000,
  /** 北京时区偏移量（毫秒），用于 UTC 转北京时间 */
  BEIJING_TIMEZONE_OFFSET_MS: 8 * 60 * 60 * 1000,
} as const;

/** 交易相关常量 */
export const TRADING = {
  /** 默认目标金额（港币），单次开仓的目标市值 */
  DEFAULT_TARGET_NOTIONAL: 5000,
  /** K线周期，用于获取行情数据 */
  CANDLE_PERIOD: '1m' as const,
  /** K线数量，获取的历史K线条数 */
  CANDLE_COUNT: 200,
  /** 主循环执行间隔（毫秒），mainProgram 的执行频率 */
  INTERVAL_MS: 1000,
} as const;

/** 自动寻标相关常量 */
export const AUTO_SYMBOL_SEARCH_COOLDOWN_MS = 30_000;
export const AUTO_SYMBOL_WARRANT_LIST_CACHE_TTL_MS = 3_000;

/** 指标默认周期常量 */
export const DEFAULT_EMA_PERIOD = 7;
export const DEFAULT_RSI_PERIOD = 6;
export const DEFAULT_PSY_PERIOD = 13;

/**
 * 延迟信号验证相关常量
 * 用于 DelayedSignalVerifier 模块，验证开仓信号的趋势持续性
 */
export const VERIFICATION = {
  /** 验证时间点1偏移量（秒），信号触发后首次验证 */
  TIME_OFFSET_1_SECONDS: 5,
  /** 验证时间点2偏移量（秒），信号触发后二次验证 */
  TIME_OFFSET_2_SECONDS: 10,
  /** 验证时间点误差容忍度（毫秒） */
  TIME_TOLERANCE_MS: 5 * 1000,
  /** 验证窗口开始偏移量（秒），相对于信号触发时间 */
  WINDOW_START_OFFSET_SECONDS: -5,
  /** 验证窗口结束偏移量（秒），相对于信号触发时间 */
  WINDOW_END_OFFSET_SECONDS: 10,
  /** 验证就绪延迟时间（秒），信号注册后等待验证的时间 */
  READY_DELAY_SECONDS: 10,
  /** 验证通过信号冷却时间（秒），同标的同方向在此时间内只允许一个信号进入风险检查 */
  VERIFIED_SIGNAL_COOLDOWN_SECONDS: 10,
} as const;

/** 日志相关常量，用于 pino 日志系统 */
export const LOGGING = {
  /** 文件流 drain 超时时间（毫秒），程序退出时等待日志写入 */
  DRAIN_TIMEOUT_MS: 5000,
  /** 控制台流 drain 超时时间（毫秒） */
  CONSOLE_DRAIN_TIMEOUT_MS: 3000,
} as const;

/** API 相关常量，用于 LongPort API 调用 */
export const API = {
  /** 默认重试次数，API 调用失败时的重试上限 */
  DEFAULT_RETRY_COUNT: 2,
  /** 默认重试延迟（毫秒） */
  DEFAULT_RETRY_DELAY_MS: 300,
  /** 交易日缓存 TTL（毫秒），避免频繁查询交易日历 */
  TRADING_DAY_CACHE_TTL_MS: 24 * 60 * 60 * 1000,
} as const;

/** 行情监控相关常量，用于 MarketMonitor 检测价格/指标变化 */
export const MONITOR = {
  /** 价格变化检测阈值，低于此值不触发更新 */
  PRICE_CHANGE_THRESHOLD: 0.001,
  /** 技术指标变化检测阈值（EMA/RSI/MFI/KDJ/MACD） */
  INDICATOR_CHANGE_THRESHOLD: 0.001,
  /** 涨跌幅变化检测阈值（百分比） */
  CHANGE_PERCENT_THRESHOLD: 0.01,
} as const;

/** 订单相关常量 */
export const ORDER_PRICE_DIFF_THRESHOLD = 0.001;

/** 未成交订单状态集合（New/PartialFilled/WaitToNew/WaitToReplace/PendingReplace） */
export const PENDING_ORDER_STATUSES = new Set<OrderStatusValue>([
  OrderStatus.New,
  OrderStatus.PartialFilled,
  OrderStatus.WaitToNew,
  OrderStatus.WaitToReplace,
  OrderStatus.PendingReplace,
]) as ReadonlySet<OrderStatusValue>;

/** 风险检查相关常量（牛熊证） */
/** 牛证最低距离回收价百分比（低于此值拒绝买入） */
export const BULL_WARRANT_MIN_DISTANCE_PERCENT = 0.35;
/** 熊证最高距离回收价百分比（高于此值拒绝买入） */
export const BEAR_WARRANT_MAX_DISTANCE_PERCENT = -0.35;
/** 牛证触发清仓的距离回收价百分比（低于此值触发保护清仓） */
export const BULL_WARRANT_LIQUIDATION_DISTANCE_PERCENT = 0.3;
/** 熊证触发清仓的距离回收价百分比（高于此值触发保护清仓） */
export const BEAR_WARRANT_LIQUIDATION_DISTANCE_PERCENT = -0.3;
/** 监控标的价格最小有效值（低于此值视为异常） */
export const MIN_MONITOR_PRICE_THRESHOLD = 1;
/** 牛熊证当前价格最小阈值（小于或等于拒绝买入） */
export const MIN_WARRANT_PRICE_THRESHOLD = 0.015;
/** 价格格式化小数位数 */
export const DEFAULT_PRICE_DECIMALS = 3;
/** 百分比格式化小数位数 */
export const DEFAULT_PERCENT_DECIMALS = 2;
/** 牛熊证距离回收价清仓订单类型 */
export const WARRANT_LIQUIDATION_ORDER_TYPE: OrderTypeConfig = 'ELO';

/** 标的代码格式正则（ticker.region） */
export const SYMBOL_WITH_REGION_REGEX = /^[A-Z0-9]+\.[A-Z]{2,5}$/;

/** 账户渠道映射表 */
export const ACCOUNT_CHANNEL_MAP: Record<string, string> = {
  lb_papertrading: '模拟交易',
  paper_trading: '模拟交易',
  papertrading: '模拟交易',
  real_trading: '实盘交易',
  realtrading: '实盘交易',
  live: '实盘交易',
  demo: '模拟交易',
};

/** 信号类型常量（内部使用） */
const SIGNAL_ACTIONS = {
  BUYCALL: 'BUYCALL',
  SELLCALL: 'SELLCALL',
  BUYPUT: 'BUYPUT',
  SELLPUT: 'SELLPUT',
  HOLD: 'HOLD',
} as const;

/** 有效的交易信号集合，不包含 HOLD（仅用于判断是否需要执行交易） */
export const VALID_SIGNAL_ACTIONS = new Set<SignalType>([
  SIGNAL_ACTIONS.BUYCALL,
  SIGNAL_ACTIONS.SELLCALL,
  SIGNAL_ACTIONS.BUYPUT,
  SIGNAL_ACTIONS.SELLPUT,
]);

/** 信号操作描述映射，用于日志输出 */
export const ACTION_DESCRIPTIONS: Record<SignalType, string> = {
  BUYCALL: '买入做多',
  BUYPUT: '买入做空',
  SELLCALL: '卖出做多',
  SELLPUT: '卖出做空',
  HOLD: '持有',
};
