/**
 * LongBridge 港股自动化量化交易系统 - 主入口模块
 *
 * 系统概述：
 * - 监控恒生指数等目标资产的技术指标（RSI、KDJ、MACD、MFI等）
 * - 根据指标信号在牛熊证上执行双向交易（做多/做空）
 * - 采用多指标组合策略，买卖信号均可配置延迟验证（默认60秒）或立即执行
 *
 * 核心流程：
 * 1. 初始化所有模块实例（MarketMonitor、DoomsdayProtection、UnrealizedLossMonitor等）
 * 2. 主循环 mainProgram() 每秒执行一次，协调各模块
 * 3. 获取行情数据和技术指标
 * 4. 生成和验证交易信号
 * 5. 执行风险检查和订单交易
 *
 * 相关模块：
 * - core/strategy/index.ts：信号生成（多指标策略）
 * - main/asyncProgram/delayedSignalVerifier/index.ts：延迟信号验证
 * - core/signalProcessor/index.ts：信号过滤和风险检查
 * - core/trader/index.ts：订单执行（门面模式）
 */
import dotenv from 'dotenv';
import fs from 'node:fs';
import { createConfig } from './config/config.index.js';
import { createTrader } from './core/trader/index.js';
import { createMultiMonitorTradingConfig } from './config/config.trading.js';
import { logger } from './utils/logger/index.js';
import { validateAllConfig, validateRuntimeSymbolsFromQuotesMap } from './config/config.validator.js';
import { createHangSengMultiIndicatorStrategy } from './core/strategy/index.js';
import { createDailyLossTracker } from './core/riskController/dailyLossTracker.js';
import { createRiskChecker } from './core/riskController/index.js';
import { createUnrealizedLossMonitor } from './core/riskController/unrealizedLossMonitor.js';
import { createOrderFilteringEngine } from './core/orderRecorder/orderFilteringEngine.js';
import { classifyAndConvertOrders } from './core/orderRecorder/utils.js';
import { resolveOrderOwnership } from './core/orderRecorder/orderOwnershipParser.js';
import {
  formatError,
  formatSymbolDisplay,
  initMonitorState,
  isSellAction,
  sleep,
  toHongKongTimeIso,
} from './utils/helpers/index.js';
import { AUTO_SYMBOL_WARRANT_LIST_CACHE_TTL_MS, TRADING } from './constants/index.js';
import {
  getHKDateKey,
  isInContinuousHKSession,
  isWithinMorningOpenProtection,
  isWithinAfternoonOpenProtection,
} from './utils/helpers/tradingTime.js';

// 账户显示、持仓缓存和核心服务模块
import { displayAccountAndPositions } from './utils/helpers/accountDisplay.js';
import { createPositionCache } from './utils/helpers/positionCache.js';
import { createMarketMonitor } from './services/marketMonitor/index.js';
import { createDoomsdayProtection } from './core/doomsdayProtection/index.js';
import { createSignalProcessor } from './core/signalProcessor/index.js';
import { createLiquidationCooldownTracker } from './services/liquidationCooldown/index.js';
import { createTradeLogHydrator } from './services/liquidationCooldown/tradeLogHydrator.js';
import { createMarketDataClient } from './services/quoteClient/index.js';
import { createRefreshGate } from './utils/refreshGate/index.js';
import { createStartupGate } from './main/startup/gate.js';
import { resolveReadySeatSymbol } from './main/startup/seat.js';
import { resolveGatePolicies, resolveRunMode } from './main/startup/utils.js';

// 异步任务处理架构模块
import { createIndicatorCache } from './main/asyncProgram/indicatorCache/index.js';
import { createDelayedSignalVerifier } from './main/asyncProgram/delayedSignalVerifier/index.js';
import { createBuyTaskQueue, createSellTaskQueue } from './main/asyncProgram/tradeTaskQueue/index.js';
import { createBuyProcessor } from './main/asyncProgram/buyProcessor/index.js';
import { createSellProcessor } from './main/asyncProgram/sellProcessor/index.js';
import { createMonitorTaskQueue } from './main/asyncProgram/monitorTaskQueue/index.js';
import { createMonitorTaskProcessor } from './main/asyncProgram/monitorTaskProcessor/index.js';
import { createOrderMonitorWorker } from './main/asyncProgram/orderMonitorWorker/index.js';
import { createPostTradeRefresher } from './main/asyncProgram/postTradeRefresher/index.js';
import { clearQueuesForDirection as clearQueuesForDirectionUtil } from './main/processMonitor/utils.js';
import { createDayLifecycleManager } from './main/lifecycle/dayLifecycleManager.js';
import { createSignalRuntimeDomain } from './main/lifecycle/cacheDomains/signalRuntimeDomain.js';
import { createSeatDomain } from './main/lifecycle/cacheDomains/seatDomain.js';
import { createOrderDomain } from './main/lifecycle/cacheDomains/orderDomain.js';
import { createRiskDomain } from './main/lifecycle/cacheDomains/riskDomain.js';
import { createMarketDataDomain } from './main/lifecycle/cacheDomains/marketDataDomain.js';
import { createGlobalStateDomain } from './main/lifecycle/cacheDomains/globalStateDomain.js';
import { createLoadTradingDayRuntimeSnapshot } from './main/lifecycle/loadTradingDayRuntimeSnapshot.js';
import { createRebuildTradingDayState } from './main/lifecycle/rebuildTradingDayState.js';

// 服务模块（monitorContext 用于初始化监控上下文，cleanup 用于退出清理）
import { createMonitorContext } from './services/monitorContext/index.js';
import { createAutoSymbolManager } from './services/autoSymbolManager/index.js';
import { createWarrantListCache } from './services/autoSymbolFinder/utils.js';
import {
  createSymbolRegistry,
  isSeatReady,
  isSeatVersionMatch,
} from './services/autoSymbolManager/utils.js';
import { createCleanup } from './services/cleanup/index.js';

// 导入主程序循环
import { mainProgram } from './main/mainProgram/index.js';

// 类型直接从 types.ts 导入，避免 re-export 模式
import type {
  LastState,
  MonitorContext,
  Quote,
  RawOrderFromAPI,
} from './types/index.js';
import type { MonitorTaskData, MonitorTaskType } from './main/asyncProgram/monitorTaskProcessor/types.js';
import { getSprintSacreMooacreMoo } from './utils/asciiArt/sacreMooacre.js';
import { signalObjectPool } from './utils/objectPool/index.js';

dotenv.config({ path: '.env.local' });

/**
 * 程序主入口函数
 *
 * 初始化流程：
 * 1. 验证配置并获取标的名称
 * 2. 创建交易客户端和各模块实例
 * 3. 初始化监控上下文、订单记录、浮亏监控数据
 * 4. 注册延迟信号验证回调
 * 5. 启动买卖处理器和主循环
 */
async function main(): Promise<void> {
  // 启动画面
  getSprintSacreMooacreMoo();
  // 解析配置并创建席位注册表
  const env = process.env;
  const tradingConfig = createMultiMonitorTradingConfig({ env });
  const symbolRegistry = createSymbolRegistry(tradingConfig.monitors);
  const warrantListCache = createWarrantListCache();
  const warrantListCacheConfig = {
    cache: warrantListCache,
    ttlMs: AUTO_SYMBOL_WARRANT_LIST_CACHE_TTL_MS,
    nowMs: () => Date.now(),
  };

  try {
    await validateAllConfig({ env, tradingConfig });
  } catch (err) {
    if ((err as { name?: string }).name === 'ConfigValidationError') {
      logger.error('程序启动失败：配置验证未通过');
      process.exit(1);
    } else {
      logger.error('配置验证过程中发生错误', err);
      process.exit(1);
    }
  }

  const config = createConfig({ env });
  const marketDataClient = await createMarketDataClient({ config });
  const runMode = resolveRunMode(env);
  const gatePolicies = resolveGatePolicies(runMode);

  // 解析监控标的对应的做多/做空席位标的代码。
  // 仅返回已就绪（Ready）状态的席位标的，未就绪时返回 null。
  function resolveSeatSymbols(
    monitorSymbol: string,
  ): { longSeatSymbol: string | null; shortSeatSymbol: string | null } {
    return {
      longSeatSymbol: resolveReadySeatSymbol(symbolRegistry, monitorSymbol, 'LONG'),
      shortSeatSymbol: resolveReadySeatSymbol(symbolRegistry, monitorSymbol, 'SHORT'),
    };
  }

  let cachedTradingDayInfo: { dateStr: string; info: { isTradingDay: boolean; isHalfDay: boolean } } | null =
    null;

  // 获取交易日信息并按日期缓存，避免频繁调用 API。
  async function resolveTradingDayInfo(currentTime: Date): Promise<{ isTradingDay: boolean; isHalfDay: boolean }> {
    const dateStr = currentTime.toISOString().slice(0, 10);
    if (cachedTradingDayInfo?.dateStr === dateStr) {
      return cachedTradingDayInfo.info;
    }
    try {
      const info = await marketDataClient.isTradingDay(currentTime);
      cachedTradingDayInfo = { dateStr, info };
      return info;
    } catch (err) {
      logger.warn('无法获取交易日信息，按非交易日处理并等待重试', formatError(err));
      return { isTradingDay: false, isHalfDay: false };
    }
  }

  // 启动门控：按交易日/时段/开盘保护决定是否等待启动
  const startupGate = createStartupGate({
    now: () => new Date(),
    sleep,
    resolveTradingDayInfo,
    isInSession: isInContinuousHKSession,
    isInMorningOpenProtection: isWithinMorningOpenProtection,
    isInAfternoonOpenProtection: isWithinAfternoonOpenProtection,
    openProtection: tradingConfig.global.openProtection,
    intervalMs: TRADING.INTERVAL_MS,
    logger,
  });

  // 等待门控完成并拿到交易日信息
  const startupTradingDayInfo = await startupGate.wait({ mode: gatePolicies.startupGate });

  // 清仓冷却追踪器：用于买入冷却判断
  const liquidationCooldownTracker = createLiquidationCooldownTracker({ nowMs: () => Date.now() });

  // 日内亏损跟踪器：基于订单记录计算与过滤
  const dailyLossFilteringEngine = createOrderFilteringEngine();
  const dailyLossTracker = createDailyLossTracker({
    filteringEngine: dailyLossFilteringEngine,
    resolveOrderOwnership,
    classifyAndConvertOrders,
    toHongKongTimeIso,
  });

  // 刷新门控：控制刷新节奏，避免频繁重算
  const refreshGate = createRefreshGate();

  // 记录上一次的数据状态（先创建以便注入执行门禁单一状态源）
  const lastState: LastState = {
    canTrade: null,
    isHalfDay: null,
    openProtectionActive: null,
    currentDayKey: getHKDateKey(new Date()),
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    // 初始化持仓缓存（O(1) 查找）
    positionCache: createPositionCache(),
    // 缓存的交易日信息 { isTradingDay, isHalfDay }
    cachedTradingDayInfo: startupTradingDayInfo,
    monitorStates: new Map(
      tradingConfig.monitors.map((monitorConfig) => [
        monitorConfig.monitorSymbol,
        initMonitorState(monitorConfig),
      ]),
    ),
    // 启动完成后再填充
    allTradingSymbols: new Set(),
  };

  // 交易器实例（注入核心依赖，isExecutionAllowed 以 lastState 为单一状态源）
  const trader = await createTrader({
    config,
    tradingConfig,
    liquidationCooldownTracker,
    symbolRegistry,
    dailyLossTracker,
    refreshGate,
    isExecutionAllowed: () => lastState.isTradingEnabled,
  });

  logger.info('程序开始运行，在交易时段将进行实时监控和交易（按 Ctrl+C 退出）');

  // 交易日志回放器：用于恢复清仓冷却相关状态
  const tradeLogHydrator = createTradeLogHydrator({
    readFileSync: fs.readFileSync,
    existsSync: fs.existsSync,
    cwd: () => process.cwd(),
    nowMs: () => Date.now(),
    logger,
    tradingConfig,
    liquidationCooldownTracker,
  });

  const loadTradingDayRuntimeSnapshot = createLoadTradingDayRuntimeSnapshot({
    marketDataClient,
    trader,
    lastState,
    tradingConfig,
    symbolRegistry,
    dailyLossTracker,
    tradeLogHydrator,
    warrantListCacheConfig,
  });

  let allOrders: ReadonlyArray<RawOrderFromAPI> = [];
  let initQuotesMap: ReadonlyMap<string, Quote | null> = new Map();
  try {
    const startupSnapshot = await loadTradingDayRuntimeSnapshot({
      now: new Date(),
      requireTradingDay: false,
      failOnOrderFetchError: false,
      resetRuntimeSubscriptions: false,
      hydrateCooldownFromTradeLog: true,
      forceOrderRefresh: false,
    });
    allOrders = startupSnapshot.allOrders;
    initQuotesMap = startupSnapshot.quotesMap;
  } catch (err) {
    logger.error('程序启动失败：初始化交易日运行态失败', formatError(err));
    process.exit(1);
  }

  // 初始化核心模块实例
  const marketMonitor = createMarketMonitor(); // 市场状态监控
  const doomsdayProtection = createDoomsdayProtection(); // 末日保护（收盘前清仓）
  const signalProcessor = createSignalProcessor({ tradingConfig, liquidationCooldownTracker }); // 信号处理和风险检查

  // 初始化异步任务处理架构
  // IndicatorCache 容量 = max(buyDelay, sellDelay) + 缓冲区，用于延迟验证时查询历史指标
  // 必须在 monitorContexts 之前初始化，因为 DelayedSignalVerifier 依赖 IndicatorCache
  const maxDelaySeconds = Math.max(
    ...tradingConfig.monitors.map((m) =>
      Math.max(m.verificationConfig.buy.delaySeconds, m.verificationConfig.sell.delaySeconds),
    ),
  );
  const indicatorCacheMaxEntries = maxDelaySeconds + 15 + 10;
  const indicatorCache = createIndicatorCache({ maxEntries: indicatorCacheMaxEntries });
  const buyTaskQueue = createBuyTaskQueue();
  const sellTaskQueue = createSellTaskQueue();
  const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();

  const runtimeValidationInputs: Array<{
    symbol: string;
    label: string;
    requireLotSize: boolean;
    required: boolean;
  }> = [];
  const requiredSymbols = new Set<string>();

  // 记录运行时行情验证所需标的（必选/可选）。
  function pushSymbol(
    symbol: string | null,
    label: string,
    requireLotSize: boolean,
    required: boolean,
  ): void {
    if (!symbol || requiredSymbols.has(symbol)) {
      return;
    }
    if (required) {
      requiredSymbols.add(symbol);
    }
    runtimeValidationInputs.push({
      symbol,
      label,
      requireLotSize,
      required,
    });
  }

  // 收集监控标的与席位标的，作为运行时行情校验输入
  for (const monitorConfig of tradingConfig.monitors) {
    const index = monitorConfig.originalIndex;
    pushSymbol(monitorConfig.monitorSymbol, `监控标的 ${index}`, false, true);

    const { longSeatSymbol, shortSeatSymbol } = resolveSeatSymbols(monitorConfig.monitorSymbol);
    pushSymbol(longSeatSymbol, `做多席位标的 ${index}`, true, true);
    pushSymbol(shortSeatSymbol, `做空席位标的 ${index}`, true, true);
  }

  // 持仓标的只做可选校验（失败仅警告）
  for (const position of lastState.cachedPositions) {
    pushSymbol(position.symbol, '持仓标的', false, false);
  }

  // 根据行情缓存验证标的有效性与交易所需信息
  const runtimeValidationResult = validateRuntimeSymbolsFromQuotesMap({
    inputs: runtimeValidationInputs,
    quotesMap: initQuotesMap,
  });

  if (runtimeValidationResult.warnings.length > 0) {
    logger.warn('标的验证出现警告：');
    runtimeValidationResult.warnings.forEach((warning, index) => {
      logger.warn(`${index + 1}. ${warning}`);
    });
  }

  if (!runtimeValidationResult.valid) {
    logger.error('标的验证失败！');
    logger.error('='.repeat(60));
    runtimeValidationResult.errors.forEach((error, index) => {
      logger.error(`${index + 1}. ${error}`);
    });
    logger.error('='.repeat(60));
    process.exit(1);
  }

  // 构建每个监控标的的运行上下文与依赖模块
  const monitorContexts: Map<string, MonitorContext> = new Map();
  for (const monitorConfig of tradingConfig.monitors) {
    const monitorState = lastState.monitorStates.get(monitorConfig.monitorSymbol);
    const monitorQuote = initQuotesMap.get(monitorConfig.monitorSymbol) ?? null;
    const monitorSymbolName = monitorQuote?.name ?? null;
    if (!monitorState) {
      logger.warn(
        `监控标的状态不存在: ${formatSymbolDisplay(monitorConfig.monitorSymbol, monitorSymbolName)}`,
      );
      continue;
    }

    // 初始化风控、自动寻标、策略、浮亏与延迟验证组件
    const riskChecker = createRiskChecker({
      options: {
        maxDailyLoss: monitorConfig.maxDailyLoss,
        maxPositionNotional: monitorConfig.maxPositionNotional,
        maxUnrealizedLossPerSymbol: monitorConfig.maxUnrealizedLossPerSymbol,
      },
    });

    // 自动寻标管理器：负责席位寻标/换标流程
    const autoSymbolManager = createAutoSymbolManager({
      monitorConfig,
      symbolRegistry,
      marketDataClient,
      trader,
      orderRecorder: trader._orderRecorder,
      riskChecker,
      warrantListCacheConfig,
    });

    // 策略模块：生成交易信号
    const strategy = createHangSengMultiIndicatorStrategy({
      signalConfig: monitorConfig.signalConfig,
      verificationConfig: monitorConfig.verificationConfig,
    });

    // 浮亏监控器：监控单标的浮亏
    const unrealizedLossMonitor = createUnrealizedLossMonitor({
      maxUnrealizedLossPerSymbol: monitorConfig.maxUnrealizedLossPerSymbol ?? 0,
    });

    // 延迟验证器：用于延迟信号验证
    const delayedSignalVerifier = createDelayedSignalVerifier({
      indicatorCache,
      verificationConfig: monitorConfig.verificationConfig,
    });

    // 构建监控上下文，聚合配置、状态与依赖
    const context = createMonitorContext({
      config: monitorConfig,
      state: monitorState,
      symbolRegistry,
      quotesMap: initQuotesMap,
      strategy,
      orderRecorder: trader._orderRecorder,
      dailyLossTracker,
      riskChecker,
      unrealizedLossMonitor,
      delayedSignalVerifier,
      autoSymbolManager,
    });
    monitorContexts.set(monitorConfig.monitorSymbol, context);
  }

  const rebuildTradingDayState = createRebuildTradingDayState({
    marketDataClient,
    trader,
    lastState,
    symbolRegistry,
    monitorContexts,
    dailyLossTracker,
    displayAccountAndPositions,
  });
  await rebuildTradingDayState({
    allOrders,
    quotesMap: initQuotesMap,
  });
  refreshGate.markFresh(refreshGate.getStatus().staleVersion);

  // 注册延迟验证回调：验证通过后，买入信号入 buyTaskQueue，卖出信号入 sellTaskQueue
  for (const [monitorSymbol, monitorContext] of monitorContexts) {
    const { delayedSignalVerifier } = monitorContext;

    delayedSignalVerifier.onVerified((signal, signalMonitorSymbol) => {
      const ctx = monitorContexts.get(signalMonitorSymbol);
      if (!ctx) {
        logger.warn(`[延迟验证通过] 未找到监控上下文，丢弃信号: ${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)} ${signal.action}`);
        signalObjectPool.release(signal);
        return;
      }

      const signalDisplay = formatSymbolDisplay(signal.symbol, signal.symbolName ?? null);
      const signalLabel = `${signalDisplay} ${signal.action}`;

      function discardSignal(prefix: string): void {
        logger.info(`${prefix}: ${signalLabel}`);
        signalObjectPool.release(signal);
      }

      if (!lastState.isTradingEnabled) {
        discardSignal('[延迟验证通过] 生命周期门禁关闭，丢弃信号');
        return;
      }

      const isLongSignal = signal.action === 'BUYCALL' || signal.action === 'SELLCALL';
      const direction = isLongSignal ? 'LONG' : 'SHORT';
      const seatState = ctx.symbolRegistry.getSeatState(signalMonitorSymbol, direction);
      const seatVersion = ctx.symbolRegistry.getSeatVersion(signalMonitorSymbol, direction);

      if (!isSeatReady(seatState)) {
        discardSignal('[延迟验证通过] 席位不可用，丢弃信号');
        return;
      }

      if (!isSeatVersionMatch(signal.seatVersion, seatVersion)) {
        discardSignal('[延迟验证通过] 席位版本不匹配，丢弃信号');
        return;
      }

      if (signal.symbol !== seatState.symbol) {
        discardSignal('[延迟验证通过] 标的已切换，丢弃信号');
        return;
      }

      logger.info(`[延迟验证通过] 信号推入任务队列: ${signalLabel}`);

      // 根据信号类型分流到不同队列
      const isSellSignal = isSellAction(signal.action);

      if (isSellSignal) {
        // 卖出信号 → SellTaskQueue（独立队列，不被买入阻塞）
        sellTaskQueue.push({
          type: 'VERIFIED_SELL',
          data: signal,
          monitorSymbol: signalMonitorSymbol,
        });
      } else {
        // 买入信号 → BuyTaskQueue
        buyTaskQueue.push({
          type: 'VERIFIED_BUY',
          data: signal,
          monitorSymbol: signalMonitorSymbol,
        });
      }
    });

    delayedSignalVerifier.onRejected((signal, _signalMonitorSymbol, reason) => {
      logger.info(`[延迟验证失败] ${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)} ${signal.action}: ${reason}`);
      // 验证失败的信号由 DelayedSignalVerifier 内部释放，无需在此处理
    });

    logger.debug(`[DelayedSignalVerifier] 监控标的 ${formatSymbolDisplay(monitorSymbol, monitorContext.monitorSymbolName)} 的验证器已初始化`);
  }


  // 清理指定监控标的和方向的所有待执行任务队列。
  // 用于自动换标时清理旧标的的延迟信号、买卖任务和监控任务。
  function clearQueuesForDirection(monitorSymbol: string, direction: 'LONG' | 'SHORT'): void {
    const monitorContext = monitorContexts.get(monitorSymbol);
    if (!monitorContext) {
      return;
    }
    const result = clearQueuesForDirectionUtil({
      monitorSymbol,
      direction,
      delayedSignalVerifier: monitorContext.delayedSignalVerifier,
      buyTaskQueue,
      sellTaskQueue,
      monitorTaskQueue,
      releaseSignal: signalObjectPool.release,
    });
    const totalRemoved =
      result.removedDelayed +
      result.removedBuy +
      result.removedSell +
      result.removedMonitorTasks;
    if (totalRemoved > 0) {
      logger.info(
        `[自动换标] ${monitorSymbol} ${direction} 清理待执行信号：延迟=${result.removedDelayed} 买入=${result.removedBuy} 卖出=${result.removedSell} 监控任务=${result.removedMonitorTasks}`,
      );
    }
  }

  // 订单监控工作器：负责盯单与自动调整订单
  const orderMonitorWorker = createOrderMonitorWorker({
    monitorAndManageOrders: (quotesMap) => trader.monitorAndManageOrders(quotesMap),
  });

  // 交易后刷新器：统一刷新账户/持仓/浮亏并展示
  const postTradeRefresher = createPostTradeRefresher({
    refreshGate,
    trader,
    lastState,
    monitorContexts,
    displayAccountAndPositions,
  });

  // 监控任务处理器：处理寻标/换标等监控任务
  const monitorTaskProcessor = createMonitorTaskProcessor({
    monitorTaskQueue,
    refreshGate,
    getMonitorContext: (monitorSymbol: string) => monitorContexts.get(monitorSymbol) ?? null,
    clearQueuesForDirection,
    marketDataClient,
    trader,
    lastState,
    tradingConfig,
    getCanProcessTask: () => lastState.isTradingEnabled,
  });

  // 创建买卖处理器，分别消费各自队列中的交易任务
  const buyProcessor = createBuyProcessor({
    taskQueue: buyTaskQueue,
    getMonitorContext: (monitorSymbol: string) => monitorContexts.get(monitorSymbol),
    signalProcessor,
    trader,
    doomsdayProtection,
    getLastState: () => lastState,
    getIsHalfDay: () => lastState.isHalfDay ?? false,
    getCanProcessTask: () => lastState.isTradingEnabled,
  });

  const sellProcessor = createSellProcessor({
    taskQueue: sellTaskQueue,
    getMonitorContext: (monitorSymbol: string) => monitorContexts.get(monitorSymbol),
    signalProcessor,
    trader,
    getLastState: () => lastState,
    refreshGate,
    getCanProcessTask: () => lastState.isTradingEnabled,
  });

  async function runOpenRebuild(now: Date): Promise<void> {
    const openRebuildSnapshot = await loadTradingDayRuntimeSnapshot({
      now,
      requireTradingDay: true,
      failOnOrderFetchError: true,
      resetRuntimeSubscriptions: true,
      hydrateCooldownFromTradeLog: false,
      forceOrderRefresh: true,
    });
    await rebuildTradingDayState({
      allOrders: openRebuildSnapshot.allOrders,
      quotesMap: openRebuildSnapshot.quotesMap,
    });
  }

  const dayLifecycleManager = createDayLifecycleManager({
    mutableState: lastState,
    cacheDomains: [
      createSignalRuntimeDomain({
        monitorContexts,
        buyProcessor,
        sellProcessor,
        monitorTaskProcessor,
        orderMonitorWorker,
        postTradeRefresher,
        indicatorCache,
        buyTaskQueue,
        sellTaskQueue,
        monitorTaskQueue,
        refreshGate,
        releaseSignal: signalObjectPool.release,
      }),
      createMarketDataDomain({
        marketDataClient,
      }),
      createSeatDomain({
        tradingConfig,
        symbolRegistry,
        monitorContexts,
        warrantListCache,
      }),
      createOrderDomain({
        trader,
      }),
      createRiskDomain({
        signalProcessor,
        dailyLossTracker,
        monitorContexts,
        liquidationCooldownTracker,
      }),
      createGlobalStateDomain({
        lastState,
        runOpenRebuild,
      }),
    ],
    logger,
  });

  monitorTaskProcessor.start();
  // 启动 BuyProcessor 和 SellProcessor
  buyProcessor.start();
  sellProcessor.start();
  orderMonitorWorker.start();
  postTradeRefresher.start();

  // 注册退出清理函数（Ctrl+C 时优雅关闭）
  const cleanup = createCleanup({
    buyProcessor,
    sellProcessor,
    monitorTaskProcessor,
    orderMonitorWorker,
    postTradeRefresher,
    monitorContexts,
    indicatorCache,
    lastState,
  });
  cleanup.registerExitHandlers();

  // 主循环监控
  while (true) {
    try {
      await mainProgram({
        marketDataClient,
        trader,
        lastState,
        marketMonitor,
        doomsdayProtection,
        signalProcessor,
        tradingConfig,
        dailyLossTracker,
        monitorContexts,
        symbolRegistry,
        // 异步程序架构模块
        indicatorCache,
        buyTaskQueue,
        sellTaskQueue,
        monitorTaskQueue,
        orderMonitorWorker,
        postTradeRefresher,
        runtimeGateMode: gatePolicies.runtimeGate,
        dayLifecycleManager,
      });
    } catch (err) {
      logger.error('本次执行失败', formatError(err));
    }

    await sleep(TRADING.INTERVAL_MS);
  }
}

// 启动程序
try {
  await main();
} catch (err: unknown) {
  logger.error('程序异常退出', formatError(err));
  process.exit(1);
}
