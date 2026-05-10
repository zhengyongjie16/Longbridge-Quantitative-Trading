/**
 * 末日保护模块
 *
 * 功能：
 * - 收盘前的风险控制
 * - 买入截止窗口内拒绝买入新订单并撤销未成交买入订单
 * - 清仓接管窗口内自动清仓所有持仓
 *
 * 时间规则：
 * - 窗口长度由 `src/constants/index.ts` 中的 `DOOMSDAY` 常量统一定义
 * - 半日市按 12:00 收盘计算，正常交易日按 16:00 收盘计算
 *
 * 控制开关：
 * - DOOMSDAY_PROTECTION 环境变量（默认 true）
 */
import { OrderSide } from 'longbridge';
import { logger } from '../../utils/logger/index.js';
import { isSeatActive } from '../../utils/seat/guards.js';
import { ORDER_QUOTE_RETRY } from '../../constants/index.js';
import {
  resolveNextQuoteRetry,
  resolveQuoteReadinessForRequirement,
} from '../../utils/quoteRetry/index.js';
import type { MonitorContext } from '../../types/state.js';
import type { Position } from '../../types/account.js';
import type { Quote } from '../../types/quote.js';
import type { Signal, SignalType } from '../../types/signal.js';
import type {
  DoomsdayProtection,
  DoomsdayClearanceContext,
  DoomsdayClearanceResult,
  CancelPendingBuyOrdersContext,
  CancelPendingBuyOrdersResult,
  ClearanceSignalParams,
} from './types.js';
import {
  batchGetQuotes,
  getDoomsdayBuyCutoffWindowRangeLabel,
  getDoomsdayClearanceTakeoverWindowRangeLabel,
  isWithinDoomsdayBuyCutoffWindow,
  isWithinDoomsdayClearanceTakeoverWindow,
} from './utils.js';
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import { getHKDateKey } from '../../utils/time/index.js';
import { isCancelAcceptedOrTerminalNonFilledClose } from '../../utils/trading/orderStatus.js';

/**
 * 创建单个清仓信号（清仓接管窗口使用）。
 * 直接构造普通 Signal 对象，避免跨链路共享可变池化对象。
 *
 * @param params 清仓信号参数（标的、名称、动作、价格、每手股数、多空类型）
 * @returns 填充后的 Signal
 */
function createClearanceSignal(params: ClearanceSignalParams): Signal {
  const { symbol, symbolName, action, price, lotSize, positionType } = params;
  const positionLabel = positionType === 'short' ? '做空标的' : '做多标的';

  return {
    symbol,
    symbolName,
    action,
    reason: `末日保护程序：清仓接管窗口自动清仓（${positionLabel}持仓）`,
    price,
    lotSize,
    triggerTime: new Date(),
  };
}

/**
 * 从监控上下文中解析席位对应的交易标的。
 * 用于末日清仓时确定每个监控标的下的多/空实际交易标的（牛熊证代码）。
 *
 * @param context 监控上下文，缺失时无法解析
 * @param monitorSymbol 监控标的代码（如 HSI.HK）
 * @param direction 多空方向（LONG/SHORT）
 * @returns 该席位对应的交易标的代码，席位未就绪或上下文缺失时返回 null
 */
function resolveSeatSymbol(
  context: MonitorContext | undefined,
  monitorSymbol: string,
  direction: 'LONG' | 'SHORT',
): string | null {
  if (!context) {
    logger.warn(`[末日保护程序] 未找到监控上下文，跳过席位: ${monitorSymbol} ${direction}`);
    return null;
  }

  const seatState = context.symbolRegistry.getSeatState(monitorSymbol, direction);
  if (!isSeatActive(seatState)) {
    logger.debug(`[末日保护程序] 席位未就绪，跳过: ${monitorSymbol} ${direction}`);
    return null;
  }

  return seatState.symbol;
}

/**
 * 解析指定监控标的的多空席位交易标的。
 * 供清仓流程按监控维度获取做多/做空标的，用于匹配持仓与拉取行情。
 *
 * @param monitorSymbol 监控标的代码
 * @param monitorContexts 各监控标的的上下文 Map
 * @returns 该监控标的下的 longSymbol 与 shortSymbol（未就绪时为 null）
 */
function resolveMonitorSymbols(
  monitorSymbol: string,
  monitorContexts: DoomsdayClearanceContext['monitorContexts'],
): { longSymbol: string | null; shortSymbol: string | null } {
  const context = monitorContexts.get(monitorSymbol);
  return {
    longSymbol: resolveSeatSymbol(context, monitorSymbol, 'LONG'),
    shortSymbol: resolveSeatSymbol(context, monitorSymbol, 'SHORT'),
  };
}

/**
 * 处理单个持仓，生成一条清仓信号。
 * 仅当持仓属于当前监控配置（longSymbol/shortSymbol）且数量有效时生成信号；直接构造普通 Signal。
 *
 * @param pos 持仓信息（标的、可用数量、名称等）
 * @param longSymbol 当前监控下的做多交易标的，null 表示无
 * @param shortSymbol 当前监控下的做空交易标的，null 表示无
 * @param longQuote 做多标的最新行情（用于价格与 lotSize）
 * @param shortQuote 做空标的最新行情（用于价格与 lotSize）
 * @returns 一条清仓 Signal（SELLCALL/SELLPUT），或不属于本监控/无效持仓时 null
 */
function processPositionForClearance(
  pos: Position,
  longSymbol: string | null,
  shortSymbol: string | null,
  longQuote: Quote | null,
  shortQuote: Quote | null,
): Signal | null {
  // 验证持仓对象有效性
  if (pos.symbol.length === 0) {
    return null;
  }

  const availableQty = pos.availableQuantity || 0;
  if (!Number.isFinite(availableQty) || availableQty <= 0) {
    return null;
  }

  // 只处理属于当前监控配置的持仓
  if (pos.symbol !== longSymbol && pos.symbol !== shortSymbol) {
    return null;
  }

  const isShortPos = pos.symbol === shortSymbol;

  // 获取该标的的当前价格、最小买卖单位和名称
  let currentPrice: number | null = null;
  let lotSize: number | null = null;
  let symbolName: string | null = pos.symbolName || null;
  if (pos.symbol === longSymbol && longQuote) {
    currentPrice = longQuote.price;
    lotSize = longQuote.lotSize ?? null;
    symbolName = symbolName ?? longQuote.name ?? null;
  } else if (pos.symbol === shortSymbol && shortQuote) {
    currentPrice = shortQuote.price;
    lotSize = shortQuote.lotSize ?? null;
    symbolName = symbolName ?? shortQuote.name ?? null;
  }

  if (currentPrice === null || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return null;
  }

  // 清仓接管窗口清仓
  const action: SignalType = isShortPos ? 'SELLPUT' : 'SELLCALL';
  const positionType = isShortPos ? 'short' : 'long';
  const signal = createClearanceSignal({
    symbol: pos.symbol,
    symbolName,
    action,
    price: currentPrice,
    lotSize,
    positionType,
  });
  const positionLabel = positionType === 'short' ? '做空标的' : '做多标的';
  logger.debug(
    `[末日保护程序] 生成清仓信号：${positionLabel} ${pos.symbol} 数量=${availableQty} 操作=${action}`,
  );

  return signal;
}

/**
 * 创建末日保护程序（生命周期/风控：买入截止与自动清仓）
 * 买入截止窗口内拒绝买入并撤销未成交买入单，清仓接管窗口内自动清仓所有持仓。
 * @returns DoomsdayProtection 接口实例（isBuyCutoffWindowActive、executeClearance、cancelPendingBuyOrders）
 */
export function createDoomsdayProtection(deps?: {
  readonly now?: () => Date;
  readonly quoteRetryIntervalMs?: number;
  readonly quoteRetryMaxAttempts?: number;
}): DoomsdayProtection {
  // 状态：记录当天是否已执行过买入截止窗口的撤单检查
  // 格式为日期字符串（YYYY-MM-DD），用于跨天自动重置
  let cancelCheckExecutedDate: string | null = null;
  let lastClearanceNoticeKey: string | null = null;
  const now = deps?.now ?? (() => new Date());
  const quoteRetryIntervalMs = deps?.quoteRetryIntervalMs ?? ORDER_QUOTE_RETRY.INTERVAL_MS;
  const quoteRetryMaxAttempts = deps?.quoteRetryMaxAttempts ?? ORDER_QUOTE_RETRY.MAX_ATTEMPTS;
  let clearanceRetryAttempts = 0;
  let clearanceRetrySymbols: ReadonlySet<string> | null = null;
  let clearanceRetryDueAtMs: number | null = null;
  const clearanceRetryExhaustedSymbols = new Set<string>();

  const clearClearanceRetry = (): void => {
    clearanceRetryAttempts = 0;
    clearanceRetrySymbols = null;
    clearanceRetryDueAtMs = null;
  };

  const logClearanceNotice = (key: string, message: string): void => {
    if (lastClearanceNoticeKey === key) {
      return;
    }

    lastClearanceNoticeKey = key;
    logger.info(message);
  };

  /**
   * 执行清仓接管窗口的自动清仓。
   *
   * 关键约束：
   * - 生命周期交易门禁关闭时必须直接跳过，不允许执行清仓或继续 retry 恢复；
   * - 仅在清仓接管窗口且持仓非空时继续后续流程。
   */
  async function executeClearance(
    context: DoomsdayClearanceContext,
  ): Promise<DoomsdayClearanceResult> {
    const {
      currentTime,
      isHalfDay,
      positions,
      monitorConfigs,
      monitorContexts,
      trader,
      marketDataClient,
      lastState,
      onPositionsCommitted,
    } = context;
    const todayKey = getHKDateKey(currentTime);

    if (!lastState.isTradingEnabled) {
      clearClearanceRetry();
      clearanceRetryExhaustedSymbols.clear();
      logClearanceNotice(
        `gate-closed:${todayKey}`,
        '[末日保护程序] 清仓跳过：生命周期交易门禁关闭',
      );
      return { executed: false, signalCount: 0, nextRetryAtMs: null };
    }

    if (!isWithinDoomsdayClearanceTakeoverWindow(currentTime, isHalfDay)) {
      clearClearanceRetry();
      clearanceRetryExhaustedSymbols.clear();
      const clearanceWindowRange = getDoomsdayClearanceTakeoverWindowRangeLabel(isHalfDay);
      logClearanceNotice(
        `outside-window:${todayKey}`,
        `[末日保护程序] 清仓跳过：当前不在清仓接管窗口（${clearanceWindowRange}）`,
      );
      return { executed: false, signalCount: 0, nextRetryAtMs: null };
    }

    const retrySymbols = clearanceRetrySymbols;
    const retryPendingPositions =
      retrySymbols === null
        ? positions
        : positions.filter((position) => retrySymbols.has(position.symbol));
    const processingPositions = retryPendingPositions.filter(
      (position) => !clearanceRetryExhaustedSymbols.has(position.symbol),
    );
    if (processingPositions.length === 0) {
      clearClearanceRetry();
      logClearanceNotice(`no-positions:${todayKey}`, '[末日保护程序] 清仓跳过：无可处理持仓');
      return { executed: false, signalCount: 0, nextRetryAtMs: null };
    }

    const allTradingSymbols = new Set<string>();
    for (const monitorConfig of monitorConfigs) {
      const { longSymbol, shortSymbol } = resolveMonitorSymbols(
        monitorConfig.monitorSymbol,
        monitorContexts,
      );
      if (longSymbol) {
        allTradingSymbols.add(longSymbol);
      }

      if (shortSymbol) {
        allTradingSymbols.add(shortSymbol);
      }
    }

    const quoteMap = await batchGetQuotes(marketDataClient, allTradingSymbols);
    const allClearanceSignals: Signal[] = [];
    const unresolvedSymbols = new Set<string>();

    for (const monitorConfig of monitorConfigs) {
      const { longSymbol, shortSymbol } = resolveMonitorSymbols(
        monitorConfig.monitorSymbol,
        monitorContexts,
      );
      const longQuote = longSymbol ? (quoteMap.get(longSymbol) ?? null) : null;
      const shortQuote = shortSymbol ? (quoteMap.get(shortSymbol) ?? null) : null;

      for (const pos of processingPositions) {
        if (pos.symbol === longSymbol) {
          const quoteReadiness = resolveQuoteReadinessForRequirement({
            quote: longQuote,
            requirement: 'PRICE',
          });
          if (quoteReadiness !== 'READY') {
            if (quoteReadiness === 'MISSING') {
              unresolvedSymbols.add(pos.symbol);
            } else {
              logger.warn(
                `[末日保护程序] 清仓行情无效，跳过本轮清仓信号: symbol=${pos.symbol} readiness=${quoteReadiness}`,
              );
            }

            continue;
          }
        }

        if (pos.symbol === shortSymbol) {
          const quoteReadiness = resolveQuoteReadinessForRequirement({
            quote: shortQuote,
            requirement: 'PRICE',
          });
          if (quoteReadiness !== 'READY') {
            if (quoteReadiness === 'MISSING') {
              unresolvedSymbols.add(pos.symbol);
            } else {
              logger.warn(
                `[末日保护程序] 清仓行情无效，跳过本轮清仓信号: symbol=${pos.symbol} readiness=${quoteReadiness}`,
              );
            }

            continue;
          }
        }

        const signal = processPositionForClearance(
          pos,
          longSymbol,
          shortSymbol,
          longQuote,
          shortQuote,
        );
        if (signal) {
          allClearanceSignals.push(signal);
        }
      }
    }

    const uniqueSignalsMap = new Map<string, Signal>();
    for (const signal of allClearanceSignals) {
      const key = `${signal.action}_${signal.symbol}`;
      if (!uniqueSignalsMap.has(key)) {
        uniqueSignalsMap.set(key, signal);
      }
    }

    const uniqueClearanceSignals = [...uniqueSignalsMap.values()];
    let submittedCount = 0;
    if (uniqueClearanceSignals.length > 0) {
      logger.info(`[末日保护程序] 生成 ${uniqueClearanceSignals.length} 个清仓信号，准备执行`);
      const submittedSymbols = new Set(uniqueClearanceSignals.map((signal) => signal.symbol));
      const executionResult = await trader.executeSignals(uniqueClearanceSignals);
      submittedCount = executionResult.submittedCount;

      if (submittedCount === uniqueClearanceSignals.length) {
        lastState.cachedAccount = null;
        lastState.cachedPositions = lastState.cachedPositions.filter(
          (position) => !submittedSymbols.has(position.symbol),
        );
        lastState.positionCache.update(lastState.cachedPositions);
        await onPositionsCommitted?.();

        for (const monitorContext of monitorContexts.values()) {
          const { config, orderRecorder } = monitorContext;
          const { longSymbol, shortSymbol } = resolveMonitorSymbols(
            config.monitorSymbol,
            monitorContexts,
          );
          if (longSymbol && submittedSymbols.has(longSymbol)) {
            const quote = quoteMap.get(longSymbol) ?? null;
            orderRecorder.clearBuyOrders(longSymbol, true, quote);
          }

          if (shortSymbol && submittedSymbols.has(shortSymbol)) {
            const quote = quoteMap.get(shortSymbol) ?? null;
            orderRecorder.clearBuyOrders(shortSymbol, false, quote);
          }
        }
      } else {
        logger.warn(
          `[末日保护程序] 清仓信号仅提交 ${submittedCount}/${uniqueClearanceSignals.length} 个，保留缓存与订单记录等待后续刷新`,
        );
      }
    } else {
      const availablePositions = processingPositions.filter((pos) => {
        const availableQty = pos.availableQuantity || 0;
        return typeof pos.symbol === 'string' && Number.isFinite(availableQty) && availableQty > 0;
      });
      const seatSymbolSet = new Set(allTradingSymbols);
      const unmatchedPositions = availablePositions.filter((pos) => !seatSymbolSet.has(pos.symbol));
      logClearanceNotice(
        `no-signals:${todayKey}:${positions.length}:${availablePositions.length}:${unmatchedPositions.length}`,
        `[末日保护程序] 清仓跳过：未生成清仓信号（处理持仓=${processingPositions.length}, 可用持仓=${availablePositions.length}, 非席位持仓=${unmatchedPositions.length}）`,
      );
    }

    if (unresolvedSymbols.size > 0) {
      clearanceRetrySymbols = new Set(unresolvedSymbols);
      const currentMs = now().getTime();
      if (clearanceRetryDueAtMs !== null && currentMs < clearanceRetryDueAtMs) {
        return {
          executed: submittedCount > 0,
          signalCount: submittedCount,
          nextRetryAtMs: clearanceRetryDueAtMs,
        };
      }

      const nextRetry = resolveNextQuoteRetry({
        attempts: clearanceRetryAttempts,
        nowMs: currentMs,
        intervalMs: quoteRetryIntervalMs,
        maxAttempts: quoteRetryMaxAttempts,
      });
      if (nextRetry.exhausted) {
        clearClearanceRetry();
        for (const symbol of unresolvedSymbols) {
          clearanceRetryExhaustedSymbols.add(symbol);
        }

        logger.warn(
          `[末日保护程序] 清仓行情重试耗尽，放弃本窗口重试: symbols=${[...unresolvedSymbols].join(',')}`,
        );
        return { executed: submittedCount > 0, signalCount: submittedCount, nextRetryAtMs: null };
      }

      clearanceRetryAttempts = nextRetry.nextAttempts;
      clearanceRetryDueAtMs = nextRetry.nextRetryAt;
      return {
        executed: submittedCount > 0,
        signalCount: submittedCount,
        nextRetryAtMs: nextRetry.nextRetryAt,
      };
    }

    clearClearanceRetry();
    return { executed: submittedCount > 0, signalCount: submittedCount, nextRetryAtMs: null };
  }

  return {
    isBuyCutoffWindowActive(currentTime: Date, isHalfDay: boolean): boolean {
      return isWithinDoomsdayBuyCutoffWindow(currentTime, isHalfDay);
    },
    executeClearance,
    async cancelPendingBuyOrders(
      context: CancelPendingBuyOrdersContext,
    ): Promise<CancelPendingBuyOrdersResult> {
      const { currentTime, isHalfDay, monitorConfigs, monitorContexts, trader } = context;

      // 检查是否处于买入截止窗口
      if (!isWithinDoomsdayBuyCutoffWindow(currentTime, isHalfDay)) {
        // 不在买入截止窗口内，直接返回。
        // 当天执行标记由日期键自然隔离，无需额外重置 cancelCheckExecutedDate。
        return { executed: false, cancelRequestAcceptedCount: 0, nextRetryAtMs: null };
      }

      // 检查当天是否已执行过撤单检查
      // 逻辑：首次进入买入截止窗口时执行一次，之后不再重复
      // 原因：末日保护期间已拒绝新买入，不会有新的买入订单产生
      //       已撤销的订单会进入 WebSocket 监控，无需重复查询
      const todayDateString = getHKDateKey(currentTime);
      if (cancelCheckExecutedDate === todayDateString) {
        // 当天已执行过，直接返回
        return { executed: false, cancelRequestAcceptedCount: 0, nextRetryAtMs: null };
      }

      // 收集所有唯一的交易标的
      const allTradingSymbols = new Set<string>();
      for (const monitorConfig of monitorConfigs) {
        const { longSymbol, shortSymbol } = resolveMonitorSymbols(
          monitorConfig.monitorSymbol,
          monitorContexts,
        );
        if (longSymbol) {
          allTradingSymbols.add(longSymbol);
        }

        if (shortSymbol) {
          allTradingSymbols.add(shortSymbol);
        }
      }

      if (allTradingSymbols.size === 0) {
        return { executed: false, cancelRequestAcceptedCount: 0, nextRetryAtMs: null };
      }

      const symbolsArray = [...allTradingSymbols];

      // 首次进入买入截止窗口，查询未成交订单
      // 注意：这是当天唯一一次查询，之后不再重复调用 Trade API
      const closeTimeRange = getDoomsdayBuyCutoffWindowRangeLabel(isHalfDay);
      logger.info(`[末日保护程序] 首次进入买入截止窗口（${closeTimeRange}），检查未成交买入订单`);
      const pendingOrders = await trader.getPendingOrders(symbolsArray, true);

      // 过滤出买入订单
      const pendingBuyOrders = pendingOrders.filter((order) => order.side === OrderSide.Buy);
      if (pendingBuyOrders.length === 0) {
        cancelCheckExecutedDate = todayDateString;
        logger.info('[末日保护程序] 无未成交买入订单，无需撤单');
        return { executed: false, cancelRequestAcceptedCount: 0, nextRetryAtMs: null };
      }

      logger.info(`[末日保护程序] 发现 ${pendingBuyOrders.length} 个未成交买入订单，准备撤单`);

      // 撤销所有买入订单
      let cancelRequestAcceptedCount = 0;
      let cancelRetryRequired = false;
      for (const order of pendingBuyOrders) {
        try {
          const cancelOutcome = await trader.cancelOrder(order.orderId);
          if (isCancelAcceptedOrTerminalNonFilledClose(cancelOutcome)) {
            cancelRequestAcceptedCount++;
            logger.debug(
              `[末日保护程序] 买入订单撤单请求已接受：${order.symbol} 订单ID=${order.orderId} 数量=${order.quantity} 价格=${order.submittedPrice.toFixed(3)}，终态以后续 WS 为准`,
            );
            continue;
          }

          if (cancelOutcome.kind === 'ALREADY_CLOSED' && cancelOutcome.closedReason === 'FILLED') {
            logger.debug(`[末日保护程序] 买入订单已成交，无需撤单：${order.orderId}`);
            continue;
          }

          cancelRetryRequired = true;
          logger.warn(
            `[末日保护程序] 撤销买入订单未确认成功：${order.orderId} kind=${cancelOutcome.kind}`,
          );
        } catch (err) {
          if (isExternalApiRequestError(err)) {
            throw err;
          }

          throw err;
        }
      }

      if (cancelRequestAcceptedCount > 0) {
        logger.info(
          `[末日保护程序] 已提交撤单请求 ${cancelRequestAcceptedCount}/${pendingBuyOrders.length} 个买入订单，终态以后续 WS 为准`,
        );
      }

      if (cancelRetryRequired) {
        return {
          executed: true,
          cancelRequestAcceptedCount,
          nextRetryAtMs: now().getTime() + quoteRetryIntervalMs,
        };
      }

      cancelCheckExecutedDate = todayDateString;
      return { executed: true, cancelRequestAcceptedCount, nextRetryAtMs: null };
    },
  };
}
