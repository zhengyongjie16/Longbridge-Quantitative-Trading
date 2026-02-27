import { ACCOUNT_CHANNEL_MAP } from '../../constants/index.js';
import { formatError, isValidPositiveNumber } from './index.js';
import { logger } from '../logger/index.js';
import type { LastState } from '../../types/state.js';
import type { Quote } from '../../types/quote.js';

/**
 * 将 lastState 中的账户与持仓缓存输出到日志。默认行为：依赖 lastState 缓存，不主动拉取；quotesMap 可选，用于持仓现价与名称展示。
 *
 * @param options.lastState 状态对象，用于读取 cachedAccount、cachedPositions
 * @param options.quotesMap 行情 Map（可选），用于持仓现价与名称
 * @returns Promise<void>，无返回值；异常时仅打日志不抛错
 */
export function displayAccountAndPositions({
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

    if (positions.length > 0) {
      logger.info('股票持仓：');

      const symbolInfoMap = new Map<string, { name: string | null; price: number | null }>();
      if (quotesMap) {
        for (const pos of positions) {
          const quote = quotesMap.get(pos.symbol) ?? null;
          if (quote) {
            symbolInfoMap.set(pos.symbol, {
              name: quote.name ?? null,
              price: quote.price,
            });
          }
        }
      }

      const totalAssets = account?.netAssets ?? 0;

      for (const pos of positions) {
        const symbolInfo = symbolInfoMap.get(pos.symbol);
        const nameText = symbolInfo?.name ?? pos.symbolName;
        const codeText = pos.symbol;
        const currentPrice = symbolInfo?.price ?? null;

        const posQuantity = pos.quantity || 0;
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
        const displayName = nameText;
        const displayCode = codeText;
        const quantityText = formatNumber(pos.quantity, 2);
        const availableText = formatNumber(pos.availableQuantity, 2);
        const marketValueText = formatNumber(marketValue, 2);
        const positionPercentText = formatNumber(positionPercent, 2);
        const currencyText = pos.currency;

        logger.info(
          `- [${channelDisplay}] ${displayName}(${displayCode}) 持仓=${quantityText} 可用=${availableText} ${priceText} 市值=${marketValueText} 仓位=${positionPercentText}% ${currencyText}`,
        );
      }
    } else {
      logger.info('当前无股票持仓。');
    }
  } catch (err) {
    logger.warn('获取账户和持仓信息失败', formatError(err));
  }
  return Promise.resolve();
}

/**
 * 格式化数字，保留指定小数位数。默认行为：num 为 null/undefined 或非有限数时返回 "-"；digits 默认为 2。
 *
 * @param num 要格式化的数字
 * @param digits 保留的小数位数，默认 2
 * @returns 格式化后的字符串，无效时返回 "-"
 */
function formatNumber(num: number | null | undefined, digits: number = 2): string {
  if (num === null || num === undefined) {
    return '-';
  }
  return Number.isFinite(num) ? num.toFixed(digits) : String(num);
}

/**
 * 格式化账户渠道显示名称。默认行为：accountChannel 为空或非字符串时返回「未知账户」。
 *
 * @param accountChannel 账户渠道代码
 * @returns 映射后的显示名称，无效时返回「未知账户」
 */
function formatAccountChannel(accountChannel: string | null | undefined): string {
  if (!accountChannel || typeof accountChannel !== 'string') {
    return '未知账户';
  }
  const key = accountChannel.toLowerCase();
  return ACCOUNT_CHANNEL_MAP[key] ?? accountChannel;
}
