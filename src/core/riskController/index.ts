/**
 * 风险控制模块（门面模式）
 *
 * 协调三个子检查器，提供统一的风险检查接口：
 * - warrantRiskChecker: 牛熊证距离回收价检查
 * - positionLimitChecker: 单标的持仓市值限制
 * - unrealizedLossChecker: 单标的浮亏监控
 *
 * 风险阈值（均为配置项）：
 * - 牛证距离回收价 > 0.5%，熊证 < -0.5%，牛熊证当前价 > 0.015
 * - 单标的市值 ≤ maxPositionNotional
 * - 买入风控阈值：maxDailyLoss（浮亏超过阈值则拒绝买入）
 * - 保护性清仓阈值：maxUnrealizedLossPerSymbol
 */
import { isBuyAction, isValidPositiveNumber } from '../../utils/helpers/index.js';
import { logger } from '../../utils/logger/index.js';
import type {
  Position,
  Signal,
  AccountSnapshot,
  MarketDataClient,
  OrderRecorder,
  Quote,
  RiskCheckResult,
  UnrealizedLossCheckResult,
  WarrantRefreshResult,
  RiskChecker,
  SignalType,
} from '../../types/index.js';
import type {
  RiskCheckerDeps,
} from './types.js';
import { createWarrantRiskChecker } from './warrantRiskChecker.js';
import { createPositionLimitChecker } from './positionLimitChecker.js';
import { createUnrealizedLossChecker } from './unrealizedLossChecker.js';

/** 创建风险检查器（门面模式） */
export function createRiskChecker(deps: RiskCheckerDeps = {}): RiskChecker {
  const options = deps.options ?? {};
  let maxDailyLoss = options.maxDailyLoss ?? 0;

  // 验证 maxDailyLoss 的有效性
  if (!Number.isFinite(maxDailyLoss) || maxDailyLoss < 0) {
    logger.warn(
      `[风险检查警告] maxDailyLoss 配置无效（${maxDailyLoss}），将使用默认值 0（禁止任何浮亏）`,
    );
    maxDailyLoss = 0;
  }

  // 初始化各个子模块
  const warrantRiskChecker = createWarrantRiskChecker();
  const positionLimitChecker = createPositionLimitChecker({
    maxPositionNotional: options.maxPositionNotional ?? null,
  });
  const unrealizedLossChecker = createUnrealizedLossChecker({
    maxUnrealizedLossPerSymbol: options.maxUnrealizedLossPerSymbol ?? null,
  });

  /** 检查单个标的的浮亏，返回 null 表示通过 */
  function checkUnrealizedLossForSymbol(
    symbol: string | null,
    currentPrice: number | null,
    directionName: string,
  ): RiskCheckResult | null {
    if (!symbol) {
      return null;
    }

    const lossData = unrealizedLossChecker.getUnrealizedLossData(symbol);
    if (!lossData) {
      return null;
    }

    const { r1, n1 } = lossData;
    if (n1 <= 0 && r1 === 0) {
      return null;
    }

    // 仅在有持仓数量时要求有效价格；n1<=0 时允许 R2=0
    let r2 = 0;
    if (n1 > 0) {
      if (currentPrice === null || !isValidPositiveNumber(currentPrice)) {
        return null;
      }
      r2 = currentPrice * n1;
    }

    // 计算当前持仓市值R2和浮亏X
    const unrealizedPnL = r2 - r1;

    // 记录浮亏计算详情（仅在DEBUG模式下）
    if (process.env['DEBUG'] === 'true') {
      logger.debug(
        `[风险检查调试] ${directionName}浮亏检查: R1(开仓成本)=${r1.toFixed(
          2,
        )}, R2(当前市值)=${r2.toFixed(
          2,
        )}, 浮亏=${unrealizedPnL.toFixed(2)} HKD，最大允许亏损=${
          maxDailyLoss
        } HKD`,
      );
    }

    // 如果浮亏计算结果不是有限数字，拒绝买入操作（安全策略）
    if (!Number.isFinite(unrealizedPnL)) {
      logger.error(
        `[风险检查错误] ${directionName}持仓浮亏计算结果无效：${unrealizedPnL}`,
      );
      return {
        allowed: false,
        reason: `${directionName}持仓浮亏计算结果无效（${unrealizedPnL}），无法进行风险检查，禁止买入${directionName}`,
      };
    }

    // 检查持仓浮亏是否超过最大允许亏损
    if (unrealizedPnL <= -maxDailyLoss) {
      return {
        allowed: false,
        reason: `${directionName}持仓浮亏约 ${unrealizedPnL.toFixed(
          2,
        )} HKD 已超过单日最大亏损限制 ${
          maxDailyLoss
        } HKD，禁止买入${directionName}（R1=${r1.toFixed(2)}, R2=${r2.toFixed(
          2,
        )}, N1=${n1}）`,
      };
    }

    return null; // 检查通过
  }

  /** 检查买入前的浮亏（仅检查信号对应方向的标的） */
  function checkUnrealizedLossBeforeBuy(
    signal: Signal,
    longCurrentPrice: number | null,
    shortCurrentPrice: number | null,
  ): RiskCheckResult {
    // 判断当前信号是做多还是做空，并确定对应的符号和价格
    const isBuyCall = signal.action === 'BUYCALL';
    const isBuyPut = signal.action === 'BUYPUT';

    if (!isBuyCall && !isBuyPut) {
      return { allowed: true };
    }

    // 使用信号中的符号来确定要检查的标的
    const signalSymbol = signal.symbol;
    const directionName = isBuyCall ? '做多标的' : '做空标的';
    const currentPrice = isBuyCall ? longCurrentPrice : shortCurrentPrice;

    const result = checkUnrealizedLossForSymbol(
      signalSymbol,
      currentPrice,
      directionName,
    );
    if (result) {
      return result;
    }

    return { allowed: true };
  }

  /** 订单前综合风险检查：账户、浮亏、持仓限制 */
  function checkBeforeOrder(
    account: AccountSnapshot | null,
    positions: ReadonlyArray<Position> | null,
    signal: Signal | null,
    orderNotional: number,
    currentPrice: number | null = null,
    longCurrentPrice: number | null = null,
    shortCurrentPrice: number | null = null,
  ): RiskCheckResult {
    // HOLD 信号不需要检查
    if (!signal || signal.action === 'HOLD') {
      return { allowed: true };
    }

    // 判断是否为买入操作
    const isBuy = isBuyAction(signal.action);

    // 对于买入操作，账户数据是必需的（用于浮亏检查）
    if (isBuy && !account) {
      return {
        allowed: false,
        reason: '账户数据不可用，无法进行风险检查，禁止买入操作',
      };
    }

    // 对于卖出操作，如果没有账户数据，允许继续（卖出操作不检查浮亏）
    if (!account) {
      return { allowed: true };
    }

    const { netAssets, totalCash } = account;

    // 验证账户数据有效性
    if (!Number.isFinite(netAssets) || !Number.isFinite(totalCash)) {
      // 对于买入操作，账户数据无效必须拒绝
      if (isBuy) {
        return {
          allowed: false,
          reason: `账户数据无效（netAssets=${netAssets}, totalCash=${totalCash}），无法进行风险检查，禁止买入操作`,
        };
      }
      // 对于卖出操作，账户数据无效时允许继续
      return { allowed: true };
    }

    // 对于买入操作，检查港币可用现金是否足够
    if (isBuy) {
      const hkdCashInfo = account.cashInfos?.find((c) => c.currency === 'HKD');
      const availableCash = hkdCashInfo?.availableCash ?? 0;

      if (availableCash < orderNotional) {
        return {
          allowed: false,
          reason: `港币可用现金 ${availableCash.toFixed(2)} HKD 不足以支付买入金额 ${orderNotional.toFixed(2)} HKD`,
        };
      }
    }

    // 当日浮亏超过 maxDailyLoss 时，停止开新仓（仅对买入操作检查）
    if (isBuy) {
      const unrealizedLossResult = checkUnrealizedLossBeforeBuy(
        signal,
        longCurrentPrice,
        shortCurrentPrice,
      );
      if (!unrealizedLossResult.allowed) {
        return unrealizedLossResult;
      }
    }

    // 检查单标的最大持仓市值限制
    if (
      signal.action === 'BUYCALL' ||
      signal.action === 'SELLCALL' ||
      signal.action === 'BUYPUT' ||
      signal.action === 'SELLPUT'
    ) {
      const positionCheckResult = positionLimitChecker.checkLimit(
        signal,
        positions,
        orderNotional,
        currentPrice,
      );
      if (!positionCheckResult.allowed) {
        return positionCheckResult;
      }
    }

    return { allowed: true };
  }

  return {
    setWarrantInfoFromCallPrice(
      symbol: string,
      callPrice: number,
      isLongSymbol: boolean,
      symbolName: string | null = null,
    ) {
      return warrantRiskChecker.setWarrantInfoFromCallPrice(
        symbol,
        callPrice,
        isLongSymbol,
        symbolName,
      );
    },

    async refreshWarrantInfoForSymbol(
      marketDataClient: MarketDataClient,
      symbol: string,
      isLongSymbol: boolean,
      symbolName: string | null = null,
    ): Promise<WarrantRefreshResult> {
      return warrantRiskChecker.refreshWarrantInfoForSymbol(
        marketDataClient,
        symbol,
        isLongSymbol,
        symbolName,
      );
    },

    checkBeforeOrder,

    checkWarrantRisk(
      symbol: string,
      signalType: SignalType,
      monitorCurrentPrice: number,
      warrantCurrentPrice: number | null,
    ): RiskCheckResult {
      return warrantRiskChecker.checkRisk(
        symbol,
        signalType,
        monitorCurrentPrice,
        warrantCurrentPrice,
      );
    },

    checkWarrantDistanceLiquidation(
      symbol: string,
      isLongSymbol: boolean,
      monitorCurrentPrice: number,
    ) {
      return warrantRiskChecker.checkWarrantDistanceLiquidation(
        symbol,
        isLongSymbol,
        monitorCurrentPrice,
      );
    },

    getWarrantDistanceInfo(
      isLongSymbol: boolean,
      seatSymbol: string,
      monitorCurrentPrice: number | null,
    ) {
      return warrantRiskChecker.getWarrantDistanceInfo(
        isLongSymbol,
        seatSymbol,
        monitorCurrentPrice,
      );
    },
    clearLongWarrantInfo(): void {
      warrantRiskChecker.clearLongWarrantInfo();
    },
    clearShortWarrantInfo(): void {
      warrantRiskChecker.clearShortWarrantInfo();
    },

    async refreshUnrealizedLossData(
      orderRecorder: OrderRecorder,
      symbol: string,
      isLongSymbol: boolean,
      quote?: Quote | null,
      dailyLossOffset?: number,
    ): Promise<{ r1: number; n1: number } | null> {
      return unrealizedLossChecker.refresh(
        orderRecorder,
        symbol,
        isLongSymbol,
        quote,
        dailyLossOffset,
      );
    },

    checkUnrealizedLoss(
      symbol: string,
      currentPrice: number,
      isLongSymbol: boolean,
    ): UnrealizedLossCheckResult {
      return unrealizedLossChecker.check(symbol, currentPrice, isLongSymbol);
    },
  };
}

