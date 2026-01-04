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

import { logger } from './logger.js';
import {
  formatError,
  normalizeHKSymbol,
  formatAccountChannel,
  formatNumber,
  isDefined,
  isValidPositiveNumber,
} from './helpers.js';

import type { AccountSnapshot, Position, Quote } from '../types/index.js';

/**
 * Trader 接口定义
 */
interface Trader {
  getAccountSnapshot(): Promise<AccountSnapshot | null>;
  getStockPositions(): Promise<Position[]>;
}

/**
 * MarketDataClient 接口定义
 */
interface MarketDataClient {
  getLatestQuote(symbol: string): Promise<Quote | null>;
}

/**
 * 状态对象接口
 */
interface LastState {
  cachedAccount: AccountSnapshot | null;
  cachedPositions: Position[];
}

/**
 * 显示账户和持仓信息（仅在交易后调用）
 * @param trader Trader实例
 * @param marketDataClient MarketDataClient实例
 * @param lastState 状态对象，用于更新缓存
 */
export async function displayAccountAndPositions(
  trader: Trader,
  marketDataClient: MarketDataClient,
  lastState: LastState,
): Promise<void> {
  try {
    // 并行获取账户信息和持仓信息，减少等待时间
    const [account, positions] = await Promise.all([
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

    // 更新缓存
    lastState.cachedAccount = account;
    lastState.cachedPositions = positions;

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
        // 使用 getLatestQuote 获取每个标的的完整信息（包含 staticInfo 和中文名称）
        const quotePromises = positionSymbols.map((symbol) =>
          marketDataClient.getLatestQuote(symbol).catch((err: Error) => {
            logger.warn(
              `[持仓监控] 获取标的 ${symbol} 信息失败: ${
                formatError(err)
              }`,
            );
            return null;
          }),
        );
        const quotes = await Promise.all(quotePromises);

        quotes.forEach((quote) => {
          if (quote?.symbol) {
            const normalizedSymbol = normalizeHKSymbol(quote.symbol);
            symbolInfoMap.set(normalizedSymbol, {
              name: quote.name ?? null,
              price: quote.price ?? null,
            });
          }
        });
      }

      // 计算总资产用于计算仓位百分比
      const totalAssets = account?.netAssets ?? 0;

      positions.forEach((pos) => {
        const normalizedPosSymbol = normalizeHKSymbol(pos.symbol);
        const symbolInfo = symbolInfoMap.get(normalizedPosSymbol);

        // 优先使用从行情 API 获取的中文名称，否则使用持仓数据中的名称，最后使用 "-"
        const nameText = symbolInfo?.name ?? pos.symbolName ?? '-';
        const codeText = normalizeHKSymbol(pos.symbol);

        // 获取当前价格（优先使用实时价格，否则使用成本价）
        const currentPrice = symbolInfo?.price ?? pos.costPrice ?? 0;

        // 计算持仓市值
        const posQuantity = Number(pos.quantity) || 0;
        const marketValue =
          isValidPositiveNumber(currentPrice) && isValidPositiveNumber(posQuantity)
            ? posQuantity * currentPrice
            : 0;

        // 计算仓位百分比
        const positionPercent =
          isValidPositiveNumber(totalAssets) && isValidPositiveNumber(marketValue)
            ? (marketValue / totalAssets) * 100
            : 0;

        // 构建价格显示文本
        const priceText = isDefined(symbolInfo?.price)
          ? `现价=${formatNumber(currentPrice, 3)}`
          : `成本价=${formatNumber(pos.costPrice, 3)}`;

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
