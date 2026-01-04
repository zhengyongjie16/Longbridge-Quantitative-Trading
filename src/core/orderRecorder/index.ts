/**
 * 订单记录模块
 *
 * 功能：
 * - 跟踪已成交的买入/卖出订单
 * - 提供智能清仓决策的历史订单数据
 * - 为浮亏监控提供原始订单数据（R1/N1）
 *
 * 过滤算法（从旧到新累积过滤）：
 * 1. M0：最新卖出时间之后成交的买入订单
 * 2. 过滤历史高价买入且未被完全卖出的订单
 * 3. 最终记录 = M0 + 过滤后的买入订单
 *
 * 智能清仓逻辑：
 * - 当 currentPrice > costPrice：清空所有持仓
 * - 当 currentPrice ≤ costPrice：仅卖出 buyPrice < currentPrice 的订单
 *
 * 缓存机制：
 * - 订单数据永久缓存（程序运行期间）
 * - 只在 forceRefresh=true 时重新获取
 * - 避免频繁调用 historyOrders API
 */

import { OrderSide, OrderStatus } from 'longport';
import { logger } from '../../utils/logger.js';
import { normalizeHKSymbol, decimalToNumber } from '../../utils/helpers.js';
import type { Trader } from '../trader/index.js';
import type { DecimalLikeValue } from '../../types/index.js';
import type {
  OrderRecord,
  OrderCache,
  FetchOrdersResult,
} from './type.js';
import type { PendingOrder } from '../type.js';


export class OrderRecorder {
  private readonly _trader: Trader;
  _longBuyOrders: OrderRecord[];
  _shortBuyOrders: OrderRecord[];
  private readonly _ordersCache: Map<string, OrderCache>;

  constructor(trader: Trader) {
    this._trader = trader;
    // 记录做多标的的历史买入且已成交订单
    this._longBuyOrders = [];
    // 记录做空标的的历史买入且已成交订单
    this._shortBuyOrders = [];
    // 缓存订单数据，避免重复调用 historyOrders
    // 格式：{ symbol: { buyOrders: [], sellOrders: [], allOrders: [], fetchTime: number } }
    // allOrders: 保存原始订单数据（包括未成交订单），用于启动时提取未成交订单
    this._ordersCache = new Map();
  }

  /**
   * 获取当前标的的买入订单记录列表（内部使用）
   * @param symbol 标的代码
   * @param isLongSymbol 是否为做多标的
   * @returns 买入订单记录数组
   *   - 仅包含 { symbol, executedPrice, executedQuantity, executedTime, orderId? }
   */
  private _getBuyOrdersList(
    symbol: string,
    isLongSymbol: boolean,
  ): OrderRecord[] {
    const targetList = isLongSymbol
      ? this._longBuyOrders
      : this._shortBuyOrders;

    // 只返回当前标的的订单列表（避免不同标的混在一起）
    return targetList.filter((order) => order.symbol === symbol);
  }

  /**
   * 输出订单列表的debug信息（仅在DEBUG模式下）
   * @private
   * @param symbol 标的代码
   * @param isLongSymbol 是否为做多标的
   */
  private _debugOutputOrders(symbol: string, isLongSymbol: boolean): void {
    if (process.env['DEBUG'] === 'true') {
      const positionType = isLongSymbol ? '做多标的' : '做空标的';
      const normalizedSymbol = normalizeHKSymbol(symbol);
      const currentOrders = isLongSymbol
        ? this._longBuyOrders.filter((o) => o.symbol === normalizedSymbol)
        : this._shortBuyOrders.filter((o) => o.symbol === normalizedSymbol);
      // 批量构建日志消息，减少多次logger.debug调用
      const logLines = [
        `[订单记录变化] ${positionType} ${normalizedSymbol}: 当前订单列表 (共${currentOrders.length}笔)`,
      ];
      if (currentOrders.length > 0) {
        // 批量计算统计信息
        let totalQuantity = 0;
        let totalValue = 0;
        currentOrders.forEach((order, index) => {
          // 安全地获取数值，防止 NaN 或无效值
          const quantity = Number.isFinite(order.executedQuantity)
            ? order.executedQuantity
            : 0;
          const price = Number.isFinite(order.executedPrice)
            ? order.executedPrice
            : 0;
          totalQuantity += quantity;
          totalValue += price * quantity;
          // 安全地格式化时间
          let timeStr = '未知时间';
          if (order.executedTime) {
            try {
              const date = new Date(order.executedTime);
              if (!Number.isNaN(date.getTime())) {
                timeStr = date.toLocaleString('zh-CN', {
                  timeZone: 'Asia/Shanghai',
                });
              }
            } catch {
              // 日期格式化失败，使用默认值
              // 在debug输出中静默处理是合理的，避免影响主程序执行
              timeStr = '无效时间';
            }
          }
          // 安全地格式化价格
          const priceStr = Number.isFinite(price) ? price.toFixed(3) : 'N/A';
          logLines.push(
            `  [${index + 1}] 订单ID: ${order.orderId || 'N/A'}, ` +
              `价格: ${priceStr}, ` +
              `数量: ${quantity}, ` +
              `成交时间: ${timeStr}`,
          );
        });
        // 安全地计算和格式化平均价格
        const avgPrice = totalQuantity > 0 ? totalValue / totalQuantity : 0;
        const avgPriceStr = Number.isFinite(avgPrice)
          ? avgPrice.toFixed(3)
          : 'N/A';
        logLines.push(
          `  统计: 总数量=${totalQuantity}, 平均价格=${avgPriceStr}`,
        );
      } else {
        logLines.push('  当前无订单记录');
      }
      // 一次性输出所有日志（减少多次调用）
      logger.debug(logLines.join('\n'));
    }
  }

  /**
   * 替换当前标的的买入订单记录列表（内部使用）
   * @param symbol 标的代码
   * @param isLongSymbol 是否为做多标的
   * @param newList 新的订单列表
   */
  private _setBuyOrdersList(
    symbol: string,
    isLongSymbol: boolean,
    newList: OrderRecord[],
  ): void {
    if (isLongSymbol) {
      // 只保留其他标的的订单，再追加当前标的的新列表
      this._longBuyOrders = [
        ...this._longBuyOrders.filter((o) => o.symbol !== symbol),
        ...newList,
      ];
    } else {
      this._shortBuyOrders = [
        ...this._shortBuyOrders.filter((o) => o.symbol !== symbol),
        ...newList,
      ];
    }
    // 输出debug信息
    this._debugOutputOrders(symbol, isLongSymbol);
  }

  /**
   * 记录一笔新的买入订单（仅在程序运行期间本地更新，不调用 API）
   * @param symbol 标的代码
   * @param executedPrice 成交价
   * @param executedQuantity 成交数量
   * @param isLongSymbol 是否为做多标的
   */
  recordLocalBuy(
    symbol: string,
    executedPrice: number,
    executedQuantity: number,
    isLongSymbol: boolean,
  ): void {
    const normalizedSymbol = normalizeHKSymbol(symbol);
    const price = Number(executedPrice);
    const quantity = Number(executedQuantity);
    if (
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      logger.warn(
        `[现存订单记录] 本地买入记录参数无效，跳过记录：symbol=${symbol}, price=${executedPrice}, quantity=${executedQuantity}`,
      );
      return;
    }
    const now = Date.now();
    const list = this._getBuyOrdersList(normalizedSymbol, isLongSymbol);
    list.push({
      orderId: `LOCAL_${now}`, // 仅用于调试，无业务含义
      symbol: normalizedSymbol,
      executedPrice: price,
      executedQuantity: quantity,
      executedTime: now,
      submittedAt: undefined,
      updatedAt: undefined,
    });
    this._setBuyOrdersList(normalizedSymbol, isLongSymbol, list);
    const positionType = isLongSymbol ? '做多标的' : '做空标的';
    logger.info(
      `[现存订单记录] 本地新增买入记录：${positionType} ${normalizedSymbol} 价格=${price.toFixed(
        3,
      )} 数量=${quantity}`,
    );
  }

  /**
   * 根据一笔新的卖出订单，本地更新买入订单记录（不再调用 API）
   *
   * 规则：
   * 1. 如果本地买入记录的总数量 <= 本次卖出数量，认为全部卖出，清空记录
   * 2. 否则，仅保留成交价 >= 本次卖出价的买入订单
   *
   * @param symbol 标的代码
   * @param executedPrice 卖出成交价
   * @param executedQuantity 卖出成交数量
   * @param isLongSymbol 是否为做多标的
   */
  recordLocalSell(
    symbol: string,
    executedPrice: number,
    executedQuantity: number,
    isLongSymbol: boolean,
  ): void {
    const normalizedSymbol = normalizeHKSymbol(symbol);
    const price = Number(executedPrice);
    const quantity = Number(executedQuantity);
    if (
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      logger.warn(
        `[现存订单记录] 本地卖出记录参数无效，跳过更新：symbol=${symbol}, price=${executedPrice}, quantity=${executedQuantity}`,
      );
      return;
    }
    const list = this._getBuyOrdersList(normalizedSymbol, isLongSymbol);
    if (!list.length) {
      return;
    }
    const totalQuantity = list.reduce(
      (sum, order) => sum + (Number(order.executedQuantity) || 0),
      0,
    );
    const positionType = isLongSymbol ? '做多标的' : '做空标的';
    // 如果卖出数量大于等于当前记录的总数量，视为全部卖出，清空记录
    if (quantity >= totalQuantity) {
      this._setBuyOrdersList(normalizedSymbol, isLongSymbol, []);
      logger.info(
        `[现存订单记录] 本地卖出更新：${positionType} ${normalizedSymbol} 卖出数量=${quantity} >= 当前记录总数量=${totalQuantity}，清空所有买入记录`,
      );
      return;
    }
    // 否则，仅保留成交价 >= 本次卖出价的买入订单
    const filtered = list.filter(
      (order) =>
        Number.isFinite(order.executedPrice) && order.executedPrice >= price,
    );
    this._setBuyOrdersList(normalizedSymbol, isLongSymbol, filtered);
    logger.info(
      `[现存订单记录] 本地卖出更新：${positionType} ${normalizedSymbol} 卖出数量=${quantity}，按价格过滤后剩余买入记录 ${filtered.length} 笔`,
    );
  }

  /**
   * 获取最新买入订单的成交价（用于买入价格限制检查）
   * @param symbol 标的代码
   * @param isLongSymbol 是否为做多标的
   * @returns 最新买入订单的成交价，如果没有订单则返回null
   */
  getLatestBuyOrderPrice(symbol: string, isLongSymbol: boolean): number | null {
    const normalizedSymbol = normalizeHKSymbol(symbol);
    const list = this._getBuyOrdersList(normalizedSymbol, isLongSymbol);
    if (!list.length) {
      return null;
    }
    // 找出成交时间最新的订单
    const latestOrder = list.reduce<OrderRecord | null>((latest, current) => {
      if (!latest || current.executedTime > latest.executedTime) {
        return current;
      }
      return latest;
    }, null);

    return latestOrder ? latestOrder.executedPrice : null;
  }

  /**
   * 检查缓存是否有效
   * @private
   * @param normalizedSymbol 规范化后的标的代码
   * @returns 缓存是否有效
   */
  private _isCacheValid(normalizedSymbol: string): boolean {
    // 缓存永久有效，只要存在就认为有效
    // 只有在 forceRefresh=true 时才会重新从 API 获取
    return this._ordersCache.has(normalizedSymbol);
  }

  /**
   * 从缓存获取订单数据
   * @private
   * @param normalizedSymbol 规范化后的标的代码
   * @returns 缓存的订单数据，如果不存在则返回null
   */
  private _getCachedOrders(
    normalizedSymbol: string,
  ): { buyOrders: OrderRecord[]; sellOrders: OrderRecord[] } | null {
    const cached = this._ordersCache.get(normalizedSymbol);
    if (!cached) {
      return null;
    }
    return {
      buyOrders: cached.buyOrders,
      sellOrders: cached.sellOrders,
    };
  }

  /**
   * 更新缓存
   * @private
   * @param normalizedSymbol 规范化后的标的代码
   * @param buyOrders 买入订单列表（已成交）
   * @param sellOrders 卖出订单列表（已成交）
   * @param allOrders 原始订单列表（包含所有状态的订单，用于提取未成交订单）
   */
  private _updateCache(
    normalizedSymbol: string,
    buyOrders: OrderRecord[],
    sellOrders: OrderRecord[],
    allOrders: unknown[] | null = null,
  ): void {
    this._ordersCache.set(normalizedSymbol, {
      buyOrders,
      sellOrders,
      allOrders, // 保存原始订单数据，用于启动时提取未成交订单
      fetchTime: Date.now(),
    });
  }

  /**
   * 从API获取并转换订单数据（公开方法，用于启动时或需要强制刷新时调用）
   * 调用此方法会同时从历史订单和今日订单API获取数据，合并并去重后更新缓存，此为保护机制防止historyOrders api出现遗漏问题
   * @param symbol 标的代码
   * @returns 返回已转换的买入和卖出订单
   */
  async fetchOrdersFromAPI(symbol: string): Promise<FetchOrdersResult> {
    const normalizedSymbol = normalizeHKSymbol(symbol);
    const ctx = await this._trader._ctxPromise;
    // 同时获取历史订单和今日订单
    // 注意：historyOrders 可能不包含今日的订单，todayOrders 只包含今日的订单
    const [historyOrders, todayOrders] = await Promise.all([
      ctx.historyOrders({
        symbol: normalizedSymbol,
        endAt: new Date(),
      }),

      ctx.todayOrders({ symbol: normalizedSymbol }),
    ]);
    // 合并两个API的结果并去重（基于 orderId）
    const orderIdSet = new Set<string>();
    const allOrders: unknown[] = [];
    // 先添加历史订单
    for (const order of historyOrders) {
      const o = order as { orderId: string };
      if (!orderIdSet.has(o.orderId)) {
        orderIdSet.add(o.orderId);
        allOrders.push(order);
      }
    }
    // 再添加今日订单（去重）
    for (const order of todayOrders) {
      const o = order as { orderId: string };
      if (!orderIdSet.has(o.orderId)) {
        orderIdSet.add(o.orderId);
        allOrders.push(order);
      }
    }
    // 过滤出买入且已成交的订单
    const filledBuyOrders = allOrders.filter((order: unknown) => {
      const o = order as { side: unknown; status: unknown };

      return (
        o.side === OrderSide.Buy && // 买入订单
        o.status === OrderStatus.Filled // 已成交状态
      );
    });
    // 过滤出卖出且已成交的订单
    const filledSellOrders = allOrders.filter((order: unknown) => {
      const o = order as { side: unknown; status: unknown };

      return (
        o.side === OrderSide.Sell && // 卖出订单
        o.status === OrderStatus.Filled // 已成交状态
      );
    });
    // 转换订单为标准格式的通用函数
    const convertOrder = (
      order: unknown,
      isBuyOrder: boolean,
    ): OrderRecord | null => {
      const o = order as {
        orderId: string;
        executedPrice: unknown;
        executedQuantity: unknown;
        updatedAt?: Date;
        submittedAt?: Date;
      };
      const executedPrice = decimalToNumber(
        o.executedPrice as DecimalLikeValue,
      );
      const executedQuantity = decimalToNumber(
        o.executedQuantity as DecimalLikeValue,
      );
      const executedTime = o.updatedAt ? o.updatedAt.getTime() : 0;
      // 验证数据有效性
      if (
        !Number.isFinite(executedPrice) ||
        executedPrice <= 0 ||
        !Number.isFinite(executedQuantity) ||
        executedQuantity <= 0 ||
        executedTime === 0
      ) {
        return null;
      }
      const converted: OrderRecord = {
        orderId: o.orderId,
        symbol: normalizedSymbol,
        executedPrice: executedPrice,
        executedQuantity: executedQuantity,
        executedTime: executedTime,
        submittedAt: undefined,
        updatedAt: undefined,
      };
      // 买入订单额外包含时间戳字段（用于refreshOrders）
      if (isBuyOrder) {
        converted.submittedAt = o.submittedAt;
        converted.updatedAt = o.updatedAt;
      }
      return converted;
    };
    // 转换买入订单
    const buyOrders = filledBuyOrders
      .map((order: unknown) => convertOrder(order, true))
      .filter((order): order is OrderRecord => order !== null);
    // 转换卖出订单
    const sellOrders = filledSellOrders
      .map((order: unknown) => convertOrder(order, false))
      .filter((order): order is OrderRecord => order !== null);
    // 更新缓存（包含原始订单数据，用于启动时提取未成交订单）
    this._updateCache(normalizedSymbol, buyOrders, sellOrders, allOrders);
    return { buyOrders, sellOrders };
  }

  /**
   * 从缓存的原始订单中提取未成交订单（用于启动时避免重复调用 todayOrders）
   * @param symbols 标的代码数组
   * @returns 未成交订单列表，格式与 getPendingOrders 返回的格式一致
   */
  getPendingOrdersFromCache(symbols: string[]): PendingOrder[] {
    const pendingStatuses = new Set([
      OrderStatus.New,
      OrderStatus.PartialFilled,
      OrderStatus.WaitToNew,
      OrderStatus.WaitToReplace,
      OrderStatus.PendingReplace,
    ]);
    const result: PendingOrder[] = [];
    for (const symbol of symbols) {
      const normalizedSymbol = normalizeHKSymbol(symbol);
      const cached = this._ordersCache.get(normalizedSymbol);
      // 如果缓存不存在或无效，跳过
      if (!cached?.allOrders) {
        continue;
      }
      // 从缓存的原始订单中提取未成交订单
      const pendingOrders = (
        cached.allOrders as Array<{
          status: unknown;
          symbol: string;
          orderId: string;
          side: unknown;
          price: unknown;
          quantity: unknown;
          executedQuantity: unknown;
          orderType: unknown;
        }>
      )
        .filter((order) => {
          // 过滤状态：只保留未成交订单
          if (
            !pendingStatuses.has(
              order.status as (typeof OrderStatus)[keyof typeof OrderStatus],
            )
          ) {
            return false;
          }
          // 过滤标的
          const normalizedOrderSymbol = normalizeHKSymbol(order.symbol);

          return normalizedOrderSymbol === normalizedSymbol;
        })
        .map((order) => ({
          orderId: order.orderId,
          symbol: order.symbol,
          side: order.side as (typeof OrderSide)[keyof typeof OrderSide],
          submittedPrice: decimalToNumber(
            order.price as DecimalLikeValue,
          ),
          quantity: decimalToNumber(order.quantity as DecimalLikeValue),
          executedQuantity: decimalToNumber(
            order.executedQuantity as DecimalLikeValue,
          ),
          status:
            order.status as (typeof OrderStatus)[keyof typeof OrderStatus],
          orderType: order.orderType,
          _rawOrder: order,
        }));
      result.push(...pendingOrders);
    }
    return result;
  }

  /**
   * 获取并转换订单数据（统一入口，默认使用缓存）
   * @private
   * @param symbol 标的代码
   * @param forceRefresh 是否强制刷新（忽略缓存），默认false（使用缓存）
   * @returns 返回已转换的买入和卖出订单
   */
  private async _fetchAndConvertOrders(
    symbol: string,
    forceRefresh: boolean = false,
  ): Promise<FetchOrdersResult> {
    const normalizedSymbol = normalizeHKSymbol(symbol);
    // 如果不强制刷新，先检查缓存
    if (!forceRefresh && this._isCacheValid(normalizedSymbol)) {
      const cached = this._getCachedOrders(normalizedSymbol);
      if (cached) {
        return cached;
      }
    }
    // 缓存无效或强制刷新，从API获取
    return await this.fetchOrdersFromAPI(symbol);
  }

  /**
   * 刷新订单记录（用于智能清仓决策）
   * 过滤逻辑：
   * 1. 获取历史所有买入订单（已成交）
   * 2. 获取历史所有卖出订单（已成交）
   * 3. 如果没有卖出订单，记录所有买入订单
   * 4. 如果有卖出订单：
   *    - M0: 成交时间 > 最新卖出订单时间的买入订单
   *    - 将卖出订单按成交时间从旧到新排序（D1是最旧的，D2次之，D3是最新的）
   *    - 从最旧的卖出订单开始（D1），依次判断和过滤：
   *      a) 获取所有 成交时间 < D1成交时间 的买入订单
   *      b) 计算这些买入订单的总数量
   *      c) 如果 D1的成交数量 >= 这些买入订单的总数量，则这些买入订单全部被卖出，无需记录
   *      d) 否则，从这些买入订单中过滤出 成交价 >= D1成交价 的买入订单
   *      e) 将这些过滤出的买入订单 + 成交时间 > D1 且 < D2成交时间 的买入订单 = M1
   *      f) 继续对 M1 使用 D2 的成交时间和成交价过滤，得到 M2
   *      g) 以此类推，得到 MN
   *    - 最终订单列表 = M0 + MN
   * @param symbol 标的代码
   * @param isLongSymbol 是否为做多标的（true=做多，false=做空）
   * @param forceRefresh 是否强制刷新（忽略缓存），默认false（使用缓存）
   * @returns 记录的订单列表
   */
  async refreshOrders(
    symbol: string,
    isLongSymbol: boolean,
    forceRefresh: boolean = false,
  ): Promise<OrderRecord[]> {
    try {
      const normalizedSymbol = normalizeHKSymbol(symbol);
      // 使用统一方法获取和转换订单（默认使用缓存，forceRefresh=true时强制刷新）
      const { buyOrders: allBuyOrders, sellOrders: filledSellOrders } =
        await this._fetchAndConvertOrders(symbol, forceRefresh);
      // 如果没有买入订单，直接返回空列表
      if (allBuyOrders.length === 0) {
        if (isLongSymbol) {
          this._longBuyOrders = [];
          logger.info(
            `[现存订单记录] 做多标的 ${normalizedSymbol}: 历史买入0笔, 无需记录`,
          );
        } else {
          this._shortBuyOrders = [];
          logger.info(
            `[现存订单记录] 做空标的 ${normalizedSymbol}: 历史买入0笔, 无需记录`,
          );
        }
        // 输出debug信息
        this._debugOutputOrders(symbol, isLongSymbol);
        return [];
      }
      // 如果没有卖出订单，记录所有买入订单
      if (filledSellOrders.length === 0) {
        if (isLongSymbol) {
          this._longBuyOrders = allBuyOrders;
          logger.info(
            `[现存订单记录] 做多标的 ${normalizedSymbol}: 历史买入${allBuyOrders.length}笔, 无卖出记录, 记录全部买入订单`,
          );
        } else {
          this._shortBuyOrders = allBuyOrders;
          logger.info(
            `[现存订单记录] 做空标的 ${normalizedSymbol}: 历史买入${allBuyOrders.length}笔, 无卖出记录, 记录全部买入订单`,
          );
        }
        // 输出debug信息
        this._debugOutputOrders(symbol, isLongSymbol);
        return allBuyOrders;
      }
      // 将卖出订单按成交时间从旧到新排序（最旧的在前）
      const sortedSellOrders = [...filledSellOrders].sort(
        (a, b) => a.executedTime - b.executedTime,
      );
      // 防御性检查：确保有卖出订单
      if (sortedSellOrders.length === 0) {
        logger.warn(
          `[现存订单记录] ${normalizedSymbol} 卖出订单列表为空，跳过过滤逻辑`,
        );
        return allBuyOrders;
      }
      // 1. 先获取M0：成交时间 > 最新卖出订单时间的买入订单
      const latestSellTime = sortedSellOrders.at(-1)!.executedTime; // 最新的卖出订单时间
      const m0 = allBuyOrders.filter(
        (buyOrder) => buyOrder.executedTime > latestSellTime,
      );
      // 2. 从最旧的卖出订单开始，依次过滤买入订单
      // 初始候选列表：所有成交时间 <= 最新卖出订单时间的买入订单
      let currentBuyOrders = allBuyOrders.filter(
        (buyOrder) => buyOrder.executedTime <= latestSellTime,
      );
      // 从最旧的卖出订单开始，依次过滤（D1 -> D2 -> D3，D1是最旧的）
      for (let i = 0; i < sortedSellOrders.length; i++) {
        const sellOrder = sortedSellOrders[i]!;
        const sellTime = sellOrder.executedTime;
        const sellPrice = sellOrder.executedPrice;
        const sellQuantity = sellOrder.executedQuantity;
        // 获取下一个卖出订单的时间（如果存在），用于确定时间范围
        const nextSellTime =
          i < sortedSellOrders.length - 1
            ? sortedSellOrders[i + 1]!.executedTime
            : latestSellTime + 1; // 如果没有下一个，设为latestSellTime+1表示上限
        // 获取所有 成交时间 < 当前卖出订单成交时间 的买入订单（从currentBuyOrders中）
        // 注意：对于D1，currentBuyOrders是所有成交时间 <= 最新卖出订单时间的买入订单
        // 对于D2，currentBuyOrders是M1，所以这里获取的是M1中成交时间 < D2成交时间的买入订单
        const buyOrdersBeforeSell = currentBuyOrders.filter(
          (buyOrder) => buyOrder.executedTime < sellTime,
        );
        // 判断是否全部卖出：
        // 统一逻辑：判断当前卖出订单成交数量 >= 成交时间小于该卖出订单的买入订单总数量
        // - 对于D1：判断D1成交数量 >= 所有成交时间 < D1的买入订单总数量
        // - 对于D2：判断D2成交数量 >= M1中成交时间 < D2的买入订单总数量
        // - 对于D3：判断D3成交数量 >= M2中成交时间 < D3的买入订单总数量
        const quantityToCompare = buyOrdersBeforeSell.reduce(
          (sum, order) => sum + order.executedQuantity,
          0,
        );
        // 如果卖出数量 >= 比较数量，说明成交时间小于该卖出订单的买入订单全部被卖出
        if (sellQuantity >= quantityToCompare) {
          // 从候选列表中移除这些买入订单（视为全部被卖出）
          // 保留成交时间 >= 当前卖出订单时间的买入订单
          currentBuyOrders = currentBuyOrders.filter(
            (buyOrder) => buyOrder.executedTime >= sellTime,
          );
          // 无需继续过滤价格，直接跳到下一个卖出订单
          continue;
        }
        // 如果没有在此卖出订单之前的买入订单，跳过价格过滤
        if (buyOrdersBeforeSell.length === 0) {
          // 更新currentBuyOrders：保留成交时间 >= 当前卖出订单时间的买入订单
          currentBuyOrders = currentBuyOrders.filter(
            (buyOrder) => buyOrder.executedTime >= sellTime,
          );
          continue;
        }
        // 否则，按价格过滤：从这些买入订单中过滤出 成交价 >= 卖出价 的买入订单
        // 例如：从M1中过滤出成交时间 < D2成交时间且成交价 >= D2成交价的买入订单
        const filteredBuyOrders = buyOrdersBeforeSell.filter(
          (buyOrder) => buyOrder.executedPrice >= sellPrice,
        );
        // 获取成交时间 > 当前卖出订单时间 且 < 下一个卖出订单时间（如果存在）的买入订单
        // 注意：这些订单应该从currentBuyOrders中获取，因为currentBuyOrders是经过之前卖出订单过滤后的结果（M1, M2等）
        const buyOrdersBetweenSells = currentBuyOrders.filter((buyOrder) => {
          if (buyOrder.executedTime <= sellTime) {
            return false; // 排除 <= 当前卖出订单时间的订单
          }
          if (buyOrder.executedTime >= nextSellTime) {
            return false; // 排除 >= 下一个卖出订单时间的订单
          }
          return true;
        });
        // 合并：过滤出的买入订单 + 时间范围内的买入订单 = 新的currentBuyOrders（即M1, M2等）
        currentBuyOrders = [...filteredBuyOrders, ...buyOrdersBetweenSells];
      }
      // 最终订单列表 = M0 + currentBuyOrders（即M0 + MN）
      const finalBuyOrders = [...m0, ...currentBuyOrders];
      // 更新记录
      const positionType = isLongSymbol ? '做多标的' : '做空标的';
      const originalBuyCount = allBuyOrders.length;
      const recordedCount = finalBuyOrders.length;
      if (isLongSymbol) {
        this._longBuyOrders = finalBuyOrders;
      } else {
        this._shortBuyOrders = finalBuyOrders;
      }
      logger.info(
        `[现存订单记录] ${positionType} ${normalizedSymbol}: ` +
          `历史买入${originalBuyCount}笔, ` +
          `历史卖出${filledSellOrders.length}笔(有效${sortedSellOrders.length}笔), ` +
          `最终记录${recordedCount}笔`,
      );
      // 输出debug信息
      this._debugOutputOrders(symbol, isLongSymbol);
      return finalBuyOrders;
    } catch (error) {
      logger.error(
        `[订单记录失败] 标的 ${symbol}`,
        (error as Error)?.message ?? String(error),
      );
      return [];
    }
  }

  /**
   * 通用函数：根据当前价格获取做多标的或做空标的中买入价低于当前价的订单
   * @param currentPrice 当前价格
   * @param direction 方向标识，'LONG' 表示做多标的，'SHORT' 表示做空标的
   * @returns 符合条件的订单列表
   * @private
   */
  getBuyOrdersBelowPrice(
    currentPrice: number,
    direction: 'LONG' | 'SHORT',
  ): OrderRecord[] {
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      return [];
    }
    const buyOrders =
      (direction === 'LONG' && this._longBuyOrders) ||
      (direction === 'SHORT' && this._shortBuyOrders) ||
      [];
    const directionName =
      (direction === 'LONG' && '做多标的') ||
      (direction === 'SHORT' && '做空标的') ||
      '';
    const filteredOrders = buyOrders.filter(
      (order) =>
        Number.isFinite(order.executedPrice) &&
        order.executedPrice < currentPrice,
    );
    logger.debug(
      `[根据订单记录过滤] ${directionName}，当前价格=${currentPrice}，当前订单=${JSON.stringify(
        buyOrders,
      )}，过滤后订单=${JSON.stringify(filteredOrders)}`,
    );
    return filteredOrders;
  }

  /**
   * 计算订单列表的总成交数量
   * @param orders 订单列表
   * @returns 总成交数量
   */
  calculateTotalQuantity(orders: OrderRecord[]): number {
    return orders.reduce((sum, order) => {
      return sum + (order.executedQuantity || 0);
    }, 0);
  }
}
