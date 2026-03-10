import type { LastState } from '../../types/state.js';
import type { Quote } from '../../types/quote.js';

/**
 * 账户与持仓展示函数入参。
 * 类型用途：作为 displayAccountAndPositions 的对象参数类型，避免调用方重复内联定义。
 * 数据来源：由启动重建与成交后刷新链路组装传入。
 * 使用范围：accountDisplay 服务及其调用方使用。
 */
export type DisplayAccountAndPositionsParams = Readonly<{
  lastState: LastState;
  quotesMap?: ReadonlyMap<string, Quote | null> | null;
}>;

/**
 * 持仓展示所需的可选行情信息。
 * 类型用途：缓存单个持仓标的的展示名称与最新价格，避免调用方重复内联对象类型。
 * 数据来源：由 displayAccountAndPositions 从 quotesMap 中提取。
 * 使用范围：仅 accountDisplay 服务内部使用。
 */
export type SymbolDisplayInfo = Readonly<{
  name: string | null;
  price: number | null;
}>;
