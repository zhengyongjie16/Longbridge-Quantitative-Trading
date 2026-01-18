/**
 * 账户显示模块
 *
 * 功能：
 * - 格式化显示账户快照信息
 * - 格式化显示持仓详情
 * - 记录交易后的账户状态变化
 *
 * 显示内容：
 * - 账户：余额、市值、持仓市值
 * - 持仓：标的名称、数量、现价/成本价、市值、仓位百分比
 *
 * 使用场景：
 * - 程序启动时显示初始账户状态
 * - 每次交易后显示更新后的账户和持仓
 */

import { logger } from '../logger/index.js';
import {
  formatError,
  normalizeHKSymbol,
  formatAccountChannel,
  formatNumber,
  isValidPositiveNumber,
} from './index.js';

import type { Trader, MarketDataClient, LastState } from '../../types/index.js';

/**
 * 显示账户和持仓信息
 *
 * 调用场景：
 * - 程序启动时：缓存为空，调用 API 获取账户和持仓信息
 * - 订单成交后：缓存已由主循环刷新，直接使用缓存显示
 *
 * API 调用说明：
 * - 账户/持仓 API：仅在程序启动时调用（缓存为空时）
 * - 行情 API（getQuotes）：从本地 WebSocket 缓存读取，不发起 HTTP 请求
 *
 * @param trader Trader实例
 * @param marketDataClient MarketDataClient实例
 * @param lastState 状态对象，用于读取/更新缓存
 */
export async function displayAccountAndPositions(
  trader: Trader,
  marketDataClient: MarketDataClient,
  lastState: LastState,
): Promise<void> {
  try {
    // 检查是否有缓存数据（账户缓存非空即可，持仓缓存可以是空数组表示无持仓）
    const hasCache = lastState.cachedAccount !== null;

    let account = lastState.cachedAccount;
    let positions = lastState.cachedPositions;

    // 仅当缓存为空时才从 API 获取数据
    if (!hasCache) {
      // 并行获取账户信息和持仓信息，减少等待时间
      const [freshAccount, freshPositions] = await Promise.all([
        trader.getAccountSnapshot().catch((err: Error) => {
          logger.warn(
            '获取账户信息失败',
            formatError(err),
          );
          return null;
        }),
        trader.getStockPositions().catch((err: Error) => {
          logger.warn(
            '获取股票仓位失败',
            formatError(err),
          );
          return [];
        }),
      ]);

      account = freshAccount;
      positions = freshPositions;

      // 更新缓存
      lastState.cachedAccount = account;
      lastState.cachedPositions = positions;
      // 同步更新持仓缓存（O(1) 查找优化）
      lastState.positionCache.update(positions);
    }

    // 显示账户和持仓信息
    if (account) {
      logger.info(
        `账户概览 [${account.currency}] 余额=${account.totalCash.toFixed(
          2,
        )} 市值=${account.netAssets.toFixed(
          2,
        )} 持仓市值≈${account.positionValue.toFixed(2)}`,
      );
    }
    if (Array.isArray(positions) && positions.length > 0) {
      logger.info('股票持仓：');

      // 批量获取所有持仓标的的完整信息（包含中文名称和价格）
      const positionSymbols = positions.map((p) => p.symbol).filter(Boolean);
      const symbolInfoMap = new Map<string, { name: string | null; price: number | null }>(); // key: normalizedSymbol, value: {name, price}
      if (positionSymbols.length > 0) {
        // 使用 getQuotes 批量获取所有标的的完整信息
        // 单独 catch：持仓中可能存在未订阅的标的（如用户手动交易的）
        try {
          const quotesMap = await marketDataClient.getQuotes(positionSymbols);

          for (const [symbol, quote] of quotesMap) {
            if (quote) {
              symbolInfoMap.set(symbol, {
                name: quote.name ?? null,
                price: quote.price ?? null,
              });
            }
          }
        } catch (error) {
          logger.warn(`[账户显示] 获取持仓行情失败: ${formatError(error)}`);
        }
      }

      // 计算总资产用于计算仓位百分比
      const totalAssets = account?.netAssets ?? 0;

      positions.forEach((pos) => {
        const normalizedPosSymbol = normalizeHKSymbol(pos.symbol);
        const symbolInfo = symbolInfoMap.get(normalizedPosSymbol);

        // 优先使用从行情 API 获取的中文名称，否则使用持仓数据中的名称，最后使用 "-"
        const nameText = symbolInfo?.name ?? pos.symbolName ?? '-';
        const codeText = normalizeHKSymbol(pos.symbol);

        // 获取当前价格（仅使用实时价格）
        const currentPrice = symbolInfo?.price ?? null;

        // 计算持仓市值（无实时价格时显示 0）
        const posQuantity = Number(pos.quantity) || 0;
        const marketValue =
          currentPrice !== null && isValidPositiveNumber(currentPrice) && isValidPositiveNumber(posQuantity)
            ? posQuantity * currentPrice
            : 0;

        // 计算仓位百分比
        const positionPercent =
          isValidPositiveNumber(totalAssets) && isValidPositiveNumber(marketValue)
            ? (marketValue / totalAssets) * 100
            : 0;

        // 构建价格显示文本（无实时价格时显示 N/A）
        const priceText = currentPrice === null
          ? '现价=N/A'
          : `现价=${formatNumber(currentPrice, 3)}`;

        // 格式化账户渠道显示名称
        const channelDisplay = formatAccountChannel(pos.accountChannel);

        logger.info(
          `- [${channelDisplay}] ${nameText}(${codeText}) 持仓=${formatNumber(
            pos.quantity,
            2,
          )} 可用=${formatNumber(
            pos.availableQuantity,
            2,
          )} ${priceText} 市值=${formatNumber(
            marketValue,
            2,
          )} 仓位=${formatNumber(positionPercent, 2)}% ${pos.currency ?? ''}`,
        );
      });
    } else {
      logger.info('当前无股票持仓。');
    }
  } catch (err) {
    logger.warn(
      '获取账户和持仓信息失败',
      formatError(err),
    );
  }
}
