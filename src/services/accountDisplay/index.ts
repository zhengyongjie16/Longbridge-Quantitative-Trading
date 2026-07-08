/**
 * 账户与持仓展示服务模块
 *
 * 职责：
 * - 使用缓存账户与持仓输出统一展示日志
 * - 基于可选行情补充持仓现价、市值与仓位信息
 */
import { ACCOUNT_CHANNEL_MAP } from '../../constants/index.js';
import { logger } from '../../utils/logger/index.js';
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import type { DisplayAccountAndPositionsParams, SymbolDisplayInfo } from './types.js';

function formatNumber(num: number | null | undefined, digits: number = 2): string {
  if (num === null || num === undefined) {
    return '-';
  }

  return Number.isFinite(num) ? num.toFixed(digits) : String(num);
}

function formatAccountChannel(accountChannel: string | null | undefined): string {
  if (!accountChannel || typeof accountChannel !== 'string') {
    return '未知账户';
  }

  const key = accountChannel.toLowerCase();
  return ACCOUNT_CHANNEL_MAP[key] ?? accountChannel;
}

/**
 * 将 lastState 中的账户与持仓缓存输出到日志。
 * 默认行为：依赖 lastState 缓存，不主动拉取；quotesMap 可选，用于持仓现价与名称展示。
 *
 * @param params 展示参数，包含 lastState 与可选 quotesMap
 */
export function displayAccountAndPositions({
  lastState,
  quotesMap,
}: DisplayAccountAndPositionsParams): void {
  const account = lastState.cachedAccount;
  const positions = lastState.cachedPositions;

  if (account) {
    logger.info(
      `账户概览 [${account.currency}] 余额=${account.totalCash.toFixed(2)} 市值=${account.netAssets.toFixed(
        2,
      )} 持仓市值≈${account.positionValue.toFixed(2)}`,
    );
  }

  if (positions.length > 0) {
    logger.info('股票持仓：');

    const symbolInfoMap = new Map<string, SymbolDisplayInfo>();
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
      const quantityText = formatNumber(position.quantity, 2);
      const availableText = formatNumber(position.availableQuantity, 2);
      const marketValueText = formatNumber(marketValue, 2);
      const positionPercentText = formatNumber(positionPercent, 2);

      logger.info(
        `- [${channelDisplay}] ${nameText}(${codeText}) 持仓=${quantityText} 可用=${availableText} ${priceText} 市值=${marketValueText} 仓位=${positionPercentText}% ${position.currency}`,
      );
    }
  } else {
    logger.info('当前无股票持仓。');
  }
}
