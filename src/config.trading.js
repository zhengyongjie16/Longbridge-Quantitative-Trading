// 统一管理与交易相关的配置，避免在代码中硬编码
// 如需调整标的或金额，只需改这里或对应的环境变量

export const TRADING_CONFIG = {
  // 监控标的（用于计算指标和生成交易信号，例如 "HSI.HK"）
  monitorSymbol: process.env.MONITOR_SYMBOL ?? "HSI.HK",

  // 做多标的（不带 .HK 后缀，内部会自动规范为港股）
  // 当监控标的产生 BUY 信号时，买入此标的（做多操作）
  longSymbol: process.env.LONG_SYMBOL ?? "68547",

  // 做空标的（不带 .HK 后缀，内部会自动规范为港股）
  // 当监控标的产生 SELL 信号时，买入此标的（做空操作）
  shortSymbol: process.env.SHORT_SYMBOL ?? "63372",

  // 目标买入金额（HKD），会按 <= 此金额且尽量接近的方式计算股数
  targetNotional: Number(process.env.TARGET_NOTIONAL ?? 5000),

  // 做多标的的最小买卖单位（每手股数，作为后备值，优先使用从API获取的值）
  longLotSize: Number(process.env.LONG_LOT_SIZE ?? 100),

  // 做空标的的最小买卖单位（每手股数，作为后备值，优先使用从API获取的值）
  shortLotSize: Number(process.env.SHORT_LOT_SIZE ?? 100),

  // 单标的最大持仓市值（HKD），不允许超过此金额
  maxPositionNotional: Number(process.env.MAX_POSITION_NOTIONAL ?? 100000),

  // 单日最大亏损（HKD），超过后禁止继续开新仓
  maxDailyLoss: Number(process.env.MAX_DAILY_LOSS ?? 30000),

  // 是否在收盘前15分钟清空所有持仓（默认 true）
  // 港股当日收盘时间：下午 16:00
  // 收盘前15分钟：15:45-16:00（仅判断当日收盘，不包括上午收盘）
  clearPositionsBeforeClose: process.env.CLEAR_POSITIONS_BEFORE_CLOSE === "true",
};


