import {
  TradeContext,
  OrderSide,
  OrderType,
  OrderStatus,
  TimeInForceType,
  Decimal,
} from "longport";
import { createConfig } from "./config.js";
import { TRADING_CONFIG } from "./config.trading.js";
import { logger } from "./logger.js";
import fs from "node:fs";
import path from "node:path";

const decimalToNumber = (decimalLike) =>
  decimalLike && typeof decimalLike.toNumber === "function"
    ? decimalLike.toNumber()
    : Number(decimalLike ?? 0);

/**
 * 规范化港股代码，自动添加 .HK 后缀（如果还没有）
 * @param {string} symbol 标的代码，例如 "68547" 或 "68547.HK"
 * @returns {string} 规范化后的代码，例如 "68547.HK"
 */
function normalizeHKSymbol(symbol) {
  if (!symbol || typeof symbol !== "string") {
    return symbol;
  }
  // 如果已经包含 .HK、.US 等后缀，直接返回
  if (symbol.includes(".")) {
    return symbol;
  }
  // 否则添加 .HK 后缀
  return `${symbol}.HK`;
}

const DEFAULT_ORDER_CONFIG = {
  // 来自统一交易配置，可通过环境变量覆盖
  symbol: TRADING_CONFIG.longSymbol,
  // 默认目标买入金额（以 HKD 计），实际买入会取 <= 该金额且最接近的整数股数
  targetNotional: TRADING_CONFIG.targetNotional,
  // 仅在无法根据价格计算数量时作为兜底数量（使用做多标的的最小买卖单位）
  quantity: TRADING_CONFIG.longLotSize,
  // 使用增强限价单（ELO）进行委托
  orderType: OrderType.ELO,
  timeInForce: TimeInForceType.Day,
  remark: "QuantDemo",
};

const toDecimal = (value) => {
  if (value instanceof Decimal) {
    return value;
  }
  if (typeof value === "number" || typeof value === "string") {
    return new Decimal(value);
  }
  return Decimal.ZERO();
};

/**
 * 记录交易到文件
 */
function recordTrade(tradeRecord) {
  try {
    const logDir = path.join(process.cwd(), "logs");
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    const today = new Date().toISOString().split("T")[0];
    const logFile = path.join(logDir, `trades_${today}.json`);
    
    let trades = [];
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, "utf-8");
      try {
        trades = JSON.parse(content);
      } catch (e) {
        trades = [];
      }
    }
    
    trades.push({
      ...tradeRecord,
      timestamp: new Date().toISOString(),
    });
    
    fs.writeFileSync(logFile, JSON.stringify(trades, null, 2), "utf-8");
  } catch (err) {
    logger.error("写入交易记录失败", err);
  }
}

/**
 * 交易执行骨架，用于根据策略信号下单。
 * 真实策略中，你需要完善风险控制、仓位管理等逻辑。
 * TradeContext 文档见：
 * https://longportapp.github.io/openapi/nodejs/modules.html
 */
export class Trader {
  constructor(config = null, orderOptions = {}) {
    this._config = config ?? createConfig();
    this._ctxPromise = TradeContext.new(this._config);
    this._orderOptions = { ...DEFAULT_ORDER_CONFIG, ...orderOptions };
    // 规范化港股代码，自动添加 .HK 后缀
    if (this._orderOptions.symbol) {
      this._orderOptions.symbol = normalizeHKSymbol(this._orderOptions.symbol);
    }
    // 记录每个标的的最后交易时间（用于限制交易频率）
    this._lastTradeTime = new Map();
    // 记录上次获取未成交订单的时间（用于限制获取频率为每三分钟一次）
    this._lastPendingOrdersFetchTime = null;
    // 缓存的未成交订单数据
    this._cachedPendingOrders = null;
    // 记录上次检查今日是否有订单的时间（用于限制检查频率）
    this._lastHasOrdersCheckTime = null;
    // 缓存的今日是否有订单的结果
    this._cachedHasOrders = null;
  }

  getTargetSymbol() {
    return this._orderOptions.symbol;
  }

  getTargetQuantity() {
    return decimalToNumber(this._orderOptions.quantity ?? 0);
  }

  async getAccountSnapshot() {
    const ctx = await this._ctxPromise;
    const balances = await ctx.accountBalance();
    const primary = balances?.[0];
    if (!primary) {
      return null;
    }

    const totalCash = decimalToNumber(primary.totalCash);
    const netAssets = decimalToNumber(primary.netAssets);
    const positionValue = netAssets - totalCash;

    return {
      currency: primary.currency ?? "HKD",
      totalCash,
      netAssets,
      positionValue,
    };
  }

  async getStockPositions(symbols = null) {
    const ctx = await this._ctxPromise;
    // stockPositions 接受 Array<string> | undefined | null，直接传递即可
    const resp = await ctx.stockPositions(symbols);
    const channels = resp?.channels ?? [];
    if (!channels.length) {
      return [];
    }

    return channels.flatMap((channel) =>
      (channel.positions ?? []).map((pos) => ({
        accountChannel: channel.accountChannel ?? "N/A",
        symbol: pos.symbol,
        symbolName: pos.symbolName,
        quantity: decimalToNumber(pos.quantity),
        availableQuantity: decimalToNumber(pos.availableQuantity),
        currency: pos.currency,
        costPrice: decimalToNumber(pos.costPrice),
        market: pos.market,
      }))
    );
  }

  /**
   * 获取今日未成交订单（带缓存，每三分钟最多获取一次）
   * @param {string[]} symbols 标的代码数组，如果为null或空数组则获取所有标的的订单
   * @returns {Promise<Array>} 未成交订单列表
   */
  async getPendingOrdersWithCache(symbols = null) {
    const now = Date.now();
    const threeMinutes = 3 * 60 * 1000; // 3分钟 = 180000毫秒
    
    // 检查是否需要重新获取订单
    const shouldFetch = 
      !this._lastPendingOrdersFetchTime || 
      (now - this._lastPendingOrdersFetchTime >= threeMinutes);
    
    if (shouldFetch) {
      // 需要重新获取订单
      try {
        this._cachedPendingOrders = await this.getPendingOrders(symbols);
        this._lastPendingOrdersFetchTime = now;
        logger.debug(`[订单缓存] 重新获取未成交订单，共 ${this._cachedPendingOrders.length} 个`);
      } catch (err) {
        logger.warn("获取未成交订单失败，使用缓存数据", err?.message ?? err);
        // 如果获取失败，尝试使用缓存数据
        if (this._cachedPendingOrders === null) {
          this._cachedPendingOrders = [];
        }
      }
    } else {
      // 使用缓存数据
      const timeSinceLastFetch = Math.floor((now - this._lastPendingOrdersFetchTime) / 1000);
      logger.debug(`[订单缓存] 使用缓存的未成交订单（距离上次获取 ${timeSinceLastFetch} 秒）`);
    }
    
    // 返回缓存的订单（如果没有缓存则返回空数组）
    return this._cachedPendingOrders ?? [];
  }

  /**
   * 获取今日未成交订单（实际调用API）
   * @param {string[]} symbols 标的代码数组，如果为null或空数组则获取所有标的的订单
   * @returns {Promise<Array>} 未成交订单列表
   */
  async getPendingOrders(symbols = null) {
    const ctx = await this._ctxPromise;
    try {
      // 过滤出未成交订单（New, PartialFilled, WaitToNew等状态）
      const pendingStatuses = new Set([
        OrderStatus.New,
        OrderStatus.PartialFilled,
        OrderStatus.WaitToNew,
        OrderStatus.WaitToReplace,
        OrderStatus.PendingReplace,
      ]);
      
      let allOrders = [];
      
      if (!symbols || symbols.length === 0) {
        // 如果没有指定标的，获取所有订单
        allOrders = await ctx.todayOrders(undefined);
      } else {
        // 如果指定了标的，分别查询每个标的（因为 symbol 参数只接受单个字符串）
        const normalizedSymbols = symbols.map(s => normalizeHKSymbol(s));
        const orderPromises = normalizedSymbols.map(symbol => 
          ctx.todayOrders({ symbol }).catch(err => {
            logger.warn(`获取标的 ${symbol} 的订单失败`, err?.message ?? err);
            return []; // 单个标的查询失败时返回空数组，不影响其他标的
          })
        );
        const orderArrays = await Promise.all(orderPromises);
        allOrders = orderArrays.flat();
      }
      
      // 如果指定了标的，还需要在客户端再次过滤（因为可能获取了所有订单）
      const normalizedTargetSymbols = symbols && symbols.length > 0
        ? new Set(symbols.map(s => normalizeHKSymbol(s)))
        : null;
      
      return allOrders
        .filter((order) => {
          // 先过滤状态
          if (!pendingStatuses.has(order.status)) {
            return false;
          }
          // 如果指定了标的，再过滤标的
          if (normalizedTargetSymbols) {
            const normalizedOrderSymbol = normalizeHKSymbol(order.symbol);
            return normalizedTargetSymbols.has(normalizedOrderSymbol);
          }
          return true;
        })
        .map((order) => ({
          orderId: order.orderId,
          symbol: order.symbol,
          side: order.side,
          submittedPrice: decimalToNumber(order.price),
          quantity: decimalToNumber(order.quantity),
          executedQuantity: decimalToNumber(order.executedQuantity),
          status: order.status,
          orderType: order.orderType,
        }));
    } catch (err) {
      logger.error("获取未成交订单失败", err?.message ?? err);
      return [];
    }
  }

  /**
   * 撤销订单
   * @param {string} orderId 订单ID
   */
  async cancelOrder(orderId) {
    const ctx = await this._ctxPromise;
    try {
      await ctx.cancelOrder(orderId);
      logger.info(`[订单撤销成功] 订单ID=${orderId}`);
      return true;
    } catch (err) {
      logger.error(`[订单撤销失败] 订单ID=${orderId}`, err?.message ?? err);
      return false;
    }
  }

  /**
   * 检查今日是否有交易（包括已成交和未成交的订单，带缓存）
   * @param {string[]} symbols 标的代码数组
   * @returns {Promise<boolean>} true表示今日有交易，false表示今日无交易
   */
  async hasTodayOrdersWithCache(symbols) {
    const now = Date.now();
    const oneMinute = 60 * 1000; // 1分钟 = 60000毫秒
    
    // 检查是否需要重新检查
    const shouldCheck = 
      this._lastHasOrdersCheckTime === null || 
      (now - this._lastHasOrdersCheckTime >= oneMinute);
    
    if (shouldCheck) {
      // 需要重新检查
      try {
        this._cachedHasOrders = await this.hasTodayOrders(symbols);
        this._lastHasOrdersCheckTime = now;
        logger.debug(`[订单检查] 今日${this._cachedHasOrders ? '有' : '无'}交易`);
      } catch (err) {
        logger.debug("检查今日订单失败，使用缓存结果", err?.message ?? err);
        // 如果检查失败，使用缓存结果，如果没有缓存则假设有订单（保守策略）
        if (this._cachedHasOrders === null) {
          this._cachedHasOrders = true;
        }
      }
    }
    
    return this._cachedHasOrders ?? true; // 默认假设有订单（保守策略）
  }

  /**
   * 检查今日是否有交易（实际调用API）
   * @param {string[]} symbols 标的代码数组
   * @returns {Promise<boolean>} true表示今日有交易，false表示今日无交易
   */
  async hasTodayOrders(symbols) {
    const ctx = await this._ctxPromise;
    try {
      let allOrders = [];
      
      if (!symbols || symbols.length === 0) {
        // 如果没有指定标的，获取所有订单
        allOrders = await ctx.todayOrders(undefined);
      } else {
        // 如果指定了标的，分别查询每个标的
        const normalizedSymbols = symbols.map(s => normalizeHKSymbol(s));
        const orderPromises = normalizedSymbols.map(symbol => 
          ctx.todayOrders({ symbol }).catch(err => {
            logger.debug(`检查标的 ${symbol} 的今日订单失败`, err?.message ?? err);
            return []; // 单个标的查询失败时返回空数组
          })
        );
        const orderArrays = await Promise.all(orderPromises);
        allOrders = orderArrays.flat();
      }
      
      return allOrders.length > 0;
    } catch (err) {
      logger.debug("检查今日订单失败", err?.message ?? err);
      // 如果检查失败，假设有订单（保守策略，避免漏掉监控）
      return true;
    }
  }

  /**
   * 实时监控价格并管理未成交订单
   * 规则：
   * - 如果当前价格高于委托价格0.002元及以上，撤销该委托单
   * - 如果当前价格低于委托价格，立即以当前价格重新委托
   * @param {Object} longQuote 做多标的的行情数据
   * @param {Object} shortQuote 做空标的的行情数据
   */
  async monitorAndManageOrders(longQuote, shortQuote) {
    const ctx = await this._ctxPromise;
    const longSymbol = normalizeHKSymbol(TRADING_CONFIG.longSymbol);
    const shortSymbol = normalizeHKSymbol(TRADING_CONFIG.shortSymbol);
    
    // 先检查今日是否有交易，如果没有交易则无需监控（带缓存，每分钟检查一次）
    const hasOrders = await this.hasTodayOrdersWithCache([longSymbol, shortSymbol]);
    if (!hasOrders) {
      logger.debug("[订单监控] 今日无交易，跳过订单监控");
      return;
    }
    
    // 获取所有未成交订单（带频率限制：每三分钟最多获取一次）
    const pendingOrders = await this.getPendingOrdersWithCache([longSymbol, shortSymbol]);
    
    if (pendingOrders.length === 0) {
      return; // 没有未成交订单，无需处理
    }
    
    logger.info(`[订单监控] 发现 ${pendingOrders.length} 个未成交订单，开始检查价格...`);
    
    for (const order of pendingOrders) {
      const normalizedOrderSymbol = normalizeHKSymbol(order.symbol);
      let currentPrice = null;
      
      // 获取标的的当前价格
      if (normalizedOrderSymbol === longSymbol && longQuote) {
        currentPrice = longQuote.price;
      } else if (normalizedOrderSymbol === shortSymbol && shortQuote) {
        currentPrice = shortQuote.price;
      }
      
      if (!currentPrice || !Number.isFinite(currentPrice)) {
        logger.warn(
          `[订单监控] 无法获取标的 ${order.symbol} 的当前价格，跳过处理订单 ${order.orderId}`
        );
        continue;
      }
      
      const orderPrice = order.submittedPrice;
      const priceDiff = currentPrice - orderPrice;
      
      // 判断是买入订单还是卖出订单
      const isBuyOrder = order.side === OrderSide.Buy;
      
      if (isBuyOrder) {
        // 买入订单：如果当前价格高于委托价格0.002元及以上，撤销订单
        if (priceDiff >= 0.002) {
          logger.info(
            `[订单监控] 买入订单 ${order.orderId} 当前价格(${currentPrice.toFixed(3)}) 高于委托价格(${orderPrice.toFixed(3)}) ${priceDiff.toFixed(3)}元，撤销订单`
          );
          const cancelSuccess = await this.cancelOrder(order.orderId);
          
          // 只有撤销成功才重新委托
          if (cancelSuccess && currentPrice < orderPrice) {
            logger.info(
              `[订单监控] 当前价格(${currentPrice.toFixed(3)}) 低于原委托价格(${orderPrice.toFixed(3)})，以当前价格重新委托`
            );
            await this._resubmitOrderAtPrice(
              ctx,
              order,
              currentPrice,
              longSymbol,
              shortSymbol
            );
          } else if (!cancelSuccess) {
            logger.warn(
              `[订单监控] 订单 ${order.orderId} 撤销失败，跳过重新委托`
            );
          }
        } else if (currentPrice < orderPrice) {
          // 当前价格低于委托价格，撤销原订单并以当前价格重新委托
          logger.info(
            `[订单监控] 买入订单 ${order.orderId} 当前价格(${currentPrice.toFixed(3)}) 低于委托价格(${orderPrice.toFixed(3)})，撤销并重新委托`
          );
          const cancelSuccess = await this.cancelOrder(order.orderId);
          
          // 只有撤销成功才重新委托
          if (cancelSuccess) {
            await this._resubmitOrderAtPrice(
              ctx,
              order,
              currentPrice,
              longSymbol,
              shortSymbol
            );
          } else {
            logger.warn(
              `[订单监控] 订单 ${order.orderId} 撤销失败，跳过重新委托`
            );
          }
        }
      } else {
        // 卖出订单：如果当前价格低于委托价格0.002元及以上，撤销订单
        if (priceDiff <= -0.002) {
          logger.info(
            `[订单监控] 卖出订单 ${order.orderId} 当前价格(${currentPrice.toFixed(3)}) 低于委托价格(${orderPrice.toFixed(3)}) ${Math.abs(priceDiff).toFixed(3)}元，撤销订单`
          );
          const cancelSuccess = await this.cancelOrder(order.orderId);
          
          // 只有撤销成功才重新委托
          if (cancelSuccess && currentPrice > orderPrice) {
            logger.info(
              `[订单监控] 当前价格(${currentPrice.toFixed(3)}) 高于原委托价格(${orderPrice.toFixed(3)})，以当前价格重新委托`
            );
            await this._resubmitOrderAtPrice(
              ctx,
              order,
              currentPrice,
              longSymbol,
              shortSymbol
            );
          } else if (!cancelSuccess) {
            logger.warn(
              `[订单监控] 订单 ${order.orderId} 撤销失败，跳过重新委托`
            );
          }
        } else if (currentPrice > orderPrice) {
          // 当前价格高于委托价格，撤销原订单并以当前价格重新委托
          logger.info(
            `[订单监控] 卖出订单 ${order.orderId} 当前价格(${currentPrice.toFixed(3)}) 高于委托价格(${orderPrice.toFixed(3)})，撤销并重新委托`
          );
          const cancelSuccess = await this.cancelOrder(order.orderId);
          
          // 只有撤销成功才重新委托
          if (cancelSuccess) {
            await this._resubmitOrderAtPrice(
              ctx,
              order,
              currentPrice,
              longSymbol,
              shortSymbol
            );
          } else {
            logger.warn(
              `[订单监控] 订单 ${order.orderId} 撤销失败，跳过重新委托`
            );
          }
        }
      }
    }
  }

  /**
   * 以指定价格重新提交订单
   * @private
   */
  async _resubmitOrderAtPrice(ctx, originalOrder, newPrice, longSymbol, shortSymbol) {
    const normalizedSymbol = normalizeHKSymbol(originalOrder.symbol);
    const isShortSymbol = normalizedSymbol === normalizeHKSymbol(shortSymbol);
    
    // 验证价格
    if (!Number.isFinite(newPrice) || newPrice <= 0) {
      logger.error(
        `[重新委托失败] 订单 ${originalOrder.orderId} 价格无效：${newPrice}`
      );
      return;
    }
    
    // 计算剩余数量（原数量 - 已成交数量）
    const remainingQty = originalOrder.quantity - originalOrder.executedQuantity;
    if (remainingQty <= 0) {
      logger.warn(
        `[重新委托] 订单 ${originalOrder.orderId} 已全部成交，无需重新委托`
      );
      return;
    }
    
    // 获取最小买卖单位（需要从行情数据获取，这里使用配置值作为后备）
    let lotSize = isShortSymbol ? TRADING_CONFIG.shortLotSize : TRADING_CONFIG.longLotSize;
    if (!Number.isFinite(lotSize) || lotSize <= 0) {
      lotSize = 100; // 默认值
    }
    
    // 确保数量是最小买卖单位的整数倍
    const adjustedQty = Math.floor(remainingQty / lotSize) * lotSize;
    if (adjustedQty <= 0 || adjustedQty < lotSize) {
      logger.error(
        `[重新委托失败] 订单 ${originalOrder.orderId} 剩余数量 ${remainingQty} 不符合最小买卖单位 ${lotSize}，调整后数量=${adjustedQty}`
      );
      return;
    }
    
    // 检查交易频率限制
    if (!this._canTradeNow(originalOrder.symbol)) {
      const lastTime = this._lastTradeTime.get(normalizeHKSymbol(originalOrder.symbol));
      const waitSeconds = Math.ceil((60 * 1000 - (Date.now() - lastTime)) / 1000);
      logger.warn(
        `[重新委托失败] 订单 ${originalOrder.orderId} 标的 ${originalOrder.symbol} 在1分钟内已交易过，需等待 ${waitSeconds} 秒`
      );
      return;
    }
    
    const orderPayload = {
      symbol: originalOrder.symbol,
      orderType: OrderType.ELO, // 使用增强限价单
      side: originalOrder.side,
      timeInForce: TimeInForceType.Day,
      submittedQuantity: toDecimal(adjustedQty),
      submittedPrice: toDecimal(newPrice),
      remark: "价格优化重新委托",
    };
    
    // 定义操作描述（在 try-catch 外部，以便错误处理时使用）
    const actionDesc = isShortSymbol
      ? originalOrder.side === OrderSide.Buy
        ? "买入做空标的（做空）"
        : "卖出做空标的（平空仓）"
      : originalOrder.side === OrderSide.Buy
      ? "买入做多标的（做多）"
      : "卖出做多标的（清仓）";
    
    try {
      const resp = await ctx.submitOrder(orderPayload);
      const orderId =
        resp?.orderId ?? resp?.toString?.() ?? resp ?? "UNKNOWN_ORDER_ID";
      
      logger.info(
        `[重新委托成功] ${actionDesc} ${orderPayload.symbol} 数量=${adjustedQty}（原剩余=${remainingQty}） 价格=${newPrice.toFixed(3)} 订单ID=${orderId}`
      );
      
      // 更新最后交易时间
      this._updateLastTradeTime(originalOrder.symbol);
      
      // 记录交易
      recordTrade({
        orderId: String(orderId),
        symbol: orderPayload.symbol,
        action: actionDesc,
        side: originalOrder.side === OrderSide.Buy ? "BUY" : "SELL",
        quantity: String(adjustedQty),
        price: String(newPrice),
        orderType: "增强限价单",
        status: "REPLACED",
        reason: `价格优化重新委托（原订单ID=${originalOrder.orderId}）`,
      });
    } catch (err) {
      const errorMessage = err?.message ?? String(err);
      const errorStr = String(errorMessage).toLowerCase();
      
      // 分析常见错误原因
      let errorReason = "未知错误";
      if (errorStr.includes("lot size") || errorStr.includes("买卖单位")) {
        errorReason = "数量不符合最小买卖单位要求";
      } else if (errorStr.includes("balance") || errorStr.includes("余额") || errorStr.includes("资金")) {
        errorReason = "账户余额不足";
      } else if (errorStr.includes("price") || errorStr.includes("价格")) {
        errorReason = "价格无效或超出限制";
      } else if (errorStr.includes("frequency") || errorStr.includes("频率") || errorStr.includes("too many")) {
        errorReason = "交易频率过高";
      } else if (errorStr.includes("market") || errorStr.includes("市场") || errorStr.includes("trading")) {
        errorReason = "市场状态不允许交易（可能已收盘或暂停交易）";
      } else if (errorStr.includes("position") || errorStr.includes("持仓")) {
        errorReason = "持仓数量不足（卖出订单）";
      }
      
      logger.error(
        `[重新委托失败] ${actionDesc} ${originalOrder.symbol} 数量=${adjustedQty} 价格=${newPrice.toFixed(3)} 原订单ID=${originalOrder.orderId}`,
        `错误原因：${errorReason}，错误信息：${errorMessage}`
      );
      
      // 记录失败交易到文件
      recordTrade({
        orderId: "FAILED",
        symbol: originalOrder.symbol,
        action: isShortSymbol
          ? originalOrder.side === OrderSide.Buy
            ? "买入做空标的（做空）"
            : "卖出做空标的（平空仓）"
          : originalOrder.side === OrderSide.Buy
          ? "买入做多标的（做多）"
          : "卖出做多标的（清仓）",
        side: originalOrder.side === OrderSide.Buy ? "BUY" : "SELL",
        quantity: String(adjustedQty),
        price: String(newPrice),
        orderType: "增强限价单",
        status: "REPLACED_FAILED",
        error: errorMessage,
        errorReason: errorReason,
        reason: `价格优化重新委托失败（原订单ID=${originalOrder.orderId}）`,
      });
    }
  }

  /**
   * 检查标的是否在1分钟内已经交易过
   * @param {string} symbol 标的代码
   * @returns {boolean} true表示可以交易，false表示需要等待
   */
  _canTradeNow(symbol) {
    const normalizedSymbol = normalizeHKSymbol(symbol);
    const lastTime = this._lastTradeTime.get(normalizedSymbol);
    
    if (!lastTime) {
      return true; // 从未交易过，可以交易
    }
    
    const now = Date.now();
    const timeDiff = now - lastTime;
    const oneMinute = 60 * 1000; // 1分钟 = 60000毫秒
    
    return timeDiff >= oneMinute;
  }

  /**
   * 更新标的的最后交易时间
   * @param {string} symbol 标的代码
   */
  _updateLastTradeTime(symbol) {
    const normalizedSymbol = normalizeHKSymbol(symbol);
    this._lastTradeTime.set(normalizedSymbol, Date.now());
  }

  /**
   * 根据策略信号提交订单。支持做多和做空标的：
   * - 做多标的：BUY=买入做多标的（做多），SELL=卖出做多标的（清仓）
   * - 做空标的：SELL=买入做空标的（做空），BUY=卖出做空标的（平空仓）
   *
   * @param {{symbol: string, action: "BUY" | "SELL" | "HOLD", reason: string}[]} signals
   */
  async executeSignals(signals) {
    const ctx = await this._ctxPromise;
    const longSymbol = normalizeHKSymbol(TRADING_CONFIG.longSymbol);
    const shortSymbol = normalizeHKSymbol(TRADING_CONFIG.shortSymbol);

    for (const s of signals) {
      if (s.action === "HOLD") {
        logger.info(`[HOLD] ${s.symbol} - ${s.reason}`);
        continue;
      }

      const normalizedSignalSymbol = normalizeHKSymbol(s.symbol);
      const isShortSymbol = normalizedSignalSymbol === shortSymbol;
      const targetSymbol = isShortSymbol ? shortSymbol : longSymbol;

      // 检查交易频率限制：每个标的每分钟内只能交易一次
      if (!this._canTradeNow(targetSymbol)) {
        const lastTime = this._lastTradeTime.get(normalizeHKSymbol(targetSymbol));
        const waitSeconds = Math.ceil((60 * 1000 - (Date.now() - lastTime)) / 1000);
        logger.warn(
          `[交易频率限制] 标的 ${targetSymbol} 在1分钟内已交易过，需等待 ${waitSeconds} 秒后才能再次交易`
        );
        continue;
      }

      if (isShortSymbol) {
        // 做空标的：SELL信号=买入做空标的（做空），BUY信号=卖出做空标的（平空仓）
        const actualAction = s.action === "SELL" ? "买入做空标的（做空）" : "卖出做空标的（平空仓）";
        logger.info(
          `[交易计划] ${actualAction} ${targetSymbol} - ${s.reason}`
        );
      } else {
        // 做多标的：BUY信号=买入做多标的（做多），SELL信号=卖出做多标的（清仓）
        const actualAction = s.action === "BUY" ? "买入做多标的（做多）" : "卖出做多标的（清仓）";
        logger.info(
          `[交易计划] ${actualAction} ${targetSymbol} - ${s.reason}`
        );
      }

      await this._submitTargetOrder(ctx, s, targetSymbol, isShortSymbol);
    }
  }

  async _submitTargetOrder(ctx, signal, targetSymbol, isShortSymbol = false) {
    // 对于做空标的：SELL信号=买入做空标的（做空），BUY信号=卖出做空标的（平空仓）
    // 对于做多标的：BUY信号=买入做多标的（做多），SELL信号=卖出做多标的（清仓）
    let side;
    if (isShortSymbol) {
      // 做空标的：SELL信号→买入（做空），BUY信号→卖出（平空仓）
      side = signal.action === "SELL" ? OrderSide.Buy : OrderSide.Sell;
    } else {
      side = signal.action === "BUY" ? OrderSide.Buy : OrderSide.Sell;
    }

    const {
      quantity,
      targetNotional,
      orderType,
      timeInForce,
      remark,
      price: overridePrice,
    } = this._orderOptions;
    const symbol = targetSymbol;

    let submittedQtyDecimal;
    
    // 判断是否需要清仓（平仓）
    const needClosePosition = 
      (isShortSymbol && side === OrderSide.Sell) || // 做空标的的BUY信号=卖出做空标的（平空仓）
      (!isShortSymbol && side === OrderSide.Sell); // 做多标的的SELL信号=卖出做多标的（清仓）
    
    if (needClosePosition) {
      // 平仓：按当前持仓可用数量全部清仓
      const resp = await ctx.stockPositions([symbol]);
      const channels = resp?.channels ?? [];
      let totalAvailable = 0;
      for (const ch of channels) {
        const positions = ch.positions ?? [];
        for (const pos of positions) {
          if (pos.symbol === symbol) {
            totalAvailable += decimalToNumber(pos.availableQuantity);
          }
        }
      }
      if (!Number.isFinite(totalAvailable) || totalAvailable <= 0) {
        logger.warn(
          `[跳过订单] 当前无可用持仓，无需平仓。symbol=${symbol}, available=${totalAvailable}`
        );
        return;
      }
      submittedQtyDecimal = toDecimal(totalAvailable);
    } else {
      // BUY 信号：按目标金额（例如 5000 HKD）计算买入数量，
      // 尽量使 成交金额 <= targetNotional 且尽量接近 targetNotional
      const pricingSource =
        overridePrice ?? signal?.price ?? signal?.snapshotPrice ?? null;
      if (!Number.isFinite(Number(pricingSource)) || pricingSource <= 0) {
        logger.warn(
          `[跳过订单] 无法获取有效价格，无法按金额计算买入数量，symbol=${symbol}, price=${pricingSource}`
        );
        // 回退到预设数量
        const fallbackQty = toDecimal(quantity);
        if (!fallbackQty || fallbackQty.isZero() || fallbackQty.isNegative()) {
          logger.warn(
            `[跳过订单] 预设买入数量非法（${quantity}），跳过提交 ${symbol} 订单`
          );
          return;
        }
        submittedQtyDecimal = fallbackQty;
      } else {
        const notional = Number(
          targetNotional && Number.isFinite(Number(targetNotional))
            ? targetNotional
            : 5000
        );
        const priceNum = Number(pricingSource);
        let rawQty = Math.floor(notional / priceNum);
        
        // 获取最小买卖单位（优先使用从API获取的值，其次使用配置值，最后使用默认值100）
        let lotSize = signal?.lotSize ?? null;
        if (!Number.isFinite(lotSize) || lotSize <= 0) {
          // 如果信号中没有 lotSize，从配置中获取
          if (isShortSymbol) {
            lotSize = TRADING_CONFIG.shortLotSize;
          } else {
            lotSize = TRADING_CONFIG.longLotSize;
          }
        }
        // 确保 lotSize 是有效的正数
        if (!Number.isFinite(lotSize) || lotSize <= 0) {
          lotSize = 100; // 最后的默认值
        }
        
        // 按最小买卖单位取整，确保数量是最小买卖单位的整数倍
        rawQty = Math.floor(rawQty / lotSize) * lotSize;
        if (!Number.isFinite(rawQty) || rawQty < lotSize) {
          logger.warn(
            `[跳过订单] 目标金额(${notional}) 相对于价格(${priceNum}) 太小，按每手 ${lotSize} 股计算得到数量=${rawQty}，跳过提交 ${symbol} 订单`
          );
          return;
        }
        submittedQtyDecimal = toDecimal(rawQty);
        const actionType = isShortSymbol ? "买入做空标的（做空）" : "买入做多标的（做多）";
        logger.info(
          `[仓位计算] 按目标金额 ${notional} 计算得到${actionType}数量=${rawQty} 股（${lotSize} 股一手），单价≈${priceNum}`
        );
      }
    }

    const orderPayload = {
      symbol,
      orderType,
      side,
      timeInForce,
      submittedQuantity: submittedQtyDecimal,
    };

    const resolvedPrice =
      overridePrice ?? signal?.price ?? signal?.snapshotPrice ?? null;

    if (
      orderType === OrderType.LO ||
      orderType === OrderType.ELO ||
      orderType === OrderType.ALO ||
      orderType === OrderType.SLO
    ) {
      if (!resolvedPrice) {
        logger.warn(
          `[跳过订单] ${symbol} 的增强限价单缺少价格，无法提交。请确保信号中包含价格信息或配置 orderOptions.price`
        );
        return;
      }
      orderPayload.submittedPrice = toDecimal(resolvedPrice);
      logger.info(
        `[订单类型] 使用增强限价单(ELO)，标的=${symbol}，价格=${resolvedPrice}`
      );
    }

    if (remark) {
      orderPayload.remark = `${remark}`.slice(0, 60);
    }

    try {
      const resp = await ctx.submitOrder(orderPayload);
      const orderId =
        resp?.orderId ?? resp?.toString?.() ?? resp ?? "UNKNOWN_ORDER_ID";
      const actionDesc = isShortSymbol
        ? side === OrderSide.Buy
          ? "买入做空标的（做空）"
          : "卖出做空标的（平空仓）"
        : side === OrderSide.Buy
        ? "买入做多标的（做多）"
        : "卖出做多标的（清仓）";
      
      logger.info(
        `[订单提交成功] ${actionDesc} ${orderPayload.symbol} 数量=${orderPayload.submittedQuantity.toString()} 订单ID=${orderId}`
      );
      
      // 更新该标的的最后交易时间（订单提交成功后才更新）
      this._updateLastTradeTime(orderPayload.symbol);
      
      // 记录交易到文件
      recordTrade({
        orderId: String(orderId),
        symbol: orderPayload.symbol,
        action: actionDesc,
        side: side === OrderSide.Buy ? "BUY" : "SELL",
        quantity: orderPayload.submittedQuantity.toString(),
        price: orderPayload.submittedPrice?.toString() || "市价",
        orderType: orderType === OrderType.MO ? "市价单" : "限价单",
        status: "SUBMITTED",
        reason: signal.reason || "策略信号",
      });
    } catch (err) {
      const actionDesc = isShortSymbol
        ? side === OrderSide.Buy
          ? "买入做空标的（做空）"
          : "卖出做空标的（平空仓）"
        : side === OrderSide.Buy
        ? "买入做多标的（做多）"
        : "卖出做多标的（清仓）";
      
      const errorMessage = err?.message ?? String(err);
      const errorStr = String(errorMessage).toLowerCase();
      
      // 检查是否为做空不支持的错误（注意：做空是买入做空标的，所以检查买入订单）
      const isShortSellingNotSupported = 
        isShortSymbol && 
        side === OrderSide.Buy && 
        (errorStr.includes("does not support short selling") ||
         errorStr.includes("不支持做空") ||
         errorStr.includes("short selling") ||
         errorStr.includes("做空"));
      
      if (isShortSellingNotSupported) {
        logger.error(
          `[订单提交失败] ${actionDesc} ${orderPayload.symbol} 失败：该标的不支持做空交易`,
          errorMessage
        );
        logger.warn(
          `[做空错误提示] 标的 ${orderPayload.symbol} 不支持做空交易。可能的原因：\n` +
          `  1. 该标的在港股市场不支持做空\n` +
          `  2. 账户没有做空权限\n` +
          `  3. 需要更换其他支持做空的标的\n` +
          `  建议：检查配置中的 SHORT_SYMBOL 环境变量，或联系券商确认账户做空权限`
        );
      } else {
        logger.error(
          `[订单提交失败] ${actionDesc} ${orderPayload.symbol} 失败：`,
          errorMessage
        );
      }
      
      // 记录失败交易到文件
      recordTrade({
        orderId: "FAILED",
        symbol: orderPayload.symbol,
        action: actionDesc,
        side: side === OrderSide.Buy ? "BUY" : "SELL",
        quantity: orderPayload.submittedQuantity.toString(),
        price: orderPayload.submittedPrice?.toString() || "市价",
        orderType: orderType === OrderType.MO ? "市价单" : "限价单",
        status: "FAILED",
        error: errorMessage,
        reason: signal.reason || "策略信号",
      });
    }
  }
}


