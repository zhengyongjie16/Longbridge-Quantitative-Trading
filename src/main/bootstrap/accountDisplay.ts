/**
 * 账户与持仓展示模块
 *
 * 职责：
 * - 使用缓存账户与持仓输出统一展示日志
 * - 基于可选行情补充持仓现价、市值与仓位信息
 */
import { logger as appLogger } from '../../utils/logger/index.js';
import { formatError } from '../../utils/error/index.js';
import { formatAccountChannel, formatNumber } from '../../utils/utils.js';
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import type { DisplayAccountAndPositionsParams } from './types.js';

/**
 * 将 lastState 中的账户与持仓缓存输出到日志。
 * 默认行为：依赖 lastState 缓存，不主动拉取；quotesMap 可选，用于持仓现价与名称展示。
 *
 * @param params 展示参数，包含 lastState 与可选 quotesMap
 * @returns Promise<void>，无返回值；异常时仅打日志不抛错
 */
export function displayAccountAndPositions({
  lastState,
  quotesMap,
}: DisplayAccountAndPositionsParams): Promise<void> {
  try {
    const account = lastState.cachedAccount;
    const positions = lastState.cachedPositions;

    if (account) {
      appLogger.info(
        `账户概览 [${account.currency}] 余额=${account.totalCash.toFixed(2)} 市值=${account.netAssets.toFixed(
          2,
        )} 持仓市值≈${account.positionValue.toFixed(2)}`,
      );
    }

    if (positions.length > 0) {
      appLogger.info('股票持仓：');

      const symbolInfoMap = new Map<string, { name: string | null; price: number | null }>();
      if (quotesMap) {
        for (const position of positions) {
          const quote = quotesMap.get(position.symbol) ?? null;
          if (quote) {
            symbolInfoMap.set(position.symbol, {
              name: quote.name ?? null,
              price: quote.price,
            });
          }
        }
      }

      const totalAssets = account?.netAssets ?? 0;

      for (const position of positions) {
        const symbolInfo = symbolInfoMap.get(position.symbol);
        const nameText = symbolInfo?.name ?? position.symbolName;
        const codeText = position.symbol;
        const currentPrice = symbolInfo?.price ?? null;

        const positionQuantity = position.quantity || 0;
        const marketValue =
          currentPrice !== null &&
          isValidPositiveNumber(currentPrice) &&
          isValidPositiveNumber(positionQuantity)
            ? positionQuantity * currentPrice
            : 0;

        const positionPercent =
          isValidPositiveNumber(totalAssets) && isValidPositiveNumber(marketValue)
            ? (marketValue / totalAssets) * 100
            : 0;

        const priceText =
          currentPrice === null ? '现价=N/A' : `现价=${formatNumber(currentPrice, 3)}`;

        const channelDisplay = formatAccountChannel(position.accountChannel);
        const displayName = nameText;
        const displayCode = codeText;
        const quantityText = formatNumber(position.quantity, 2);
        const availableText = formatNumber(position.availableQuantity, 2);
        const marketValueText = formatNumber(marketValue, 2);
        const positionPercentText = formatNumber(positionPercent, 2);
        const currencyText = position.currency;

        appLogger.info(
          `- [${channelDisplay}] ${displayName}(${displayCode}) 持仓=${quantityText} 可用=${availableText} ${priceText} 市值=${marketValueText} 仓位=${positionPercentText}% ${currencyText}`,
        );
      }
    } else {
      appLogger.info('当前无股票持仓。');
    }
  } catch (err) {
    appLogger.warn('获取账户和持仓信息失败', formatError(err));
  }
  return Promise.resolve();
}
