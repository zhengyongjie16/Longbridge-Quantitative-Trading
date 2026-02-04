/**
 * 获取所有已成交订单（上限1000条）
 *
 * 说明：
 * - historyOrders API 不包含当日订单
 * - todayOrders API 获取当日订单
 * - 本脚本合并两个 API 的结果以获取完整的订单记录
 * - 使用订单过滤算法识别当前仍持有的买入订单（多标的支持）
 *
 * 使用: node tests/getHistoryOrders.js
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { Config, TradeContext, OrderStatus, OrderSide } from 'longport';

// 加载环境变量
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

// ==================== 工具函数 ====================

/**
 * 将 Decimal 类型安全转换为数字
 * SDK 返回的 executedPrice/executedQuantity 是 Decimal 对象
 */
function decimalToNumber(decimalLike) {
  if (decimalLike === null || decimalLike === undefined) {
    return NaN;
  }
  if (typeof decimalLike === 'object' && typeof decimalLike.toNumber === 'function') {
    return decimalLike.toNumber();
  }
  return Number(decimalLike);
}

/**
 * 格式化时间为可读日期
 * SDK 返回的 updatedAt 是 Date 对象
 */
function formatTime(time) {
  if (!time) return 'N/A';
  const date = time instanceof Date ? time : new Date(time);
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong' });
}

/**
 * 格式化金额
 */
function formatAmount(amount, currency = '') {
  if (!amount) return 'N/A';
  const num = Number(amount);
  const prefix = currency ? `${currency} ` : '';
  if (num >= 1e6) return prefix + (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return prefix + (num / 1e3).toFixed(2) + 'K';
  return prefix + num.toFixed(2);
}

/**
 * 计算订单总金额（支持 Decimal 类型）
 */
function calculateOrderAmount(price, quantity) {
  const p = decimalToNumber(price) || 0;
  const q = decimalToNumber(quantity) || 0;
  return p * q;
}

/**
 * 判断是否为恒生指数牛证
 * 牛证 stockName 包含 "HSI" 且包含 "RC"（R=牛证, C=Call）
 */
function isHsiBullCbbc(stockName) {
  if (!stockName) return false;
  const name = stockName.toUpperCase();
  return name.includes('HSI') && name.includes('RC');
}

/**
 * 判断是否为恒生指数熊证
 * 熊证 stockName 包含 "HSI" 且包含 "RP"（R=熊证, P=Put）
 */
function isHsiBearCbbc(stockName) {
  if (!stockName) return false;
  const name = stockName.toUpperCase();
  return name.includes('HSI') && name.includes('RP');
}

/**
 * 打印订单列表
 */
function printOrderList(orders, title) {
  if (orders.length === 0) {
    console.log(`${title}: 无\n`);
    return;
  }

  console.log(`${title} (共 ${orders.length} 笔)\n`);
  console.log('序号 | 名称 | 标的代码 | 方向 | 数量 | 成交价 | 成交金额 | 成交时间');
  console.log('-'.repeat(100));

  let totalBuy = 0;
  let totalSell = 0;

  orders.forEach((order, index) => {
    const amount = calculateOrderAmount(order.executedPrice, order.executedQuantity);
    const isBuy = order.side === OrderSide.Buy;
    const sideLabel = isBuy ? '买入' : '卖出';

    if (isBuy) {
      totalBuy += amount;
    } else {
      totalSell += amount;
    }

    const executedQty = decimalToNumber(order.executedQuantity);
    const executedPrice = decimalToNumber(order.executedPrice);

    console.log(
      `${String(index + 1).padStart(3)} | ` +
      `${(order.stockName || '').substring(0, 20).padEnd(20)} | ` +
      `${order.symbol.padEnd(10)} | ` +
      `${sideLabel} | ` +
      `${String(executedQty).padStart(6)} | ` +
      `${executedPrice.toFixed(3).padStart(8)} | ` +
      `${formatAmount(amount, order.currency).padStart(12)} | ` +
      `${formatTime(order.updatedAt)}`
    );
  });

  console.log('-'.repeat(100));
  console.log(`买入总额: ${formatAmount(totalBuy)} | 卖出总额: ${formatAmount(totalSell)} | 净额: ${formatAmount(totalBuy - totalSell)}`);
  console.log('');
}

// ==================== 订单过滤算法（多标的支持） ====================

/**
 * 将 API 返回的订单转换为过滤算法所需的标准格式
 */
function normalizeOrder(order) {
  const executedTime = order.updatedAt instanceof Date
    ? order.updatedAt.getTime()
    : new Date(order.updatedAt).getTime();

  return {
    orderId: order.orderId,
    symbol: order.symbol,
    stockName: order.stockName,
    side: order.side,
    executedPrice: decimalToNumber(order.executedPrice),
    executedQuantity: decimalToNumber(order.executedQuantity),
    executedTime,
    currency: order.currency,
    // 保留原始订单引用，便于后续显示
    _original: order,
  };
}

/**
 * 计算订单列表的总成交数量
 */
function calculateTotalQuantityFromOrders(orders) {
  return orders.reduce((sum, order) => sum + (order.executedQuantity || 0), 0);
}

/**
 * 按数量限制调整订单列表
 * 当按价格过滤后保留数量超过限制时，优先保留高价订单（亏损订单）
 */
function adjustOrdersByQuantityLimit(orders, maxQuantity) {
  if (maxQuantity <= 0) {
    return [];
  }

  const currentQuantity = calculateTotalQuantityFromOrders(orders);
  if (currentQuantity <= maxQuantity) {
    return orders;
  }

  // 按价格从高到低排序（保留高价订单，因为它们是亏损的，应该最后被卖出）
  const sortedByPriceDesc = [...orders].sort((a, b) => b.executedPrice - a.executedPrice);

  const result = [];
  let accumulatedQuantity = 0;

  for (const order of sortedByPriceDesc) {
    if (accumulatedQuantity >= maxQuantity) {
      break;
    }
    if (accumulatedQuantity + order.executedQuantity > maxQuantity) {
      continue;
    }
    result.push(order);
    accumulatedQuantity += order.executedQuantity;
  }

  return result;
}

/**
 * 应用单个卖出订单的过滤
 */
function applySingleSellOrderFilter(currentBuyOrders, candidateOrders, sellOrder, nextSellOrder, latestSellTime) {
  const sellTime = sellOrder.executedTime;
  const sellPrice = sellOrder.executedPrice;
  const sellQuantity = sellOrder.executedQuantity;

  const nextSellTime = nextSellOrder ? nextSellOrder.executedTime : latestSellTime + 1;

  // 步骤1：获取成交时间 < 当前卖出订单时间的买入订单
  const buyOrdersBeforeSell = currentBuyOrders.filter(
    (buyOrder) => buyOrder.executedTime < sellTime
  );

  const totalBuyQuantity = calculateTotalQuantityFromOrders(buyOrdersBeforeSell);

  // 步骤2：从原始候选订单获取时间间隔内的买入订单
  const buyOrdersBetweenSells = candidateOrders.filter(
    (buyOrder) => buyOrder.executedTime > sellTime && buyOrder.executedTime < nextSellTime
  );

  // 步骤3：判断是否全部卖出
  if (sellQuantity >= totalBuyQuantity) {
    return [...buyOrdersBetweenSells];
  }

  if (buyOrdersBeforeSell.length === 0) {
    return [...buyOrdersBetweenSells];
  }

  // 步骤4：计算应该保留的最大数量
  const maxRetainQuantity = totalBuyQuantity - sellQuantity;

  // 步骤5：按价格过滤 - 保留成交价 >= 卖出价的订单（亏损订单优先保留）
  let filteredBuyOrders = buyOrdersBeforeSell.filter(
    (buyOrder) => buyOrder.executedPrice >= sellPrice
  );

  // 步骤6：确保保留数量不超过应保留数量
  filteredBuyOrders = adjustOrdersByQuantityLimit(filteredBuyOrders, maxRetainQuantity);

  return [...filteredBuyOrders, ...buyOrdersBetweenSells];
}

/**
 * 应用订单过滤算法（单标的）
 * 识别未被完全卖出的买入订单
 *
 * @param allBuyOrders - 该标的所有买入订单
 * @param filledSellOrders - 该标的所有已成交卖出订单
 * @returns 当前仍持有的买入订单
 */
function applyFilteringAlgorithmForSymbol(allBuyOrders, filledSellOrders) {
  // 将卖出订单按成交时间从旧到新排序
  const sortedSellOrders = [...filledSellOrders].sort((a, b) => a.executedTime - b.executedTime);

  // 如果没有卖出订单，保留所有买入订单
  if (sortedSellOrders.length === 0) {
    return allBuyOrders;
  }

  const lastSellOrder = sortedSellOrders.at(-1);
  if (!lastSellOrder) {
    return allBuyOrders;
  }

  const latestSellTime = lastSellOrder.executedTime;

  // M0: 成交时间 > 最新卖出订单时间的买入订单（无条件保留）
  const m0Orders = [];
  // 候选订单：成交时间 <= 最新卖出订单时间的买入订单
  const candidateOrders = [];

  for (const buyOrder of allBuyOrders) {
    if (buyOrder.executedTime > latestSellTime) {
      m0Orders.push(buyOrder);
    } else {
      candidateOrders.push(buyOrder);
    }
  }

  // 获取第一个卖出订单的时间
  const firstSellTime = sortedSellOrders[0]?.executedTime ?? 0;

  // 初始订单：成交时间 < 第一个卖出订单时间的买入订单
  let currentBuyOrders = candidateOrders.filter(
    (buyOrder) => buyOrder.executedTime < firstSellTime
  );

  // 按时间顺序处理每个卖出订单
  for (let i = 0; i < sortedSellOrders.length; i++) {
    const sellOrder = sortedSellOrders[i];
    if (!sellOrder) continue;

    currentBuyOrders = applySingleSellOrderFilter(
      currentBuyOrders,
      candidateOrders,
      sellOrder,
      sortedSellOrders[i + 1] ?? null,
      latestSellTime
    );
  }

  // 合并 M0 和过滤后的订单
  return [...m0Orders, ...currentBuyOrders];
}

/**
 * 多标的订单过滤算法
 * 将订单按标的分组，对每个标的分别应用过滤算法
 *
 * @param allOrders - 所有订单（包含买入和卖出）
 * @returns 所有标的当前仍持有的买入订单
 */
function applyMultiSymbolFiltering(allOrders) {
  // 转换为标准格式
  const normalizedOrders = allOrders.map(normalizeOrder);

  // 按标的分组
  const ordersBySymbol = new Map();
  for (const order of normalizedOrders) {
    if (!ordersBySymbol.has(order.symbol)) {
      ordersBySymbol.set(order.symbol, { buyOrders: [], sellOrders: [] });
    }
    const group = ordersBySymbol.get(order.symbol);
    if (order.side === OrderSide.Buy) {
      group.buyOrders.push(order);
    } else {
      group.sellOrders.push(order);
    }
  }

  // 对每个标的应用过滤算法
  const filteredOrders = [];
  const filteringStats = [];

  for (const [symbol, { buyOrders, sellOrders }] of ordersBySymbol) {
    const filtered = applyFilteringAlgorithmForSymbol(buyOrders, sellOrders);
    filteredOrders.push(...filtered);

    // 记录统计信息
    if (buyOrders.length > 0 || sellOrders.length > 0) {
      filteringStats.push({
        symbol,
        stockName: buyOrders[0]?.stockName || sellOrders[0]?.stockName || '',
        originalBuyCount: buyOrders.length,
        originalBuyQuantity: calculateTotalQuantityFromOrders(buyOrders),
        sellCount: sellOrders.length,
        sellQuantity: calculateTotalQuantityFromOrders(sellOrders),
        filteredCount: filtered.length,
        filteredQuantity: calculateTotalQuantityFromOrders(filtered),
      });
    }
  }

  return { filteredOrders, filteringStats };
}

/**
 * 打印过滤后的持仓订单列表
 */
function printFilteredOrderList(orders, title) {
  if (orders.length === 0) {
    console.log(`${title}: 无持仓\n`);
    return;
  }

  // 按标的分组
  const ordersBySymbol = new Map();
  for (const order of orders) {
    if (!ordersBySymbol.has(order.symbol)) {
      ordersBySymbol.set(order.symbol, []);
    }
    ordersBySymbol.get(order.symbol).push(order);
  }

  console.log(`${title} (共 ${orders.length} 笔, ${ordersBySymbol.size} 个标的)\n`);
  console.log('序号 | 名称 | 标的代码 | 数量 | 成交价 | 成交金额 | 成交时间');
  console.log('-'.repeat(100));

  let totalAmount = 0;
  let totalQuantity = 0;
  let index = 0;

  // 按标的输出
  for (const [symbol, symbolOrders] of ordersBySymbol) {
    for (const order of symbolOrders) {
      index++;
      const amount = order.executedPrice * order.executedQuantity;
      totalAmount += amount;
      totalQuantity += order.executedQuantity;

      console.log(
        `${String(index).padStart(3)} | ` +
        `${(order.stockName || '').substring(0, 20).padEnd(20)} | ` +
        `${order.symbol.padEnd(10)} | ` +
        `${String(order.executedQuantity).padStart(6)} | ` +
        `${order.executedPrice.toFixed(3).padStart(8)} | ` +
        `${formatAmount(amount, order.currency).padStart(12)} | ` +
        `${formatTime(order.executedTime)}`
      );
    }
  }

  console.log('-'.repeat(100));
  console.log(`持仓总量: ${totalQuantity} | 持仓市值: ${formatAmount(totalAmount)}`);
  console.log('');
}

// ==================== 主程序 ====================

async function main() {
  console.log('\n====== 获取所有已成交订单（上限1000条） ======\n');

  // 初始化交易上下文
  const config = Config.fromEnv();
  const ctx = await TradeContext.new(config);

  // 获取历史订单（已成交状态，不包含当日，不设日期范围）
  console.log('正在获取历史订单...');
  const historyOrders = await ctx.historyOrders({
    status: [OrderStatus.Filled],
  });
  console.log(`历史订单: ${historyOrders.length} 笔`);

  // 获取当日订单（已成交状态）
  console.log('正在获取当日订单...');
  const todayOrders = await ctx.todayOrders({
    status: [OrderStatus.Filled],
  });
  console.log(`当日订单: ${todayOrders.length} 笔`);

  // 合并订单并按 orderId 去重
  const orderMap = new Map();
  for (const order of historyOrders) {
    orderMap.set(order.orderId, order);
  }
  for (const order of todayOrders) {
    orderMap.set(order.orderId, order);
  }

  // 按更新时间排序（最新的在前）
  const orders = Array.from(orderMap.values()).sort((a, b) => {
    const timeA = a.updatedAt instanceof Date ? a.updatedAt.getTime() : new Date(a.updatedAt).getTime();
    const timeB = b.updatedAt instanceof Date ? b.updatedAt.getTime() : new Date(b.updatedAt).getTime();
    return timeB - timeA;
  });

  console.log(`\n合并去重后共 ${orders.length} 笔已成交订单\n`);

  if (orders.length === 0) {
    console.log('没有已成交的订单');
    return { orders: [], summary: null };
  }

  // 输出第一个订单的完整 JSON 示例
  console.log('====== 订单返回实例 (JSON) ======\n');
  const sampleOrder = orders[0];
  const sampleJson = {
    orderId: sampleOrder.orderId,
    status: sampleOrder.status,
    stockName: sampleOrder.stockName,
    symbol: sampleOrder.symbol,
    side: sampleOrder.side,
    quantity: sampleOrder.quantity?.toString?.() ?? sampleOrder.quantity,
    executedQuantity: sampleOrder.executedQuantity?.toString?.() ?? sampleOrder.executedQuantity,
    price: sampleOrder.price?.toString?.() ?? sampleOrder.price,
    executedPrice: sampleOrder.executedPrice?.toString?.() ?? sampleOrder.executedPrice,
    submittedAt: sampleOrder.submittedAt,
    updatedAt: sampleOrder.updatedAt,
    triggerAt: sampleOrder.triggerAt,
    orderType: sampleOrder.orderType,
    lastDone: sampleOrder.lastDone?.toString?.() ?? sampleOrder.lastDone,
    triggerPrice: sampleOrder.triggerPrice?.toString?.() ?? sampleOrder.triggerPrice,
    msg: sampleOrder.msg,
    tag: sampleOrder.tag,
    timeInForce: sampleOrder.timeInForce,
    expireDate: sampleOrder.expireDate,
    trailingAmount: sampleOrder.trailingAmount?.toString?.() ?? sampleOrder.trailingAmount,
    trailingPercent: sampleOrder.trailingPercent?.toString?.() ?? sampleOrder.trailingPercent,
    limitOffset: sampleOrder.limitOffset?.toString?.() ?? sampleOrder.limitOffset,
    triggerStatus: sampleOrder.triggerStatus,
    currency: sampleOrder.currency,
    outsideRth: sampleOrder.outsideRth,
    remark: sampleOrder.remark,
  };
  console.log(JSON.stringify(sampleJson, null, 2));
  console.log('');

  // 统计数据
  let totalBuyAmount = 0;
  let totalSellAmount = 0;
  let buyCount = 0;
  let sellCount = 0;

  console.log('====== 订单详情 ======\n');
  console.log('序号 | 标的代码 | 方向 | 数量 | 成交价 | 成交金额 | 成交时间');
  console.log('-'.repeat(80));

  orders.forEach((order, index) => {
    const amount = calculateOrderAmount(order.executedPrice, order.executedQuantity);
    const isBuy = order.side === OrderSide.Buy;
    const sideLabel = isBuy ? '买入' : '卖出';

    // 统计
    if (isBuy) {
      totalBuyAmount += amount;
      buyCount++;
    } else {
      totalSellAmount += amount;
      sellCount++;
    }

    const executedQty = decimalToNumber(order.executedQuantity);
    const executedPrice = decimalToNumber(order.executedPrice);

    console.log(
      `${String(index + 1).padStart(3)} | ` +
      `${order.symbol.padEnd(10)} | ` +
      `${sideLabel} | ` +
      `${String(executedQty).padStart(6)} | ` +
      `${executedPrice.toFixed(3).padStart(8)} | ` +
      `${formatAmount(amount, order.currency).padStart(12)} | ` +
      `${formatTime(order.updatedAt)}`
    );
  });

  // 输出汇总
  console.log('\n====== 汇总统计 ======\n');
  console.log(`买入订单: ${buyCount} 笔, 总金额: ${formatAmount(totalBuyAmount)}`);
  console.log(`卖出订单: ${sellCount} 笔, 总金额: ${formatAmount(totalSellAmount)}`);
  console.log(`净买入金额: ${formatAmount(totalBuyAmount - totalSellAmount)}`);

  // 按标的分组统计
  const symbolStats = {};
  for (const order of orders) {
    const symbol = order.symbol;
    if (!symbolStats[symbol]) {
      symbolStats[symbol] = { buyQty: 0, sellQty: 0, buyAmount: 0, sellAmount: 0 };
    }
    const amount = calculateOrderAmount(order.executedPrice, order.executedQuantity);
    const qty = decimalToNumber(order.executedQuantity) || 0;
    if (order.side === OrderSide.Buy) {
      symbolStats[symbol].buyQty += qty;
      symbolStats[symbol].buyAmount += amount;
    } else {
      symbolStats[symbol].sellQty += qty;
      symbolStats[symbol].sellAmount += amount;
    }
  }

  console.log('\n====== 按标的分组 ======\n');
  console.log('标的代码 | 买入数量 | 卖出数量 | 买入金额 | 卖出金额');
  console.log('-'.repeat(70));

  for (const [symbol, stats] of Object.entries(symbolStats)) {
    console.log(
      `${symbol.padEnd(10)} | ` +
      `${String(stats.buyQty).padStart(8)} | ` +
      `${String(stats.sellQty).padStart(8)} | ` +
      `${formatAmount(stats.buyAmount).padStart(10)} | ` +
      `${formatAmount(stats.sellAmount).padStart(10)}`
    );
  }

  // ==================== 恒生指数牛熊证分类（全部订单） ====================

  // 过滤恒生指数牛证
  const hsiBullOrders = orders.filter((order) => isHsiBullCbbc(order.stockName));

  // 过滤恒生指数熊证
  const hsiBearOrders = orders.filter((order) => isHsiBearCbbc(order.stockName));

  console.log('\n====== 恒生指数牛熊证分类（全部订单） ======\n');

  // 打印牛证列表
  printOrderList(hsiBullOrders, '恒生指数牛证 (HSI Bull CBBC) - 全部订单');

  // 打印熊证列表
  printOrderList(hsiBearOrders, '恒生指数熊证 (HSI Bear CBBC) - 全部订单');

  // ==================== 使用过滤算法识别当前持仓 ====================

  console.log('\n====== 订单过滤算法（识别当前持仓） ======\n');
  console.log('过滤算法说明：');
  console.log('- 目标：识别未被完全卖出的买入订单');
  console.log('- 按标的分组，对每个标的分别应用过滤');
  console.log('- 卖出订单按时间从旧到新处理');
  console.log('- 优先保留高价买入订单（亏损订单）\n');

  // 应用多标的过滤算法
  const { filteredOrders, filteringStats } = applyMultiSymbolFiltering(orders);

  // 输出过滤统计
  console.log('====== 过滤统计（按标的） ======\n');
  console.log('标的代码 | 名称 | 买入笔数 | 买入数量 | 卖出笔数 | 卖出数量 | 持仓笔数 | 持仓数量');
  console.log('-'.repeat(120));

  for (const stat of filteringStats) {
    console.log(
      `${stat.symbol.padEnd(10)} | ` +
      `${(stat.stockName || '').substring(0, 18).padEnd(18)} | ` +
      `${String(stat.originalBuyCount).padStart(8)} | ` +
      `${String(stat.originalBuyQuantity).padStart(8)} | ` +
      `${String(stat.sellCount).padStart(8)} | ` +
      `${String(stat.sellQuantity).padStart(8)} | ` +
      `${String(stat.filteredCount).padStart(8)} | ` +
      `${String(stat.filteredQuantity).padStart(8)}`
    );
  }
  console.log('');

  // 从过滤后的订单中筛选恒生指数牛熊证
  const filteredHsiBullOrders = filteredOrders.filter((order) => isHsiBullCbbc(order.stockName));
  const filteredHsiBearOrders = filteredOrders.filter((order) => isHsiBearCbbc(order.stockName));

  console.log('\n====== 恒生指数牛熊证当前持仓（过滤后） ======\n');

  // 打印牛证持仓
  printFilteredOrderList(filteredHsiBullOrders, '恒生指数牛证 (HSI Bull CBBC) - 当前持仓');

  // 打印熊证持仓
  printFilteredOrderList(filteredHsiBearOrders, '恒生指数熊证 (HSI Bear CBBC) - 当前持仓');

  return {
    orders,
    summary: {
      totalOrders: orders.length,
      buyCount,
      sellCount,
      totalBuyAmount,
      totalSellAmount,
      symbolStats,
    },
  };
}

main()
  .then((result) => {
    console.log('\n====== 完成 ======\n');
    process.exit(0);
  })
  .catch((e) => {
    console.error('错误:', e.message);
    process.exit(1);
  });
