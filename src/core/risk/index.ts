/**
 * 风险控制模块（门面模式）
 *
 * 功能：
 * - 协调各个风险检查子模块
 * - 提供统一的风险检查接口
 * - 实施买入前的风险检查
 * - 监控单日和单标的浮亏
 * - 检查牛熊证距离回收价的安全性
 *
 * 风险检查类型：
 * 1. 牛熊证风险：牛证距离回收价 > 0.5%，熊证 < -0.5%
 * 2. 单日亏损限制：整体浮亏必须 > -MAX_DAILY_LOSS
 * 3. 持仓市值限制：单标的市值必须 ≤ MAX_POSITION_NOTIONAL
 * 4. 单标的安全边际：监控标的价格必须 > 1
 *
 * 浮亏监控：
 * - 实时计算持仓浮亏
 * - 超过阈值时触发保护性清仓
 * - 使用 R1（开仓成本）和 N1（持仓数量）计算
 */

import { TRADING_CONFIG } from '../../config/config.trading.js';
import { normalizeHKSymbol, isBuyAction, isValidPositiveNumber } from '../../utils/helpers/index.js';
import { logger } from '../../utils/logger/index.js';
import type { Position, Signal, AccountSnapshot } from '../../types/index.js';
import type { MarketDataClient } from '../../services/quoteClient/index.js';
import type { OrderRecorder } from '../orderRecorder/index.js';
import type {
  RiskCheckResult,
  UnrealizedLossCheckResult,
  RiskChecker,
  RiskCheckerDeps,
} from './type.js';
import { createWarrantRiskChecker } from './warrantRiskChecker.js';
import { createPositionLimitChecker } from './positionLimitChecker.js';
import { createUnrealizedLossChecker } from './unrealizedLossChecker.js';

/**
 * 创建风险检查器（门面模式）
 * @param deps 依赖注入
 * @returns RiskChecker 接口实例
 */
export const createRiskChecker = (deps: RiskCheckerDeps = {}): RiskChecker => {
  const options = deps.options ?? {};
  let maxDailyLoss = options.maxDailyLoss ?? TRADING_CONFIG.maxDailyLoss ?? 0;

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
    maxPositionNotional: options.maxPositionNotional ?? TRADING_CONFIG.maxPositionNotional,
  });
  const unrealizedLossChecker = createUnrealizedLossChecker({
    maxUnrealizedLossPerSymbol: options.maxUnrealizedLossPerSymbol ?? TRADING_CONFIG.maxUnrealizedLossPerSymbol,
  });

  /**
   * 检查单个标的的浮亏
   */
  const checkUnrealizedLossForSymbol = (
    symbol: string | null,
    currentPrice: number | null,
    directionName: string,
  ): RiskCheckResult | null => {
    if (!symbol) {
      return null;
    }

    const lossData = unrealizedLossChecker.getUnrealizedLossData(symbol);
    if (!lossData || lossData.n1 <= 0) {
      return null;
    }

    const { r1, n1 } = lossData;

    // 验证当前价格有效性
    if (currentPrice === null || !isValidPositiveNumber(currentPrice)) {
      return null;
    }

    // 计算当前持仓市值R2和浮亏X
    const r2 = currentPrice * n1;
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
  };

  /**
   * 检查买入前的浮亏
   */
  const checkUnrealizedLossBeforeBuy = (
    signal: Signal,
    longCurrentPrice: number | null,
    shortCurrentPrice: number | null,
  ): RiskCheckResult => {
    // 获取做多和做空标的的符号
    const longSymbol = TRADING_CONFIG.longSymbol
      ? normalizeHKSymbol(TRADING_CONFIG.longSymbol)
      : null;
    const shortSymbol = TRADING_CONFIG.shortSymbol
      ? normalizeHKSymbol(TRADING_CONFIG.shortSymbol)
      : null;

    // 判断当前信号是做多还是做空
    const isBuyCall = signal.action === 'BUYCALL';
    const isBuyPut = signal.action === 'BUYPUT';

    // 检查做多标的买入
    if (isBuyCall && longSymbol) {
      const result = checkUnrealizedLossForSymbol(
        longSymbol,
        longCurrentPrice,
        '做多标的',
      );
      if (result) {
        return result;
      }
    }

    // 检查做空标的买入
    if (isBuyPut && shortSymbol) {
      const result = checkUnrealizedLossForSymbol(
        shortSymbol,
        shortCurrentPrice,
        '做空标的',
      );
      if (result) {
        return result;
      }
    }

    return { allowed: true };
  };

  /**
   * 检查订单前的风险
   */
  const checkBeforeOrder = (
    account: AccountSnapshot | null,
    positions: ReadonlyArray<Position> | null,
    signal: Signal | null,
    orderNotional: number,
    currentPrice: number | null = null,
    longCurrentPrice: number | null = null,
    shortCurrentPrice: number | null = null,
  ): RiskCheckResult => {
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
  };

  return {
    unrealizedLossData: unrealizedLossChecker.getAllData(),

    async initializeWarrantInfo(
      marketDataClient: MarketDataClient,
      longSymbol: string,
      shortSymbol: string,
    ): Promise<void> {
      await warrantRiskChecker.initialize(
        marketDataClient,
        longSymbol,
        shortSymbol,
      );
    },

    checkBeforeOrder,

    checkWarrantRisk(
      symbol: string,
      signalType: string,
      monitorCurrentPrice: number,
    ): RiskCheckResult {
      return warrantRiskChecker.checkRisk(
        symbol,
        signalType,
        monitorCurrentPrice,
      );
    },

    async refreshUnrealizedLossData(
      orderRecorder: OrderRecorder,
      symbol: string,
      isLongSymbol: boolean,
    ): Promise<{ r1: number; n1: number } | null> {
      return await unrealizedLossChecker.refresh(
        orderRecorder,
        symbol,
        isLongSymbol,
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
};

// 导出类型
export type { RiskChecker } from './type.js';

