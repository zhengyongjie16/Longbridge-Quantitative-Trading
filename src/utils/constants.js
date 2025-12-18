/**
 * 系统常量定义
 * 集中管理所有常量，便于维护和修改
 */

// ==================== 交易信号类型 ====================

/**
 * 交易信号类型定义
 * 使用更明确的命名以区分不同类型的操作
 */
export const SignalType = {
  // 做多标的（CALL）相关信号
  BUYCALL: "BUYCALL", // 买入做多标的（做多操作）
  SELLCALL: "SELLCALL", // 卖出做多标的（清仓操作）

  // 做空标的（PUT）相关信号
  BUYPUT: "BUYPUT", // 买入做空标的（做空操作）
  SELLPUT: "SELLPUT", // 卖出做空标的（平空仓操作）

  // 其他
  HOLD: "HOLD", // 持有，不操作
};

/**
 * 判断信号是否为买入操作（开仓）
 * @param {string} action 信号类型
 * @returns {boolean}
 */
export function isBuyAction(action) {
  return action === SignalType.BUYCALL || action === SignalType.BUYPUT;
}

// ==================== 交易时间配置 ====================

/**
 * 港股交易时间定义
 */
export const TradingHours = {
  // 上午交易时段
  MORNING_START: "09:30",
  MORNING_END: "12:00",

  // 下午交易时段
  AFTERNOON_START: "13:00",
  AFTERNOON_END: "16:00",

  // 半日交易
  HALF_DAY_END: "12:00",

  // 收盘前保护时间（分钟）
  CLOSE_BEFORE_15MIN: 15, // 收盘前15分钟拒绝买入
  CLOSE_BEFORE_5MIN: 5, // 收盘前5分钟强制清仓
};

// ==================== 时间延迟和缓存配置 ====================

/**
 * 系统时间配置（毫秒）
 */
export const Timeouts = {
  // 信号验证延迟（60秒）
  SIGNAL_VERIFICATION_DELAY: 60 * 1000,

  // 验证历史记录缓冲时间（5秒）
  VERIFICATION_HISTORY_BUFFER: 5 * 1000,

  // 验证历史记录最大保留时间（120秒）
  VERIFICATION_HISTORY_MAX: 120 * 1000,

  // 交易频率限制（60秒）
  TRADE_FREQUENCY_LIMIT: 60 * 1000,

  // 行情数据缓存TTL（1秒）
  QUOTE_CACHE_TTL: 1000,

  // 交易日信息缓存TTL（24小时）
  TRADING_DAY_CACHE_TTL: 24 * 60 * 60 * 1000,

  // 订单数据缓存TTL（5分钟）
  ORDER_CACHE_TTL: 5 * 60 * 1000,

  // 主循环执行间隔（1秒）
  MAIN_LOOP_INTERVAL: 1000,
};

// ==================== 风险控制阈值 ====================

/**
 * 风险控制阈值配置
 */
export const RiskThresholds = {
  // 牛证距离回收价最小百分比（0.5%）
  BULL_WARRANT_MIN_DISTANCE: 0.005,

  // 熊证距离回收价最小百分比（-0.5%）
  BEAR_WARRANT_MIN_DISTANCE: -0.005,

  // 监控标的价格最小值（防止使用错误价格）
  MIN_MONITOR_PRICE: 1,
};

// ==================== 技术指标阈值 ====================

/**
 * 技术指标默认参数
 */
export const IndicatorParams = {
  // RSI 周期
  RSI_PERIOD: 6,

  // MFI 周期
  MFI_PERIOD: 14,

  // KDJ 周期
  KDJ_PERIOD: 9,
  KDJ_K_PERIOD: 3,
  KDJ_D_PERIOD: 3,

  // MACD 参数
  MACD_FAST: 12,
  MACD_SLOW: 26,
  MACD_SIGNAL: 9,

  // K线数据获取数量
  CANDLESTICK_COUNT: 200,

  // K线周期（分钟）
  CANDLESTICK_PERIOD: 1,
};

/**
 * 买入做多信号阈值（BUYCALL）
 */
export const BuyCallThresholds = {
  // 条件1：四个指标需满足的阈值
  RSI_MAX: 20,
  MFI_MAX: 15,
  KDJ_D_MAX: 20,
  KDJ_J_MAX: -1,
  MIN_INDICATORS_MET: 3, // 至少3个指标满足

  // 条件2：J值单独阈值
  KDJ_J_EXTREME: -20,
};

/**
 * 卖出做多信号阈值（SELLCALL）
 */
export const SellCallThresholds = {
  // 条件1：四个指标需满足的阈值
  RSI_MIN: 80,
  MFI_MIN: 85,
  KDJ_D_MIN: 79,
  KDJ_J_MIN: 100,
  MIN_INDICATORS_MET: 3, // 至少3个指标满足

  // 条件2：J值单独阈值
  KDJ_J_EXTREME: 110,
};

/**
 * 买入做空信号阈值（BUYPUT）
 */
export const BuyPutThresholds = {
  // 条件1：四个指标需满足的阈值
  RSI_MIN: 80,
  MFI_MIN: 85,
  KDJ_D_MIN: 80,
  KDJ_J_MIN: 100,
  MIN_INDICATORS_MET: 3, // 至少3个指标满足

  // 条件2：J值单独阈值
  KDJ_J_EXTREME: 120,
};

/**
 * 卖出做空信号阈值（SELLPUT）
 */
export const SellPutThresholds = {
  // 条件1：四个指标需满足的阈值
  RSI_MAX: 20,
  MFI_MAX: 15,
  KDJ_D_MAX: 22,
  KDJ_J_MAX: 0,
  MIN_INDICATORS_MET: 3, // 至少3个指标满足

  // 条件2：J值单独阈值
  KDJ_J_EXTREME: -15,
};

// ==================== 对象池配置 ====================

/**
 * 对象池大小配置
 */
export const ObjectPoolSizes = {
  // 验证历史条目对象池
  VERIFICATION_ENTRY_POOL: 50,

  // 持仓数据对象池
  POSITION_OBJECT_POOL: 10,
};

// ==================== 日志配置 ====================

/**
 * 日志系统配置
 */
export const LogConfig = {
  // 日志队列最大长度
  MAX_QUEUE_SIZE: 1000,

  // 批处理日志条数
  BATCH_SIZE: 20,

  // 日志文件目录
  TRADES_DIR: "logs/trades",
  SYSTEM_DIR: "logs/system",
  ERRORS_DIR: "logs/errors",
};

// ==================== 订单配置 ====================

/**
 * 订单相关配置
 */
export const OrderConfig = {
  // 订单类型（增强限价单）
  ORDER_TYPE: "ELO",

  // 订单超时时间（毫秒）
  ORDER_TIMEOUT: 30 * 1000,
};
