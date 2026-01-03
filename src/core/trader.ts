/**
 * 订单执行模块
 *
 * 功能：
 * - 提交和监控交易订单
 * - 计算买入/卖出数量
 * - 管理未成交订单的价格优化
 * - 实施 Trade API 频率限制
 *
 * 核心方法：
 * - executeSignals()：根据信号提交订单
 * - monitorAndManageOrders()：监控未成交订单，价格下跌时降低委托价
 * - _submitTargetOrder()：提交 ELO 增强限价单
 *
 * 订单类型：
 * - ELO（增强限价单）：普通交易使用
 * - MO（市价单）：保护性清仓使用
 *
 * 频率限制：
 * - 30 秒内不超过 30 次 API 调用
 * - 两次调用间隔不少于 0.02 秒
 */

import {
  TradeContext,
  OrderSide,
  OrderType,
  OrderStatus,
  TimeInForceType,
  Decimal,
} from 'longport';
import type { Config } from 'longport';
import { createConfig } from '../config/config.js';
import { TRADING_CONFIG } from '../config/config.trading.js';
import { logger, colors } from '../utils/logger.js';
import {
  normalizeHKSymbol,
  decimalToNumber,
  formatSymbolDisplay,
  toBeijingTimeIso,
  isDefined,
  isBuyAction,
} from '../utils/helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import type { Signal, Quote, AccountSnapshot, Position } from '../types/index.js';
import type { OrderRecorder, PendingOrder } from './orderRecorder.js';

/**
 * 默认订单配置类型
 */
type OrderOptions = {
  symbol: string;
  readonly targetNotional: number;
  readonly quantity: number;
  readonly orderType: typeof OrderType[keyof typeof OrderType];
  readonly timeInForce: typeof TimeInForceType[keyof typeof TimeInForceType];
  readonly remark: string;
  readonly price?: number;
};

/**
 * 可转换为数字的类型
 */
type DecimalLikeValue = string | number | null;

/**
 * 订单载荷类型
 */
type OrderPayload = {
  readonly symbol: string;
  readonly orderType: typeof OrderType[keyof typeof OrderType];
  readonly side: typeof OrderSide[keyof typeof OrderSide];
  readonly timeInForce: typeof TimeInForceType[keyof typeof TimeInForceType];
  readonly submittedQuantity: Decimal;
  submittedPrice?: Decimal;
  remark?: string;
};

/**
 * 交易记录类型
 */
type TradeRecord = {
  orderId?: string;
  symbol: string;
  symbolName?: string | null;
  action?: string;
  side?: string;
  quantity?: string;
  price?: string;
  orderType?: string;
  status?: string;
  error?: string;
  reason?: string;
  signalTriggerTime?: Date | string | null;
  timestamp?: string;
};

/**
 * 错误类型标识类型
 */
type ErrorTypeIdentifier = {
  readonly isShortSellingNotSupported: boolean;
  readonly isInsufficientFunds: boolean;
  readonly isOrderNotFound: boolean;
  readonly isNetworkError: boolean;
  readonly isRateLimited: boolean;
};

const DEFAULT_ORDER_CONFIG: OrderOptions = {
  // 来自统一交易配置，可通过环境变量覆盖
  symbol: TRADING_CONFIG.longSymbol || '',
  // 默认目标买入金额（以 HKD 计），实际买入会取 <= 该金额且最接近的整数股数
  targetNotional: TRADING_CONFIG.targetNotional || 0,
  // 仅在无法根据价格计算数量时作为兜底数量（使用做多标的的最小买卖单位）
  quantity: TRADING_CONFIG.longLotSize || 1,
  // 使用增强限价单（ELO）进行委托
  orderType: OrderType.ELO,
  timeInForce: TimeInForceType.Day,
  remark: 'QuantDemo',
};

const toDecimal = (value: unknown): Decimal => {
  if (value instanceof Decimal) {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'string') {
    return new Decimal(value);
  }
  return Decimal.ZERO();
};

/**
 * 从错误对象中提取安全的错误消息字符串
 * @param err - 错误对象
 * @returns 错误消息字符串
 */
const extractErrorMessage = (err: unknown): string => {
  if (err === null || err === undefined) {
    return '未知错误';
  }
  if (typeof err === 'string') {
    return err;
  }
  if (typeof err === 'number' || typeof err === 'boolean') {
    return String(err);
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  try {
    return String(err);
  } catch {
    return '无法序列化的错误';
  }
};

/**
 * 错误类型识别辅助函数
 * @param errorMessage - 错误消息字符串
 * @returns 错误类型标识对象
 */
const identifyErrorType = (errorMessage: string): ErrorTypeIdentifier => {
  const lowerMsg = errorMessage.toLowerCase();

  return {
    isShortSellingNotSupported:
      lowerMsg.includes('does not support short selling') ||
      lowerMsg.includes('不支持做空') ||
      lowerMsg.includes('short selling') ||
      lowerMsg.includes('做空'),
    isInsufficientFunds:
      lowerMsg.includes('insufficient') ||
      lowerMsg.includes('资金不足') ||
      lowerMsg.includes('余额不足'),
    isOrderNotFound:
      lowerMsg.includes('not found') ||
      lowerMsg.includes('不存在') ||
      lowerMsg.includes('找不到'),
    isNetworkError:
      lowerMsg.includes('network') ||
      lowerMsg.includes('网络') ||
      lowerMsg.includes('timeout') ||
      lowerMsg.includes('超时'),
    isRateLimited:
      lowerMsg.includes('rate limit') ||
      lowerMsg.includes('频率') ||
      lowerMsg.includes('too many'),
  };
};

/**
 * 记录交易到文件
 * @param tradeRecord 交易记录对象
 */
function recordTrade(tradeRecord: TradeRecord): void {
  try {
    const logDir = path.join(process.cwd(), 'logs', 'trades');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const today = new Date().toISOString().split('T')[0];
    const logFile = path.join(logDir, `${today}.json`);

    let trades: TradeRecord[] = [];
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf-8');
      try {
        trades = JSON.parse(content) as TradeRecord[];
        // 确保解析结果是数组
        if (!Array.isArray(trades)) {
          logger.warn(`交易记录文件格式错误，重置为空数组: ${logFile}`);
          trades = [];
        }
      } catch (e) {
        logger.warn(
          `解析交易记录文件失败，重置为空数组: ${logFile}`,
          (e as Error)?.message ?? e,
        );
        trades = [];
      }
    }

    // 格式化标的显示
    const symbolDisplay = formatSymbolDisplay(
      tradeRecord.symbol,
      tradeRecord.symbolName ?? undefined,
    );

    // 处理信号触发时间
    let signalTriggerTime: string | null = null;
    if (tradeRecord.signalTriggerTime) {
      if (tradeRecord.signalTriggerTime instanceof Date) {
        signalTriggerTime = toBeijingTimeIso(tradeRecord.signalTriggerTime);
      } else if (typeof tradeRecord.signalTriggerTime === 'string') {
        // 如果是字符串，尝试解析为Date
        const parsedDate = new Date(tradeRecord.signalTriggerTime);
        if (!Number.isNaN(parsedDate.getTime())) {
          signalTriggerTime = toBeijingTimeIso(parsedDate);
        }
      }
    }

    // 构建记录对象
    const record: TradeRecord = {
      ...tradeRecord,
      symbol: symbolDisplay, // 使用格式化后的标的显示
      timestamp: toBeijingTimeIso(), // 记录时间使用北京时间
    };

    // 如果有信号触发时间，添加到记录中
    if (signalTriggerTime) {
      record.signalTriggerTime = signalTriggerTime;
    }

    // 移除symbolName字段（已经合并到symbol中）
    delete record.symbolName;

    trades.push(record);

    fs.writeFileSync(logFile, JSON.stringify(trades, null, 2), 'utf-8');
  } catch (err) {
    logger.error('写入交易记录失败', err);
  }
}

/**
 * Trade API 频率限制器
 * Longbridge API 限制：30秒内不超过30次调用，两次调用间隔不少于0.02秒
 */
class TradeAPIRateLimiter {
  private readonly maxCalls: number;
  private readonly windowMs: number;
  private callTimestamps: number[];
  private _throttlePromise: Promise<void> | null;

  constructor(maxCalls: number = 30, windowMs: number = 30000) {
    this.maxCalls = maxCalls;
    this.windowMs = windowMs;
    this.callTimestamps = [];
    this._throttlePromise = null; // 并发锁：防止多个并发请求导致超限
  }

  /**
   * 在调用 Trade API 前进行频率控制
   * 如果超过频率限制，会自动等待
   * 支持并发调用（通过内部锁机制确保不会超限）
   */
  async throttle(): Promise<void> {
    // ===== 修复问题1: 并发安全 =====
    // 如果有正在执行的 throttle，等待它完成
    while (this._throttlePromise) {
      await this._throttlePromise;
    }

    // 设置并发锁
    let releaseLock: () => void;
    this._throttlePromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    try {
      const now = Date.now();

      // 清理超出时间窗口的调用记录
      this.callTimestamps = this.callTimestamps.filter(
        (timestamp) => now - timestamp < this.windowMs,
      );

      // 如果已达到最大调用次数，等待最早的调用过期
      if (this.callTimestamps.length >= this.maxCalls) {
        const oldestCall = this.callTimestamps[0]!;
        const waitTime = this.windowMs - (now - oldestCall) + 100; // 额外等待100ms作为缓冲
        logger.warn(
          `[频率限制] Trade API 调用频率达到上限 (${this.maxCalls}次/${this.windowMs}ms)，等待 ${waitTime}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));

        // ===== 修复问题3: 等待后重新清理过期记录 =====
        const nowAfterWait = Date.now();
        this.callTimestamps = this.callTimestamps.filter(
          (timestamp) => nowAfterWait - timestamp < this.windowMs,
        );
      }

      // 记录本次调用时间
      this.callTimestamps.push(Date.now());
    } finally {
      // 释放并发锁
      this._throttlePromise = null;
      releaseLock!();
    }
  }
}

/**
 * 交易执行骨架，用于根据策略信号下单。
 * 真实策略中，你需要完善风险控制、仓位管理等逻辑。
 * TradeContext 文档见：
 * https://longportapp.github.io/openapi/nodejs/modules.html
 */
export class Trader {
  _ctxPromise!: Promise<TradeContext>; // 使用 ! 断言，将在 create() 方法中初始化
  private readonly _orderOptions: OrderOptions;
  _lastBuyTime: Map<string, number>;
  private _shouldMonitorBuyOrders: boolean;
  private _pendingOrdersCache: PendingOrder[] | null;
  private _pendingOrdersCacheSymbols: string | null;
  private _pendingOrdersCacheTime: number;
  private readonly _pendingOrdersCacheTTL: number;
  private readonly _tradeAPILimiter: TradeAPIRateLimiter;

  private constructor() {
    // _ctxPromise 将在 create() 静态方法中初始化，不在这里初始化
    this._orderOptions = { ...DEFAULT_ORDER_CONFIG };
    // 规范化港股代码，自动添加 .HK 后缀
    if (this._orderOptions.symbol) {
      this._orderOptions.symbol = normalizeHKSymbol(this._orderOptions.symbol);
    }
    // 记录每个方向标的的最后买入时间（用于限制交易频率）
    // 键："LONG" 表示做多标的，"SHORT" 表示做空标的
    // 只有买入同方向标的会触发频率检查，不同方向标的的买入不能互相阻塞
    // 卖出操作不会触发频率限制
    this._lastBuyTime = new Map();
    // 是否需要监控买入订单（仅在发起买入交易后设置为true）
    this._shouldMonitorBuyOrders = false;

    // ===== 修复1: 添加订单缓存机制 =====
    // 缓存未成交订单，避免频繁调用 todayOrders API
    this._pendingOrdersCache = null;
    this._pendingOrdersCacheSymbols = null; // ===== 修复问题2: 记录缓存对应的 symbols =====
    this._pendingOrdersCacheTime = 0;
    this._pendingOrdersCacheTTL = 15000; // 15秒缓存（订单状态变化相对较慢）

    // ===== 修复3: 添加 Trade API 频率限制器 =====
    // Longbridge API 限制：30秒内不超过30次调用
    this._tradeAPILimiter = new TradeAPIRateLimiter(30, 30000);
  }

  /**
   * 创建 Trader 实例（静态工厂方法）
   * 将异步初始化操作从构造函数中移出，符合 SonarQube 规范
   * @param config 配置对象，如果为 null 则使用默认配置
   * @returns Trader 实例
   */
  static async create(config: Config | null = null): Promise<Trader> {
    const finalConfig = config ?? createConfig();
    const trader = new Trader();
    // 在工厂方法中初始化 Promise，而不是在构造函数中
    trader._ctxPromise = TradeContext.new(finalConfig);
    return trader;
  }

  async getAccountSnapshot(): Promise<AccountSnapshot | null> {
    const ctx = await this._ctxPromise;
    // ===== 修复3: 应用频率限制 =====
    await this._tradeAPILimiter.throttle();
    const balances = await ctx.accountBalance();
    const primary = balances?.[0];
    if (!primary) {
      return null;
    }

    const totalCash = decimalToNumber(primary.totalCash);
    const netAssets = decimalToNumber(primary.netAssets);
    const positionValue = netAssets - totalCash;

    return {
      currency: primary.currency ?? 'HKD',
      totalCash,
      netAssets,
      positionValue,
    };
  }

  async getStockPositions(symbols: string[] | null = null): Promise<Position[]> {
    const ctx = await this._ctxPromise;
    // ===== 修复3: 应用频率限制 =====
    await this._tradeAPILimiter.throttle();
    // stockPositions 接受 Array<string> | undefined | null，直接传递即可
    const resp = await ctx.stockPositions(symbols ?? undefined);
    const channels = resp?.channels ?? [];
    if (!channels.length) {
      return [];
    }

    return channels.flatMap((channel) =>
      (channel.positions ?? []).map((pos) => ({
        accountChannel: channel.accountChannel ?? 'N/A',
        symbol: pos.symbol,
        symbolName: pos.symbolName,
        quantity: decimalToNumber(pos.quantity),
        availableQuantity: decimalToNumber(pos.availableQuantity),
        currency: pos.currency,
        costPrice: decimalToNumber(pos.costPrice),
        market: pos.market,
      })),
    );
  }

  /**
   * 获取今日未成交订单（带缓存机制）
   * @param symbols 标的代码数组，如果为null或空数组则获取所有标的的订单
   * @param forceRefresh 是否强制刷新缓存（默认false）
   * @returns 未成交订单列表
   */
  async getPendingOrders(
    symbols: string[] | null = null,
    forceRefresh: boolean = false,
  ): Promise<PendingOrder[]> {
    // ===== 修复问题2: 规范化 symbols 参数用于缓存匹配 =====
    // 将 symbols 数组规范化并排序，用于比较缓存是否对应同一组 symbols
    const symbolsKey =
      symbols && symbols.length > 0
        ? symbols
          .map((s) => normalizeHKSymbol(s))
          .sort((a, b) => a.localeCompare(b))
          .join(',')
        : 'ALL'; // null 或空数组统一标记为 "ALL"

    // ===== 修复1: 检查缓存 =====
    const now = Date.now();
    const isCacheValid =
      this._pendingOrdersCache !== null &&
      this._pendingOrdersCacheSymbols === symbolsKey && // ===== 修复问题2: 检查 symbols 是否匹配 =====
      now - this._pendingOrdersCacheTime < this._pendingOrdersCacheTTL;

    // 如果缓存有效且不强制刷新，直接返回缓存
    if (isCacheValid && !forceRefresh) {
      logger.debug(
        `[订单缓存] 使用缓存的未成交订单数据 (symbols=${symbolsKey}, 缓存时间: ${
          now - this._pendingOrdersCacheTime
        }ms)`,
      );
      return this._pendingOrdersCache!;
    }

    // ===== 修复1: 缓存失效或强制刷新，调用API =====
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

      let allOrders: Array<{
        orderId: string;
        symbol: string;
        side: typeof OrderSide[keyof typeof OrderSide];
        price: unknown;
        quantity: unknown;
        executedQuantity: unknown;
        status: typeof OrderStatus[keyof typeof OrderStatus];
        orderType: unknown;
      }> = [];

      if (!symbols || symbols.length === 0) {
        // 如果没有指定标的，获取所有订单
        // ===== 修复3: 应用频率限制 =====
        await this._tradeAPILimiter.throttle();
        allOrders = (await ctx.todayOrders()) as typeof allOrders;
      } else {
        // 如果指定了标的，分别查询每个标的（因为 symbol 参数只接受单个字符串）
        const normalizedSymbols = symbols.map((s) => normalizeHKSymbol(s));
        const orderPromises = normalizedSymbols.map(async (symbol) => {
          try {
            // ===== 修复3: 应用频率限制 =====
            await this._tradeAPILimiter.throttle();
            return await ctx.todayOrders({ symbol });
          } catch (err) {
            logger.warn(
              `[今日订单API] 获取标的 ${symbol} 的今日订单失败`,
              (err as Error)?.message ?? String(err),
            );
            return []; // 单个标的查询失败时返回空数组，不影响其他标的
          }
        });
        const orderArrays = await Promise.all(orderPromises);
        allOrders = orderArrays.flat() as typeof allOrders;
      }

      // 如果指定了标的，还需要在客户端再次过滤（因为可能获取了所有订单）
      const normalizedTargetSymbols =
        symbols && symbols.length > 0
          ? new Set(symbols.map((s) => normalizeHKSymbol(s)))
          : null;

      const result: PendingOrder[] = allOrders
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
          submittedPrice: decimalToNumber(order.price as DecimalLikeValue),
          quantity: decimalToNumber(order.quantity as DecimalLikeValue),
          executedQuantity: decimalToNumber(order.executedQuantity as DecimalLikeValue),
          status: order.status,
          orderType: order.orderType,
          // ===== 修复2: 保存原始订单对象供 replaceOrderPrice 使用 =====
          _rawOrder: order,
        }));

      // ===== 修复1: 更新缓存 =====
      this._pendingOrdersCache = result;
      this._pendingOrdersCacheSymbols = symbolsKey; // ===== 修复问题2: 记录缓存对应的 symbols =====
      this._pendingOrdersCacheTime = Date.now();

      logger.debug(
        `[订单缓存] 已刷新未成交订单缓存 (symbols=${symbolsKey})，共 ${result.length} 个订单`,
      );

      return result;
    } catch (err) {
      logger.error(
        '获取未成交订单失败',
        (err as Error)?.message ?? String(err),
      );
      return [];
    }
  }

  /**
   * 清除订单缓存（在订单状态可能变化时调用）
   */
  clearPendingOrdersCache(): void {
    this._pendingOrdersCache = null;
    this._pendingOrdersCacheSymbols = null; // ===== 修复问题2: 同时清除 symbols 缓存 =====
    this._pendingOrdersCacheTime = 0;
    logger.debug('[订单缓存] 已清除缓存');
  }

  /**
   * 撤销订单
   * @param orderId 订单ID
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    const ctx = await this._ctxPromise;
    try {
      // ===== 修复3: 应用频率限制 =====
      await this._tradeAPILimiter.throttle();
      await ctx.cancelOrder(orderId);

      // ===== 修复1: 撤销成功后清除缓存 =====
      this.clearPendingOrdersCache();

      logger.info(`[订单撤销成功] 订单ID=${orderId}`);
      return true;
    } catch (err) {
      logger.error(
        `[订单撤销失败] 订单ID=${orderId}`,
        (err as Error)?.message ?? String(err),
      );
      return false;
    }
  }

  /**
   * 修改订单价格（优化版，避免重复查询）
   * @param orderId 订单ID
   * @param newPrice 新价格
   * @param quantity 数量（可选，如果不提供则使用原订单数量）
   * @param cachedOrder 缓存的订单对象（可选，避免重复查询）
   * @returns 修改成功时不返回，失败时抛出错误
   * @throws 当修改失败时抛出错误
   */
  async replaceOrderPrice(
    orderId: string,
    newPrice: number,
    quantity: number | null = null,
    cachedOrder: PendingOrder | null = null,
  ): Promise<void> {
    const ctx = await this._ctxPromise;

    // ===== 修复2: 优先使用缓存的订单对象，避免重复查询 =====
    let originalOrder: {
      orderId: string;
      status: typeof OrderStatus[keyof typeof OrderStatus];
      executedQuantity: unknown;
      quantity: unknown;
    } | null = (cachedOrder?._rawOrder as typeof originalOrder) || cachedOrder as unknown as typeof originalOrder;

    // 如果提供了缓存的订单对象，使用缓存；否则查询API
    if (originalOrder) {
      logger.debug(`[订单修改] 使用缓存的订单对象，订单ID=${orderId}`);
    } else {
      logger.debug(`[订单修改] 未提供缓存订单对象，查询API获取订单 ${orderId}`);
      // ===== 修复3: 应用频率限制 =====
      await this._tradeAPILimiter.throttle();
      const allOrders = await ctx.todayOrders();
      const foundOrder = allOrders.find((o) => o.orderId === orderId);
      originalOrder = foundOrder ?? null;
    }

    if (!originalOrder) {
      const error = new Error(`未找到订单ID=${orderId}`);
      logger.error(`[订单修改失败] ${error.message}`);
      throw error;
    }

    // 检查订单状态是否允许修改
    if (
      originalOrder.status === OrderStatus.Filled ||
      originalOrder.status === OrderStatus.Canceled ||
      originalOrder.status === OrderStatus.Rejected
    ) {
      const error = new Error(
        `订单ID=${orderId} 状态为 ${originalOrder.status}，不允许修改`,
      );
      logger.error(`[订单修改失败] ${error.message}`);
      throw error;
    }

    // 计算剩余数量（原订单数量 - 已成交数量）
    const executedQty = decimalToNumber((originalOrder as { executedQuantity?: DecimalLikeValue }).executedQuantity ?? 0);
    const originalQty = decimalToNumber((originalOrder as { quantity?: DecimalLikeValue }).quantity ?? 0);
    const remainingQty = originalQty - executedQty;

    // 构建修改订单的payload
    // API要求必须提供submittedQuantity字段，使用剩余数量或提供的数量
    let targetQuantity = remainingQty;

    // 如果提供了数量参数，使用提供的数量（但不能超过剩余数量）
    if (quantity !== null && Number.isFinite(quantity) && quantity > 0) {
      targetQuantity = Math.min(quantity, remainingQty);
    }

    // 验证数量有效性
    if (!Number.isFinite(targetQuantity) || targetQuantity <= 0) {
      const error = new Error(
        `订单ID=${orderId} 剩余数量无效（剩余=${remainingQty}，原数量=${originalQty}，已成交=${executedQty}）`,
      );
      logger.error(`[订单修改失败] ${error.message}`);
      throw error;
    }

    const replacePayload = {
      orderId: orderId,
      price: toDecimal(newPrice),
      quantity: toDecimal(targetQuantity), // API要求必须提供此字段
    };

    // 只使用官方API进行修改，失败时直接抛出错误
    try {
      // ===== 修复3: 应用频率限制 =====
      await this._tradeAPILimiter.throttle();
      await ctx.replaceOrder(replacePayload);

      // ===== 修复1: 修改成功后清除缓存 =====
      this.clearPendingOrdersCache();

      logger.info(
        `[订单修改成功] 订单ID=${orderId} 新价格=${newPrice.toFixed(3)}`,
      );
    } catch (err) {
      const errorMessage = (err as Error)?.message ?? String(err);
      const error = new Error(`订单修改失败: ${errorMessage}`);
      logger.error(
        `[订单修改失败] 订单ID=${orderId} 新价格=${newPrice.toFixed(3)}`,
        errorMessage,
      );
      throw error;
    }
  }

  /**
   * 检查是否有买入的未成交订单
   * @param symbols 标的代码数组
   * @param orderRecorder OrderRecorder 实例（可选，用于启动时从缓存获取）
   * @returns true表示有买入的未成交订单
   */
  async hasPendingBuyOrders(
    symbols: string[],
    orderRecorder: OrderRecorder | null = null,
  ): Promise<boolean> {
    try {
      // 如果提供了 orderRecorder，尝试从缓存获取（启动时使用，避免重复调用 todayOrders）
      if (orderRecorder) {
        // 检查缓存中是否有对应标的的数据
        const hasCache = symbols.some((symbol) => {
          const normalizedSymbol = normalizeHKSymbol(symbol);
          const cached = (orderRecorder as unknown as { _ordersCache: Map<string, { allOrders?: unknown[] }> })._ordersCache.get(normalizedSymbol);
          return cached?.allOrders;
        });

        // 如果缓存存在，从缓存中提取未成交订单
        // 注意：getPendingOrdersFromCache 已经过滤了未成交状态（New, PartialFilled 等），
        // 返回的都是未成交订单，所以这里只需要检查 side 是否为 Buy
        if (hasCache) {
          const pendingOrders =
            orderRecorder.getPendingOrdersFromCache(symbols);
          return pendingOrders.some((order) => order.side === OrderSide.Buy);
        }
        // 如果缓存不存在，说明还没有调用过 historyOrders，回退到 API 调用
      }
      // 从 API 获取（运行时使用）
      // 注意：getPendingOrders 已经过滤了未成交状态（New, PartialFilled 等），
      // 返回的都是未成交订单，所以这里只需要检查 side 是否为 Buy
      const pendingOrders = await this.getPendingOrders(symbols);
      return pendingOrders.some((order) => order.side === OrderSide.Buy);
    } catch (err) {
      logger.warn(
        '检查买入订单失败',
        (err as Error)?.message ?? String(err),
      );
      return false;
    }
  }

  /**
   * 启用买入订单监控
   */
  enableBuyOrderMonitoring(): void {
    this._shouldMonitorBuyOrders = true;
  }

  /**
   * 实时监控价格并管理未成交的买入订单
   * 规则：
   * - 仅在发起买入交易后才开始监控
   * - 只监控买入订单，卖出订单不监控
   * - 买入订单：如果当前价格低于委托价格，修改委托价格为当前价格
   * - 当所有买入订单成交后停止监控
   * @param longQuote 做多标的的行情数据
   * @param shortQuote 做空标的的行情数据
   */
  async monitorAndManageOrders(
    longQuote: Quote | null,
    shortQuote: Quote | null,
  ): Promise<void> {
    // 如果不需要监控，直接返回
    if (!this._shouldMonitorBuyOrders) {
      return;
    }

    const longSymbol = normalizeHKSymbol(TRADING_CONFIG.longSymbol);
    const shortSymbol = normalizeHKSymbol(TRADING_CONFIG.shortSymbol);

    // 获取所有未成交订单（实时获取，不使用缓存）
    const pendingOrders = await this.getPendingOrders([
      longSymbol,
      shortSymbol,
    ]);

    // 过滤出买入订单
    const pendingBuyOrders = pendingOrders.filter(
      (order) => order.side === OrderSide.Buy,
    );

    // 如果没有买入订单，停止监控
    if (pendingBuyOrders.length === 0) {
      if (this._shouldMonitorBuyOrders) {
        this._shouldMonitorBuyOrders = false;
        logger.info('[订单监控] 所有买入订单已成交，停止监控');
      }
      return;
    }

    logger.debug(
      `[订单监控] 发现 ${pendingBuyOrders.length} 个未成交买入订单，开始检查价格...`,
    );

    for (const order of pendingBuyOrders) {
      // 检查订单状态，如果已撤销、已成交或已完成，跳过监控
      if (
        order.status === OrderStatus.Filled ||
        order.status === OrderStatus.Rejected
      ) {
        logger.debug(
          `[订单监控] 买入订单 ${order.orderId} 状态为 ${order.status}，跳过监控`,
        );
        continue;
      }

      // 如果订单正在被修改（Replaced状态），跳过本次监控，等待下次
      if (
        order.status === OrderStatus.Replaced ||
        order.status === OrderStatus.PendingReplace ||
        order.status === OrderStatus.WaitToReplace
      ) {
        logger.debug(
          `[订单监控] 买入订单 ${order.orderId} 正在修改中（状态：${order.status}），跳过本次监控`,
        );
        continue;
      }

      const normalizedOrderSymbol = normalizeHKSymbol(order.symbol);
      let currentPrice: number | null = null;

      // 从实时行情获取标的的当前价格
      if (normalizedOrderSymbol === longSymbol && longQuote) {
        currentPrice = longQuote.price;
      } else if (normalizedOrderSymbol === shortSymbol && shortQuote) {
        currentPrice = shortQuote.price;
      }

      if (!currentPrice || !Number.isFinite(currentPrice)) {
        logger.debug(
          `[订单监控] 无法获取标的 ${order.symbol} 的当前价格，跳过处理订单 ${order.orderId}`,
        );
        continue;
      }

      const orderPrice = order.submittedPrice;

      // 买入订单：如果当前价格低于委托价格，修改委托价格为当前价格
      if (currentPrice < orderPrice) {
        const priceDiffAbs = Math.abs(currentPrice - orderPrice);
        // 价格差异达到0.001或以上时进行修改
        if (priceDiffAbs >= 0.001) {
          logger.info(
            `[订单监控] 买入订单 ${
              order.orderId
            } 当前价格(${currentPrice.toFixed(
              3,
            )}) 低于委托价格(${orderPrice.toFixed(
              3,
            )}) 差异=${priceDiffAbs.toFixed(3)}，修改委托价格为当前价格`,
          );
          try {
            // ===== 修复2: 传递订单对象，避免重复查询 =====
            await this.replaceOrderPrice(
              order.orderId,
              currentPrice,
              null,
              order,
            );
            logger.info(
              `[订单监控] 买入订单 ${
                order.orderId
              } 价格修改成功：${orderPrice.toFixed(
                3,
              )} -> ${currentPrice.toFixed(3)} (降低${priceDiffAbs.toFixed(3)})`,
            );
          } catch (err) {
            logger.error(
              `[订单监控] 买入订单 ${order.orderId} 价格修改失败: ${
                (err as Error)?.message ?? String(err)
              }`,
            );
          }
        } else {
          logger.debug(
            `[订单监控] 买入订单 ${
              order.orderId
            } 价格差异(${priceDiffAbs.toFixed(4)})小于0.001，暂不修改`,
          );
        }
      }
      // 如果当前价格高于委托价格，不做改变
    }
  }

  /**
   * 检查是否可以买入（仅对买入操作进行频率检查）
   * 只有买入同方向标的会触发频率检查，不同方向标的的买入不能互相阻塞
   * 卖出操作不会触发频率限制
   * @param signalAction 信号类型（'BUYCALL', 'BUYPUT', 'SELLCALL', 'SELLPUT'）
   * @returns true表示可以交易，false表示需要等待
   */
  _canTradeNow(signalAction: string): boolean {
    // 卖出操作不触发频率限制
    if (
      signalAction === 'SELLCALL' ||
      signalAction === 'SELLPUT'
    ) {
      return true;
    }

    // 确定方向：BUYCALL 是 LONG，BUYPUT 是 SHORT
    const direction = signalAction === 'BUYCALL' ? 'LONG' : 'SHORT';

    const lastTime = this._lastBuyTime.get(direction);

    if (!lastTime) {
      return true; // 该方向从未买入过，可以交易
    }

    const now = Date.now();
    const timeDiff = now - lastTime;
    const intervalMs = (TRADING_CONFIG.buyIntervalSeconds ?? 60) * 1000; // 使用配置的间隔时间

    return timeDiff >= intervalMs;
  }

  /**
   * 更新方向标的的最后买入时间（仅对买入操作更新）
   * @param signalAction 信号类型（'BUYCALL', 'BUYPUT', 'SELLCALL', 'SELLPUT'）
   */
  private _updateLastBuyTime(signalAction: string): void {
    // 只有买入操作才更新最后买入时间
    if (
      signalAction === 'BUYCALL' ||
      signalAction === 'BUYPUT'
    ) {
      const direction = signalAction === 'BUYCALL' ? 'LONG' : 'SHORT';
      this._lastBuyTime.set(direction, Date.now());
    }
  }

  /**
   * 根据信号类型和订单方向获取操作描述
   * @private
   */
  private _getActionDescription(
    signalAction: string,
    isShortSymbol: boolean,
    side: typeof OrderSide[keyof typeof OrderSide],
  ): string {
    if (signalAction === 'BUYCALL') {
      return '买入做多标的（做多）';
    }
    if (signalAction === 'SELLCALL') {
      return '卖出做多标的（清仓）';
    }
    if (signalAction === 'BUYPUT') {
      return '买入做空标的（做空）';
    }
    if (signalAction === 'SELLPUT') {
      return '卖出做空标的（平空仓）';
    }

    // 兼容旧代码（如果没有信号类型，根据 side 判断）
    if (isShortSymbol) {
      return side === OrderSide.Buy
        ? '买入做空标的（做空）'
        : '卖出做空标的（平空仓）';
    }
    return side === OrderSide.Buy
      ? '买入做多标的（做多）'
      : '卖出做多标的（清仓）';
  }

  /**
   * 根据策略信号提交订单。支持做多和做空标的：
   * - BUYCALL: 买入做多标的（做多）
   * - SELLCALL: 卖出做多标的（清仓）
   * - BUYPUT: 买入做空标的（做空）
   * - SELLPUT: 卖出做空标的（平空仓）
   *
   * @param signals 信号数组
   */
  async executeSignals(signals: Signal[]): Promise<void> {
    const ctx = await this._ctxPromise;
    const longSymbol = normalizeHKSymbol(TRADING_CONFIG.longSymbol);
    const shortSymbol = normalizeHKSymbol(TRADING_CONFIG.shortSymbol);

    for (const s of signals) {
      // 验证信号对象
      if (!s || typeof s !== 'object') {
        logger.warn(`[跳过信号] 无效的信号对象: ${JSON.stringify(s)}`);
        continue;
      }

      if (!s.symbol || typeof s.symbol !== 'string') {
        logger.warn(`[跳过信号] 信号缺少有效的标的代码: ${JSON.stringify(s)}`);
        continue;
      }

      if (s.action === 'HOLD') {
        logger.info(`[HOLD] ${s.symbol} - ${s.reason || '持有'}`);
        continue;
      }

      // 验证信号类型
      const validActions = [
        'BUYCALL',
        'SELLCALL',
        'BUYPUT',
        'SELLPUT',
      ];
      if (!validActions.includes(s.action)) {
        logger.warn(
          `[跳过信号] 未知的信号类型: ${s.action}, 标的: ${s.symbol}`,
        );
        continue;
      }

      const normalizedSignalSymbol = normalizeHKSymbol(s.symbol);
      const isShortSymbol = normalizedSignalSymbol === shortSymbol;
      const targetSymbol = isShortSymbol ? shortSymbol : longSymbol;

      // 注意：交易频率限制检查已在 index.js 的信号处理循环中进行（买入操作先检查交易频率，再进行风险检查）
      // 这里不再重复检查，因为信号已经通过了所有检查才会到达这里

      // 根据信号类型显示操作描述
      let actualAction = '';
      if (s.action === 'BUYCALL') {
        actualAction = '买入做多标的（做多）';
      } else if (s.action === 'SELLCALL') {
        actualAction = '卖出做多标的（平仓）';
      } else if (s.action === 'BUYPUT') {
        actualAction = '买入做空标的（做空）';
      } else if (s.action === 'SELLPUT') {
        actualAction = '卖出做空标的（平仓）';
      } else {
        actualAction = `未知操作(${s.action})`;
      }

      // 使用绿色显示交易计划
      logger.info(
        `${colors.green}[交易计划] ${actualAction} ${targetSymbol} - ${
          s.reason || '策略信号'
        }${colors.reset}`,
      );

      await this._submitTargetOrder(ctx, s, targetSymbol, isShortSymbol);

      // 如果发起了买入交易，启用监控
      if (isBuyAction(s.action)) {
        this.enableBuyOrderMonitoring();
        logger.info('[订单监控] 已发起买入交易，开始监控买入订单');
      }
    }
  }

  private async _submitTargetOrder(
    ctx: TradeContext,
    signal: Signal,
    targetSymbol: string,
    isShortSymbol: boolean = false,
  ): Promise<void> {
    // 验证信号对象
    if (!signal || typeof signal !== 'object') {
      logger.error(`[订单提交] 无效的信号对象: ${JSON.stringify(signal)}`);
      return;
    }

    if (!signal.symbol || typeof signal.symbol !== 'string') {
      logger.error(
        `[订单提交] 信号缺少有效的标的代码: ${JSON.stringify(signal)}`,
      );
      return;
    }

    // 根据信号类型转换为订单方向
    // BUYCALL: 买入做多标的 → OrderSide.Buy
    // SELLCALL: 卖出做多标的 → OrderSide.Sell
    // BUYPUT: 买入做空标的 → OrderSide.Buy
    // SELLPUT: 卖出做空标的 → OrderSide.Sell
    let side: typeof OrderSide[keyof typeof OrderSide];
    if (signal.action === 'BUYCALL') {
      side = OrderSide.Buy; // 买入做多标的
    } else if (signal.action === 'SELLCALL') {
      side = OrderSide.Sell; // 卖出做多标的
    } else if (signal.action === 'BUYPUT') {
      side = OrderSide.Buy; // 买入做空标的（做空）
    } else if (signal.action === 'SELLPUT') {
      side = OrderSide.Sell; // 卖出做空标的（平空仓）
    } else {
      logger.error(
        `[订单提交] 未知的信号类型: ${signal.action}, 标的: ${signal.symbol}`,
      );
      return;
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

    // 检查信号是否要求使用市价单（保护性清仓）
    const useMarketOrder = signal.useMarketOrder === true;

    let submittedQtyDecimal: Decimal;

    // 判断是否需要清仓（平仓）
    const needClosePosition =
      signal.action === 'SELLCALL' || // 卖出做多标的（清仓）
      signal.action === 'SELLPUT'; // 卖出做空标的（平空仓）

    if (needClosePosition) {
      // 平仓：如果信号中指定了数量，使用指定数量；否则按当前持仓可用数量全部清仓
      let targetQuantity: number | null = null;
      if (isDefined(signal.quantity)) {
        const signalQty = Number(signal.quantity);
        if (Number.isFinite(signalQty) && signalQty > 0) {
          targetQuantity = signalQty;
        }
      }

      // ===== 修复3: 应用频率限制 =====
      await this._tradeAPILimiter.throttle();
      const resp = await ctx.stockPositions([symbol]);
      const channels = resp?.channels ?? [];
      let totalAvailable = 0;
      for (const ch of channels) {
        const positions = Array.isArray(ch.positions) ? ch.positions : [];
        for (const pos of positions) {
          if (pos?.symbol === symbol && pos.availableQuantity) {
            const qty = decimalToNumber(pos.availableQuantity);
            if (Number.isFinite(qty) && qty > 0) {
              totalAvailable += qty;
            }
          }
        }
      }
      if (!Number.isFinite(totalAvailable) || totalAvailable <= 0) {
        logger.warn(
          `[跳过订单] 当前无可用持仓，无需平仓。symbol=${symbol}, available=${totalAvailable}`,
        );
        return;
      }

      // 如果指定了数量，使用指定数量（但不能超过可用数量）
      if (targetQuantity == null) {
        // 未指定数量，全部清仓
        submittedQtyDecimal = toDecimal(totalAvailable);
      } else {
        submittedQtyDecimal = toDecimal(
          Math.min(targetQuantity, totalAvailable),
        );
        logger.info(
          `[部分卖出] 信号指定卖出数量=${targetQuantity}，可用数量=${totalAvailable}，实际卖出=${submittedQtyDecimal.toString()}`,
        );
      }
    } else {
      // BUY 信号：按目标金额（例如 5000 HKD）计算买入数量，
      // 尽量使 成交金额 <= targetNotional 且尽量接近 targetNotional
      const pricingSource = overridePrice ?? signal?.price ?? null;
      if (!Number.isFinite(Number(pricingSource)) || Number(pricingSource) <= 0) {
        logger.warn(
          `[跳过订单] 无法获取有效价格，无法按金额计算买入数量，symbol=${symbol}, price=${pricingSource}`,
        );
        // 回退到预设数量
        const fallbackQty = toDecimal(quantity);
        if (!fallbackQty || fallbackQty.isZero() || fallbackQty.isNegative()) {
          logger.warn(
            `[跳过订单] 预设买入数量非法（${quantity}），跳过提交 ${symbol} 订单`,
          );
          return;
        }
        submittedQtyDecimal = fallbackQty;
      } else {
        const notional = Number(
          targetNotional &&
            Number.isFinite(Number(targetNotional)) &&
            targetNotional > 0
            ? targetNotional
            : 5000,
        );
        const priceNum = Number(pricingSource);

        // 验证价格有效性
        if (!Number.isFinite(priceNum) || priceNum <= 0) {
          logger.warn(
            `[跳过订单] 价格无效，无法计算买入数量，symbol=${symbol}, price=${priceNum}`,
          );
          return;
        }

        let rawQty = Math.floor(notional / priceNum);

        // 获取最小买卖单位（优先使用从API获取的值，其次使用配置值，最后使用默认值100）
        let lotSize = signal?.lotSize ?? null;
        if (!Number.isFinite(lotSize) || (lotSize !== null && lotSize <= 0)) {
          // 如果信号中没有 lotSize，从配置中获取
          if (isShortSymbol) {
            lotSize = TRADING_CONFIG.shortLotSize;
          } else {
            lotSize = TRADING_CONFIG.longLotSize;
          }
        }
        // 确保 lotSize 是有效的正数
        if (!Number.isFinite(lotSize) || (lotSize !== null && lotSize <= 0)) {
          lotSize = 100; // 最后的默认值
        }

        // 按最小买卖单位取整，确保数量是最小买卖单位的整数倍
        rawQty = Math.floor(rawQty / lotSize!) * lotSize!;
        if (!Number.isFinite(rawQty) || rawQty < lotSize!) {
          logger.warn(
            `[跳过订单] 目标金额(${notional}) 相对于价格(${priceNum}) 太小，按每手 ${lotSize} 股计算得到数量=${rawQty}，跳过提交 ${symbol} 订单`,
          );
          return;
        }
        submittedQtyDecimal = toDecimal(rawQty);
        const actionType = isShortSymbol
          ? '买入做空标的（做空）'
          : '买入做多标的（做多）';
        logger.info(
          `[仓位计算] 按目标金额 ${notional} 计算得到${actionType}数量=${rawQty} 股（${lotSize} 股一手），单价≈${priceNum}`,
        );
      }
    }

    // 确定实际使用的订单类型：如果信号要求市价单，使用市价单；否则使用配置的订单类型
    const actualOrderType = useMarketOrder ? OrderType.MO : orderType;

    const orderPayload: OrderPayload = {
      symbol,
      orderType: actualOrderType,
      side,
      timeInForce,
      submittedQuantity: submittedQtyDecimal,
    };

    const resolvedPrice = overridePrice ?? signal?.price ?? null;

    // 市价单不需要价格
    if (actualOrderType === OrderType.MO) {
      logger.info(`[订单类型] 使用市价单(MO)进行保护性清仓，标的=${symbol}`);
    } else if (
      actualOrderType === OrderType.LO ||
      actualOrderType === OrderType.ELO ||
      actualOrderType === OrderType.ALO ||
      actualOrderType === OrderType.SLO
    ) {
      if (!resolvedPrice) {
        logger.warn(
          `[跳过订单] ${symbol} 的增强限价单缺少价格，无法提交。请确保信号中包含价格信息或配置 orderOptions.price`,
        );
        return;
      }
      orderPayload.submittedPrice = toDecimal(resolvedPrice);
      logger.info(
        `[订单类型] 使用增强限价单(ELO)，标的=${symbol}，价格=${resolvedPrice}`,
      );
    }

    if (remark) {
      orderPayload.remark = `${remark}`.slice(0, 60);
    }

    try {
      // ===== 修复3: 应用频率限制 =====
      await this._tradeAPILimiter.throttle();
      const resp = await ctx.submitOrder(orderPayload);

      // ===== 修复1: 提交成功后清除缓存 =====
      this.clearPendingOrdersCache();

      const orderId =
        (resp as { orderId?: string })?.orderId ?? resp?.toString?.() ?? resp ?? 'UNKNOWN_ORDER_ID';

      // 根据信号类型确定操作描述
      const actionDesc = this._getActionDescription(
        signal.action,
        isShortSymbol,
        side,
      );

      logger.info(
        `[订单提交成功] ${actionDesc} ${
          orderPayload.symbol
        } 数量=${orderPayload.submittedQuantity.toString()} 订单ID=${orderId}`,
      );

      // 更新该方向标的的最后买入时间（仅对买入操作更新，订单提交成功后才更新）
      this._updateLastBuyTime(signal.action);

      // 记录交易到文件
      recordTrade({
        orderId: String(orderId),
        symbol: orderPayload.symbol,
        symbolName: signal.symbolName || null, // 标的中文名称
        action: actionDesc,
        side: signal.action || (side === OrderSide.Buy ? 'BUY' : 'SELL'),
        quantity: orderPayload.submittedQuantity.toString(),
        price: orderPayload.submittedPrice?.toString() || '市价',
        orderType: actualOrderType === OrderType.MO ? '市价单' : '限价单',
        status: 'SUBMITTED',
        reason: signal.reason || '策略信号',
        signalTriggerTime: signal.signalTriggerTime || null, // 信号触发时间
      });
    } catch (err) {
      // 根据信号类型确定操作描述
      const actionDesc = this._getActionDescription(
        signal.action,
        isShortSymbol,
        side,
      );

      // 使用辅助函数提取错误消息
      const errorMessage = extractErrorMessage(err);
      const errorType = identifyErrorType(errorMessage);

      // 根据错误类型进行针对性处理
      if (errorType.isShortSellingNotSupported) {
        // 做空不支持的错误（做空是买入做空标的，所以检查买入订单）
        logger.error(
          `[订单提交失败] ${actionDesc} ${orderPayload.symbol} 失败：该标的不支持做空交易`,
          errorMessage,
        );
        logger.warn(
          `[做空错误提示] 标的 ${orderPayload.symbol} 不支持做空交易。可能的原因：\n` +
            '  1. 该标的在港股市场不支持做空\n' +
            '  2. 账户没有做空权限\n' +
            '  3. 需要更换其他支持做空的标的\n' +
            '  建议：检查配置中的 SHORT_SYMBOL 环境变量，或联系券商确认账户做空权限',
        );
      } else if (errorType.isInsufficientFunds) {
        // 资金不足错误
        logger.error(
          `[订单提交失败] ${actionDesc} ${orderPayload.symbol} 失败：账户资金不足`,
          errorMessage,
        );
      } else if (errorType.isNetworkError) {
        // 网络错误
        logger.error(
          `[订单提交失败] ${actionDesc} ${orderPayload.symbol} 失败：网络异常，请检查连接`,
          errorMessage,
        );
      } else if (errorType.isRateLimited) {
        // API 频率限制
        logger.error(
          `[订单提交失败] ${actionDesc} ${orderPayload.symbol} 失败：API 调用频率超限`,
          errorMessage,
        );
      } else {
        // 其他错误
        logger.error(
          `[订单提交失败] ${actionDesc} ${orderPayload.symbol} 失败：`,
          errorMessage,
        );
      }

      // 记录失败交易到文件
      recordTrade({
        orderId: 'FAILED',
        symbol: orderPayload.symbol,
        symbolName: signal.symbolName || null, // 标的中文名称
        action: actionDesc,
        side: signal.action || (side === OrderSide.Buy ? 'BUY' : 'SELL'),
        quantity: orderPayload.submittedQuantity.toString(),
        price: orderPayload.submittedPrice?.toString() || '市价',
        orderType: actualOrderType === OrderType.MO ? '市价单' : '限价单',
        status: 'FAILED',
        error: errorMessage,
        reason: signal.reason || '策略信号',
        signalTriggerTime: signal.signalTriggerTime || null, // 信号触发时间
      });
    }
  }
}
