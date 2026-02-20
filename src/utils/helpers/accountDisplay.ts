import { logger } from '../logger/index.js';
import { formatError, formatAccountChannel, formatNumber, isValidPositiveNumber } from './index.js';

import type { LastState } from '../../types/state.js';
import type { Quote } from '../../types/quote.js';
import type { Trader } from '../../types/services.js';

/**
 * 刷新账户与持仓缓存（仅数据拉取，不做行情订阅）。默认行为：仅当 lastState.cachedAccount 为空时调用
 * trader.getAccountSnapshot 与 getStockPositions，否则直接使用已有缓存；成功后更新 lastState 的
 * cachedAccount、cachedPositions 与 positionCache，失败时仅打日志不抛错。
 *
 * @param trader Trader 实例，用于拉取账户与持仓
 * @param lastState 状态对象，用于读取/更新缓存（cachedAccount、cachedPositions、positionCache）
 * @returns Promise<void>，无返回值；拉取失败时不抛错
 */
export async function refreshAccountAndPositions(
  trader: Trader,
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
        trader.getAccountSnapshot().catch((err: unknown) => {
          logger.warn('获取账户信息失败', formatError(err));
          return null;
        }),
        trader.getStockPositions().catch((err: unknown) => {
          logger.warn('获取股票仓位失败', formatError(err));
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
  } catch (err) {
    logger.warn('获取账户和持仓信息失败', formatError(err));
  }
}

/**
 * 将 lastState 中的账户与持仓缓存输出到日志。默认行为：依赖 lastState 缓存，不主动拉取；quotesMap 可选，用于持仓现价与名称展示。
 *
 * @param options.lastState 状态对象，用于读取 cachedAccount、cachedPositions
 * @param options.quotesMap 行情 Map（可选），用于持仓现价与名称
 * @returns Promise<void>，无返回值；异常时仅打日志不抛错
 */
export async function displayAccountAndPositions({
  lastState,
  quotesMap,
}: {
  readonly lastState: LastState;
  readonly quotesMap?: ReadonlyMap<string, Quote | null> | null;
}): Promise<void> {
  try {
    const account = lastState.cachedAccount;
    const positions = lastState.cachedPositions;

    if (account) {
      logger.info(
        `账户概览 [${account.currency}] 余额=${account.totalCash.toFixed(2)} 市值=${account.netAssets.toFixed(
          2,
        )} 持仓市值≈${account.positionValue.toFixed(2)}`,
      );
    }

    if (Array.isArray(positions) && positions.length > 0) {
      logger.info('股票持仓：');

      const symbolInfoMap = new Map<string, { name: string | null; price: number | null }>();
      if (quotesMap) {
        for (const pos of positions) {
          const quote = quotesMap.get(pos.symbol) ?? null;
          if (quote) {
            symbolInfoMap.set(pos.symbol, {
              name: quote.name ?? null,
              price: quote.price ?? null,
            });
          }
        }
      }

      const totalAssets = account?.netAssets ?? 0;

      positions.forEach((pos) => {
        const symbolInfo = symbolInfoMap.get(pos.symbol);
        const nameText = symbolInfo?.name ?? pos.symbolName ?? '-';
        const codeText = pos.symbol;
        const currentPrice = symbolInfo?.price ?? null;

        const posQuantity = Number(pos.quantity) || 0;
        const marketValue =
          currentPrice !== null &&
          isValidPositiveNumber(currentPrice) &&
          isValidPositiveNumber(posQuantity)
            ? posQuantity * currentPrice
            : 0;

        const positionPercent =
          isValidPositiveNumber(totalAssets) && isValidPositiveNumber(marketValue)
            ? (marketValue / totalAssets) * 100
            : 0;

        const priceText =
          currentPrice === null ? '现价=N/A' : `现价=${formatNumber(currentPrice, 3)}`;

        const channelDisplay = formatAccountChannel(pos.accountChannel);

        logger.info(
          `- [${channelDisplay}] ${nameText}(${codeText}) 持仓=${formatNumber(pos.quantity, 2)} 可用=${formatNumber(
            pos.availableQuantity,
            2,
          )} ${priceText} 市值=${formatNumber(marketValue, 2)} 仓位=${formatNumber(positionPercent, 2)}% ${pos.currency ?? ''}`,
        );
      });
    } else {
      logger.info('当前无股票持仓。');
    }
  } catch (err) {
    logger.warn('获取账户和持仓信息失败', formatError(err));
  }
}
