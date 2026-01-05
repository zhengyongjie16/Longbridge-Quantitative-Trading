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
import { normalizeHKSymbol, isBuyAction, isValidPositiveNumber } from '../../utils/helpers.js';
import { logger } from '../../utils/logger.js';
import type { Position, Signal, AccountSnapshot } from '../../types/index.js';
import type { MarketDataClient } from '../../services/quoteClient/index.js';
import type { OrderRecorder } from '../orderRecorder/index.js';
import type {
  RiskCheckResult,
  UnrealizedLossCheckResult,
  RiskCheckerOptions,
  UnrealizedLossData,
} from './type.js';
import { WarrantRiskChecker } from './warrantRiskChecker.js';
import { PositionLimitChecker } from './positionLimitChecker.js';
import { UnrealizedLossChecker } from './unrealizedLossChecker.js';

/**
 * 风险检查器（门面模式）
 */
export class RiskChecker {
  private readonly maxDailyLoss: number;
  private readonly warrantRiskChecker: WarrantRiskChecker;
  private readonly positionLimitChecker: PositionLimitChecker;
  private readonly unrealizedLossChecker: UnrealizedLossChecker;

  constructor({
    maxDailyLoss,
    maxPositionNotional,
    maxUnrealizedLossPerSymbol,
  }: RiskCheckerOptions = {}) {
    this.maxDailyLoss = maxDailyLoss ?? TRADING_CONFIG.maxDailyLoss ?? 0;

    // 验证 maxDailyLoss 的有效性
    if (!Number.isFinite(this.maxDailyLoss) || this.maxDailyLoss < 0) {
      logger.warn(
        `[风险检查警告] maxDailyLoss 配置无效（${this.maxDailyLoss}），将使用默认值 0（禁止任何浮亏）`,
      );
      this.maxDailyLoss = 0;
    }

    // 初始化各个子模块
    this.warrantRiskChecker = new WarrantRiskChecker();
    this.positionLimitChecker = new PositionLimitChecker(
      maxPositionNotional ?? TRADING_CONFIG.maxPositionNotional,
    );
    this.unrealizedLossChecker = new UnrealizedLossChecker(
      maxUnrealizedLossPerSymbol ?? TRADING_CONFIG.maxUnrealizedLossPerSymbol,
    );
  }

  /**
   * 获取浮亏数据（供外部访问）
   */
  get unrealizedLossData(): Map<string, UnrealizedLossData> {
    return this.unrealizedLossChecker.getAllData();
  }

  /**
   * 初始化牛熊证信息（在程序启动时调用）
   * @param marketDataClient MarketDataClient实例
   * @param longSymbol 做多标的代码
   * @param shortSymbol 做空标的代码
   */
  async initializeWarrantInfo(
    marketDataClient: MarketDataClient,
    longSymbol: string,
    shortSymbol: string,
  ): Promise<void> {
    await this.warrantRiskChecker.initialize(
      marketDataClient,
      longSymbol,
      shortSymbol,
    );
  }

  /**
   * 检查订单前的风险
   * @param account 账户快照
   * @param positions 持仓列表
   * @param signal 信号对象
   * @param orderNotional 计划下单金额（HKD）
   * @param currentPrice 标的当前市价
   * @param longCurrentPrice 做多标的的当前市价
   * @param shortCurrentPrice 做空标的的当前市价
   */
  checkBeforeOrder(
    account: AccountSnapshot | null,
    positions: Position[] | null,
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

    // 当日浮亏超过 maxDailyLoss 时，停止开新仓（仅对买入操作检查）
    if (isBuy) {
      const unrealizedLossResult = this._checkUnrealizedLossBeforeBuy(
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
      const positionCheckResult = this.positionLimitChecker.checkLimit(
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

  /**
   * 检查买入前的浮亏
   * @private
   */
  private _checkUnrealizedLossBeforeBuy(
    signal: Signal,
    longCurrentPrice: number | null,
    shortCurrentPrice: number | null,
  ): RiskCheckResult {
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
      const result = this._checkUnrealizedLossForSymbol(
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
      const result = this._checkUnrealizedLossForSymbol(
        shortSymbol,
        shortCurrentPrice,
        '做空标的',
      );
      if (result) {
        return result;
      }
    }

    return { allowed: true };
  }

  /**
   * 检查单个标的的浮亏
   * @private
   */
  private _checkUnrealizedLossForSymbol(
    symbol: string | null,
    currentPrice: number | null,
    directionName: string,
  ): RiskCheckResult | null {
    if (!symbol) {
      return null;
    }

    const lossData = this.unrealizedLossChecker.getUnrealizedLossData(symbol);
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
          this.maxDailyLoss
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
    if (unrealizedPnL <= -this.maxDailyLoss) {
      return {
        allowed: false,
        reason: `${directionName}持仓浮亏约 ${unrealizedPnL.toFixed(
          2,
        )} HKD 已超过单日最大亏损限制 ${
          this.maxDailyLoss
        } HKD，禁止买入${directionName}（R1=${r1.toFixed(2)}, R2=${r2.toFixed(
          2,
        )}, N1=${n1}）`,
      };
    }

    return null; // 检查通过
  }

  /**
   * 检查牛熊证距离回收价的风险（仅在买入前检查）
   * @param symbol 标的代码（牛熊证代码）
   * @param signalType 信号类型（'BUYCALL' 或 'BUYPUT'）
   * @param monitorCurrentPrice 监控标的的当前价格（用于计算距离回收价的百分比）
   * @returns {allowed: boolean, reason?: string, warrantInfo?: Object}
   */
  checkWarrantRisk(
    symbol: string,
    signalType: string,
    monitorCurrentPrice: number,
  ): RiskCheckResult {
    return this.warrantRiskChecker.checkRisk(
      symbol,
      signalType,
      monitorCurrentPrice,
    );
  }

  /**
   * 初始化或刷新标的的浮亏监控数据（在程序启动时或买入/卖出操作后调用）
   *
   * 计算方式（开仓成本）：
   * - R1 = 所有未平仓买入订单的市值总和（每个订单市值 = 成交价 × 成交数量）
   * - N1 = 所有未平仓买入订单的成交数量总和
   *
   * 注意：
   * - 程序启动时：调用方需要先调用 orderRecorder.refreshOrders() 刷新订单记录
   * - 交易后：调用方已通过 recordLocalBuy/recordLocalSell 更新了订单记录
   * - 本方法仅从 orderRecorder 中已有的订单列表计算 R1 和 N1，不会重复调用 API
   *
   * @param orderRecorder OrderRecorder实例
   * @param symbol 标的代码
   * @param isLongSymbol 是否为做多标的
   * @returns 返回R1（开仓成本）和N1（持仓数量），如果计算失败返回null
   */
  async refreshUnrealizedLossData(
    orderRecorder: OrderRecorder,
    symbol: string,
    isLongSymbol: boolean,
  ): Promise<{ r1: number; n1: number } | null> {
    return await this.unrealizedLossChecker.refresh(
      orderRecorder,
      symbol,
      isLongSymbol,
    );
  }

  /**
   * 检查标的的浮亏是否超过阈值，如果超过则返回清仓信号
   * @param symbol 标的代码
   * @param currentPrice 当前价格
   * @param isLongSymbol 是否为做多标的
   * @returns 返回是否需要清仓
   */
  checkUnrealizedLoss(
    symbol: string,
    currentPrice: number,
    isLongSymbol: boolean,
  ): UnrealizedLossCheckResult {
    return this.unrealizedLossChecker.check(symbol, currentPrice, isLongSymbol);
  }
}
