/**
 * 自动寻标入口：从行情服务筛选合适的牛熊证。
 */
import { SortOrderType, WarrantSortBy, WarrantStatus, WarrantType } from 'longport';
import { formatError } from '../../utils/helpers/index.js';
import { buildExpiryDateFilters, selectBestWarrant } from './utils.js';
import type { FindBestWarrantInput, WarrantCandidate } from './types.js';

/**
 * 获取并筛选最佳牛熊证标的。
 */
export async function findBestWarrant({
  ctx,
  monitorSymbol,
  isBull,
  tradingMinutes,
  minPrice,
  minTurnoverPerMinute,
  expiryMinMonths,
  logger,
}: FindBestWarrantInput): Promise<WarrantCandidate | null> {
  try {
    const warrantType = isBull ? WarrantType.Bull : WarrantType.Bear;
    const expiryFilters = [...buildExpiryDateFilters(expiryMinMonths)];

    const warrants = await ctx.warrantList(
      monitorSymbol,
      WarrantSortBy.Turnover,
      SortOrderType.Descending,
      [warrantType],
      null,
      expiryFilters,
      null,
      [WarrantStatus.Normal],
    );

    const best = selectBestWarrant({
      warrants,
      tradingMinutes,
      minPrice,
      minTurnoverPerMinute,
    });

    if (!best) {
      logger.warn(
        `[自动寻标] 未找到符合条件的${isBull ? '牛' : '熊'}证：${monitorSymbol}`,
      );
    }

    return best;
  } catch (error) {
    logger.warn(
      `[自动寻标] warrantList 获取失败：${monitorSymbol}(${isBull ? '牛' : '熊'})`,
      formatError(error),
    );
    return null;
  }
}
