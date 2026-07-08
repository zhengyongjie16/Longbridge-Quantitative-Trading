import type { Market } from 'longbridge';

/**
 * 持仓信息。
 * 类型用途：表示某标的的持仓状态，作为 getStockPositions 返回元素、持仓缓存、风控与卖出逻辑的入参/数据源。
 * 数据来源：Longbridge 账户 API（getStockPositions）。
 * 使用范围：Trader、RiskChecker、持仓缓存、运行期状态等；全项目可引用。
 */
export type Position = {
  /** 账户渠道 */
  readonly accountChannel: string;

  /** 标的代码 */
  readonly symbol: string;

  /** 标的名称 */
  readonly symbolName: string;

  /** 持仓数量 */
  readonly quantity: number;

  /** 可用数量（可卖出） */
  readonly availableQuantity: number;

  /** 币种 */
  readonly currency: string;

  /** 成本价 */
  readonly costPrice: number;

  /** 市场（Longbridge 返回值） */
  readonly market: Market | string;
};

/**
 * 现金详情。
 * 类型用途：表示单币种现金状态，作为 AccountSnapshot.cashInfos 数组元素类型。
 * 数据来源：Longbridge 账户 API（accountBalance 返回的 cash_infos 数组元素）。
 * 使用范围：AccountSnapshot、账户展示等；全项目可引用。
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
 * 数据来源：Longbridge 账户 API。
 * 使用范围：Trader、RiskChecker、LastState、运行期状态等；全项目可引用。
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
