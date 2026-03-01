/**
 * 账户服务模块
 *
 * 职责：
 * - 查询账户余额、净资产、购买力等财务信息
 * - 查询股票持仓（支持按标的过滤）
 *
 * 依赖：ctxPromise（Trade API 上下文）、rateLimiter（频率限制）
 */
import { decimalToNumber } from '../../utils/helpers/index.js';
import type { AccountSnapshot, Position, CashInfo } from '../../types/account.js';
import type { AccountService, AccountServiceDeps } from './types.js';

/**
 * 创建账户服务
 * @param deps 依赖注入
 * @returns AccountService 接口实例
 */
export const createAccountService = (deps: AccountServiceDeps): AccountService => {
  const { ctxPromise, rateLimiter } = deps;

  /**
   * 获取账户快照（余额、资产等）
   */
  const getAccountSnapshot = async (): Promise<AccountSnapshot | null> => {
    const ctx = await ctxPromise;
    await rateLimiter.throttle();
    const balances = await ctx.accountBalance();
    const primary = balances[0];
    if (!primary) {
      return null;
    }

    const totalCash = decimalToNumber(primary.totalCash);
    const netAssets = decimalToNumber(primary.netAssets);
    const positionValue = netAssets - totalCash;

    // 解析现金详情（用于获取各币种可用现金）
    const cashInfos: CashInfo[] = primary.cashInfos.map((info) => ({
      currency: info.currency,
      availableCash: decimalToNumber(info.availableCash),
      withdrawCash: decimalToNumber(info.withdrawCash),
      frozenCash: decimalToNumber(info.frozenCash),
      settlingCash: decimalToNumber(info.settlingCash),
    }));

    return {
      currency: primary.currency,
      totalCash,
      netAssets,
      positionValue,
      cashInfos,
      buyPower: decimalToNumber(primary.buyPower),
    };
  };

  /**
   * 获取股票持仓
   * @param symbols 标的代码数组，如果为null则获取所有持仓
   */
  const getStockPositions = async (symbols: string[] | null = null): Promise<Position[]> => {
    const ctx = await ctxPromise;
    await rateLimiter.throttle();

    // stockPositions 接受 Array<string> | undefined | null，直接传递即可
    const resp = await ctx.stockPositions(symbols ?? undefined);
    const channels = resp.channels;
    if (channels.length === 0) {
      return [];
    }

    return channels.flatMap((channel) =>
      channel.positions.map((pos) => ({
        accountChannel: channel.accountChannel,
        symbol: pos.symbol,
        symbolName: pos.symbolName,
        quantity: decimalToNumber(pos.quantity),
        availableQuantity: decimalToNumber(pos.availableQuantity),
        currency: pos.currency,
        costPrice: decimalToNumber(pos.costPrice),
        market: pos.market,
      })),
    );
  };

  return {
    getAccountSnapshot,
    getStockPositions,
  };
};
