import type { Market } from 'longport';

/**
 * 持仓信息
 * 表示某个标的的持仓状态
 *
 * @remarks 此类型需要可变以支持对象池的对象重用。对象池使用 PoolablePosition 类型。
 */
export type Position = {
  /** 账户渠道 */
  accountChannel: string;
  /** 标的代码 */
  symbol: string;
  /** 标的名称 */
  symbolName: string;
  /** 持仓数量 */
  quantity: number;
  /** 可用数量（可卖出） */
  availableQuantity: number;
  /** 币种 */
  currency: string;
  /** 成本价 */
  costPrice: number;
  /** 市场（LongPort 返回值） */
  market: Market | string;
};

/**
 * 现金详情
 * 对应 LongPort API accountBalance 返回的 cash_infos 数组元素
 */
export type CashInfo = {
  /** 币种（如 HKD、USD） */
  readonly currency: string;
  /** 可用现金 */
  readonly availableCash: number;
  /** 可提现金额 */
  readonly withdrawCash: number;
  /** 冻结资金 */
  readonly frozenCash: number;
  /** 待交收资金 */
  readonly settlingCash: number;
};

/**
 * 账户快照。
 * 类型用途：表示某一时刻的账户资产状态（现金、净资产、购买力等），用于 getAccountSnapshot 返回值、RiskCheckContext、门禁等。
 * 数据来源：LongPort 账户 API。
 * 使用范围：Trader、RiskChecker、LastState、主循环等；全项目可引用。
 */
export type AccountSnapshot = {
  /** 结算币种 */
  readonly currency: string;
  /** 总现金 */
  readonly totalCash: number;
  /** 净资产 */
  readonly netAssets: number;
  /** 持仓市值 */
  readonly positionValue: number;
  /** 各币种现金详情 */
  readonly cashInfos: ReadonlyArray<CashInfo>;
  /** 购买力 */
  readonly buyPower: number;
};
