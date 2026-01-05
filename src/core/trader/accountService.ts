/**
 * 账户服务模块
 *
 * 功能：
 * - 查询账户余额和资产
 * - 查询股票持仓
 */

import type { TradeContext } from 'longport';
import { decimalToNumber } from '../../utils/helpers.js';
import type { AccountSnapshot, Position } from '../../types/index.js';
import type { RateLimiter } from './rateLimiter.js';

export class AccountService {
  constructor(
    private readonly ctxPromise: Promise<TradeContext>,
    private readonly rateLimiter: RateLimiter,
  ) {}

  /**
   * 获取账户快照（余额、资产等）
   */
  async getAccountSnapshot(): Promise<AccountSnapshot | null> {
    const ctx = await this.ctxPromise;
    await this.rateLimiter.throttle();
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

  /**
   * 获取股票持仓
   * @param symbols 标的代码数组，如果为null则获取所有持仓
   */
  async getStockPositions(symbols: string[] | null = null): Promise<Position[]> {
    const ctx = await this.ctxPromise;
    await this.rateLimiter.throttle();
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
}
