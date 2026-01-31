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
import { createRiskChecker } from './core/risk/index.js';
import { createDailyLossTracker } from './core/risk/dailyLossTracker.js';
import { createUnrealizedLossMonitor } from './core/unrealizedLossMonitor/index.js';
import { createOrderFilteringEngine } from './core/orderRecorder/orderFilteringEngine.js';
import { classifyAndConvertOrders } from './core/orderRecorder/utils.js';
import { resolveOrderOwnership } from './core/orderRecorder/orderOwnershipParser.js';
import {
  formatError,
  formatSymbolDisplay,
  initMonitorState,
  sleep,
  toBeijingTimeIso,
} from './utils/helpers/index.js';
import { collectRuntimeQuoteSymbols } from './utils/helpers/quoteHelpers.js';
import { TRADING } from './constants/index.js';
import {
  getTradingMinutesSinceOpen,
  isInContinuousHKSession,
  isWithinMorningOpenProtection,
} from './utils/helpers/tradingTime.js';

// 账户显示、持仓缓存和核心服务模块
import { displayAccountAndPositions, refreshAccountAndPositions } from './utils/helpers/accountDisplay.js';
import { createPositionCache } from './utils/helpers/positionCache.js';
import { createMarketMonitor } from './services/marketMonitor/index.js';
import { createDoomsdayProtection } from './core/doomsdayProtection/index.js';
import { createSignalProcessor } from './core/signalProcessor/index.js';
import { createLiquidationCooldownTracker } from './services/liquidationCooldown/index.js';
import { createTradeLogHydrator } from './services/liquidationCooldown/tradeLogHydrator.js';
import { createMarketDataClient } from './services/quoteClient/index.js';
import { createStartupGate } from './main/startup/gate.js';
import { prepareSeatsOnStartup, resolveReadySeatSymbol } from './main/startup/seat.js';
import { resolveGatePolicies, resolveRunMode } from './main/startup/utils.js';

// 异步任务处理架构模块
import { createIndicatorCache } from './main/asyncProgram/indicatorCache/index.js';
import { createDelayedSignalVerifier } from './main/asyncProgram/delayedSignalVerifier/index.js';
import { createBuyTaskQueue, createSellTaskQueue } from './main/asyncProgram/tradeTaskQueue/index.js';
import { createBuyProcessor } from './main/asyncProgram/buyProcessor/index.js';
import { createSellProcessor } from './main/asyncProgram/sellProcessor/index.js';

// 服务模块（monitorContext 用于初始化监控上下文，cleanup 用于退出清理）
import { createMonitorContext } from './services/monitorContext/index.js';
import { createAutoSymbolManager } from './services/autoSymbolManager/index.js';
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
  RawOrderFromAPI,
} from './types/index.js';
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
  // 首先验证配置，并获取标的的中文名称
  const env = process.env;
  const tradingConfig = createMultiMonitorTradingConfig({ env });
  const symbolRegistry = createSymbolRegistry(tradingConfig.monitors);

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

  let cachedTradingDayInfo: { dateStr: string; info: { isTradingDay: boolean; isHalfDay: boolean } } | null =
    null;

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
      logger.warn('无法获取交易日信息，将仅按交易时段判断', formatError(err));
      const fallback = { isTradingDay: true, isHalfDay: false };
      cachedTradingDayInfo = { dateStr, info: fallback };
      return fallback;
    }
  }

  const startupGate = createStartupGate({
    now: () => new Date(),
    sleep,
    resolveTradingDayInfo,
    isInSession: isInContinuousHKSession,
    isInOpenProtection: isWithinMorningOpenProtection,
    openProtection: tradingConfig.global.openProtection,
    intervalMs: TRADING.INTERVAL_MS,
    logger,
  });

  const startupTradingDayInfo = await startupGate.wait({ mode: gatePolicies.startupGate });

  const liquidationCooldownTracker = createLiquidationCooldownTracker({ nowMs: () => Date.now() });

  const dailyLossFilteringEngine = createOrderFilteringEngine();
  const dailyLossTracker = createDailyLossTracker({
    filteringEngine: dailyLossFilteringEngine,
    resolveOrderOwnership,
    classifyAndConvertOrders,
    toBeijingTimeIso,
  });

  const trader = await createTrader({
    config,
    tradingConfig,
    liquidationCooldownTracker,
    symbolRegistry,
    dailyLossTracker,
  });

  logger.info('程序开始运行，在交易时段将进行实时监控和交易（按 Ctrl+C 退出）');

  // 记录上一次的数据状态
  const lastState: LastState = {
    canTrade: null,
    isHalfDay: null,
    openProtectionActive: null,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: createPositionCache(), // 初始化持仓缓存（O(1) 查找）
    cachedTradingDayInfo: startupTradingDayInfo, // 缓存的交易日信息 { isTradingDay, isHalfDay }
    monitorStates: new Map(
      tradingConfig.monitors.map((monitorConfig) => [
        monitorConfig.monitorSymbol,
        initMonitorState(monitorConfig),
      ]),
    ),
    allTradingSymbols: new Set(), // 启动完成后再填充
  };

  // 程序启动时立即获取一次账户和持仓信息
  await refreshAccountAndPositions(trader, lastState);

  // 验证账户信息获取成功（程序启动必须获取到账户信息）
  if (!lastState.cachedAccount) {
    logger.error('程序启动失败：无法获取账户信息');
    process.exit(1);
  }

  // 验证持仓信息获取成功（空数组是有效的，表示无持仓）
  if (!Array.isArray(lastState.cachedPositions)) {
    logger.error('程序启动失败：无法获取持仓信息');
    process.exit(1);
  }

  logger.info('账户和持仓信息获取成功，开始解析席位');

  let allOrders: ReadonlyArray<RawOrderFromAPI> = [];
  try {
    allOrders = await trader._orderRecorder.fetchAllOrdersFromAPI();
  } catch (err) {
    logger.warn('[全量订单获取失败] 将按空订单继续初始化', formatError(err));
  }
  trader.seedOrderHoldSymbols(allOrders);
  dailyLossTracker.initializeFromOrders(allOrders, tradingConfig.monitors, new Date());

  const positionsSnapshot = lastState.cachedPositions ?? [];
  const seatResult = await prepareSeatsOnStartup({
    tradingConfig,
    symbolRegistry,
    positions: positionsSnapshot,
    orders: allOrders,
    marketDataClient,
    sleep,
    now: () => new Date(),
    intervalMs: TRADING.INTERVAL_MS,
    logger,
    getTradingMinutesSinceOpen,
    isWithinMorningOpenProtection,
  });

  const tradeLogHydrator = createTradeLogHydrator({
    readFileSync: fs.readFileSync,
    existsSync: fs.existsSync,
    cwd: () => process.cwd(),
    nowMs: () => Date.now(),
    logger,
    tradingConfig,
    liquidationCooldownTracker,
  });

  tradeLogHydrator.hydrate({ seatSymbols: seatResult.seatSymbols });

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

  const orderHoldSymbols = trader.getOrderHoldSymbols();
  const allTradingSymbols = collectRuntimeQuoteSymbols(
    tradingConfig.monitors,
    symbolRegistry,
    lastState.cachedPositions,
    orderHoldSymbols,
  );
  lastState.allTradingSymbols = allTradingSymbols;
  if (allTradingSymbols.size > 0) {
    await marketDataClient.subscribeSymbols([...allTradingSymbols]);
  }

  // 初始化监控标的上下文
  // 首先批量获取所有标的行情（用于获取标的名称，减少 API 调用次数）
  const initQuotesMap = await marketDataClient.getQuotes(allTradingSymbols);

  const runtimeValidationInputs: Array<{
    symbol: string;
    label: string;
    requireLotSize: boolean;
    required: boolean;
  }> = [];
  const requiredSymbols = new Set<string>();

  function pushRequiredSymbol(
    symbol: string | null,
    label: string,
    requireLotSize: boolean,
  ): void {
    if (!symbol || requiredSymbols.has(symbol)) {
      return;
    }
    requiredSymbols.add(symbol);
    runtimeValidationInputs.push({
      symbol,
      label,
      requireLotSize,
      required: true,
    });
  }

  function pushOptionalSymbol(symbol: string | null, label: string): void {
    if (!symbol || requiredSymbols.has(symbol)) {
      return;
    }
    runtimeValidationInputs.push({
      symbol,
      label,
      requireLotSize: false,
      required: false,
    });
  }

  for (const monitorConfig of tradingConfig.monitors) {
    const index = monitorConfig.originalIndex;
    pushRequiredSymbol(monitorConfig.monitorSymbol, `监控标的 ${index}`, false);

    const longSeatSymbol = resolveReadySeatSymbol(
      symbolRegistry,
      monitorConfig.monitorSymbol,
      'LONG',
    );
    const shortSeatSymbol = resolveReadySeatSymbol(
      symbolRegistry,
      monitorConfig.monitorSymbol,
      'SHORT',
    );
    pushRequiredSymbol(longSeatSymbol, `做多席位标的 ${index}`, true);
    pushRequiredSymbol(shortSeatSymbol, `做空席位标的 ${index}`, true);
  }

  for (const position of lastState.cachedPositions) {
    pushOptionalSymbol(position.symbol, '持仓标的');
  }

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

  await displayAccountAndPositions({ lastState, quotesMap: initQuotesMap });

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

    const riskChecker = createRiskChecker({
      options: {
        maxDailyLoss: monitorConfig.maxDailyLoss,
        maxPositionNotional: monitorConfig.maxPositionNotional,
        maxUnrealizedLossPerSymbol: monitorConfig.maxUnrealizedLossPerSymbol,
      },
    });

    const autoSymbolManager = createAutoSymbolManager({
      monitorConfig,
      symbolRegistry,
      marketDataClient,
      trader,
      orderRecorder: trader._orderRecorder,
      riskChecker,
    });

    const strategy = createHangSengMultiIndicatorStrategy({
      signalConfig: monitorConfig.signalConfig,
      verificationConfig: monitorConfig.verificationConfig,
    });

    const unrealizedLossMonitor = createUnrealizedLossMonitor({
      maxUnrealizedLossPerSymbol: monitorConfig.maxUnrealizedLossPerSymbol ?? 0,
    });

    const delayedSignalVerifier = createDelayedSignalVerifier({
      indicatorCache,
      verificationConfig: monitorConfig.verificationConfig,
    });

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

    async function refreshSeatWarrantInfo(
      symbol: string | null,
      isLongSymbol: boolean,
    ): Promise<void> {
      if (!symbol) {
        return;
      }
      const quote = initQuotesMap.get(symbol) ?? null;
      const symbolName = quote?.name ?? null;
      const result = await context.riskChecker.refreshWarrantInfoForSymbol(
        marketDataClient,
        symbol,
        isLongSymbol,
        symbolName,
      );
      if (result.status === 'error' || result.status === 'skipped') {
        const directionLabel = isLongSymbol ? '做多' : '做空';
        logger.warn(
          `[牛熊证初始化失败] 监控标的 ${formatSymbolDisplay(monitorConfig.monitorSymbol, monitorSymbolName)} ${directionLabel}标的 ${formatSymbolDisplay(symbol, symbolName)}`,
          result.status === 'error' ? result.reason : '未提供行情客户端',
        );
      }
    }

    const longSeatSymbol = resolveReadySeatSymbol(
      symbolRegistry,
      monitorConfig.monitorSymbol,
      'LONG',
    );
    const shortSeatSymbol = resolveReadySeatSymbol(
      symbolRegistry,
      monitorConfig.monitorSymbol,
      'SHORT',
    );

    await refreshSeatWarrantInfo(longSeatSymbol, true);
    await refreshSeatWarrantInfo(shortSeatSymbol, false);
  }

  // 程序启动时刷新订单记录（为所有监控标的初始化订单记录）
  for (const monitorContext of monitorContexts.values()) {
    const { config: ctxConfig, orderRecorder } = monitorContext;
    const longSeatSymbol = resolveReadySeatSymbol(
      symbolRegistry,
      ctxConfig.monitorSymbol,
      'LONG',
    );
    const shortSeatSymbol = resolveReadySeatSymbol(
      symbolRegistry,
      ctxConfig.monitorSymbol,
      'SHORT',
    );

    if (longSeatSymbol) {
      const quote = initQuotesMap.get(longSeatSymbol) ?? null;
      await orderRecorder
        .refreshOrdersFromAllOrders(longSeatSymbol, true, allOrders, quote)
        .catch((err: unknown) => {
          logger.warn(
            `[订单记录初始化失败] 监控标的 ${formatSymbolDisplay(ctxConfig.monitorSymbol, monitorContext.monitorSymbolName)} 做多标的 ${formatSymbolDisplay(longSeatSymbol, quote?.name ?? null)}`,
            formatError(err),
          );
        });
    }

    if (shortSeatSymbol) {
      const quote = initQuotesMap.get(shortSeatSymbol) ?? null;
      await orderRecorder
        .refreshOrdersFromAllOrders(shortSeatSymbol, false, allOrders, quote)
        .catch((err: unknown) => {
          logger.warn(
            `[订单记录初始化失败] 监控标的 ${formatSymbolDisplay(ctxConfig.monitorSymbol, monitorContext.monitorSymbolName)} 做空标的 ${formatSymbolDisplay(shortSeatSymbol, quote?.name ?? null)}`,
            formatError(err),
          );
        });
    }
  }

  // 程序启动时初始化浮亏监控数据（为所有监控标的初始化）
  for (const monitorContext of monitorContexts.values()) {
    const { config: ctxConfig, riskChecker, orderRecorder } = monitorContext;
    if ((ctxConfig.maxUnrealizedLossPerSymbol ?? 0) > 0) {
      const longSeatSymbol = resolveReadySeatSymbol(
        symbolRegistry,
        ctxConfig.monitorSymbol,
        'LONG',
      );
      const shortSeatSymbol = resolveReadySeatSymbol(
        symbolRegistry,
        ctxConfig.monitorSymbol,
        'SHORT',
      );

      if (longSeatSymbol) {
        const quote = initQuotesMap.get(longSeatSymbol) ?? null;
        const dailyLossOffset = dailyLossTracker.getLossOffset(
          ctxConfig.monitorSymbol,
          true,
        );
        await riskChecker
          .refreshUnrealizedLossData(
            orderRecorder,
            longSeatSymbol,
            true,
            quote,
            dailyLossOffset,
          )
          .catch((err: unknown) => {
            logger.warn(
              `[浮亏监控初始化失败] 监控标的 ${formatSymbolDisplay(ctxConfig.monitorSymbol, monitorContext.monitorSymbolName)} 做多标的 ${formatSymbolDisplay(longSeatSymbol, monitorContext.longSymbolName)}`,
              formatError(err),
            );
          });
      }
      if (shortSeatSymbol) {
        const quote = initQuotesMap.get(shortSeatSymbol) ?? null;
        const dailyLossOffset = dailyLossTracker.getLossOffset(
          ctxConfig.monitorSymbol,
          false,
        );
        await riskChecker
          .refreshUnrealizedLossData(
            orderRecorder,
            shortSeatSymbol,
            false,
            quote,
            dailyLossOffset,
          )
          .catch((err: unknown) => {
            logger.warn(
              `[浮亏监控初始化失败] 监控标的 ${formatSymbolDisplay(ctxConfig.monitorSymbol, monitorContext.monitorSymbolName)} 做空标的 ${formatSymbolDisplay(shortSeatSymbol, monitorContext.shortSymbolName)}`,
              formatError(err),
            );
          });
      }
    }
  }

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

      const isLongSignal = signal.action === 'BUYCALL' || signal.action === 'SELLCALL';
      const direction = isLongSignal ? 'LONG' : 'SHORT';
      const seatState = ctx.symbolRegistry.getSeatState(signalMonitorSymbol, direction);
      const seatVersion = ctx.symbolRegistry.getSeatVersion(signalMonitorSymbol, direction);

      if (!isSeatReady(seatState)) {
        logger.info(`[延迟验证通过] 席位不可用，丢弃信号: ${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)} ${signal.action}`);
        signalObjectPool.release(signal);
        return;
      }

      if (!isSeatVersionMatch(signal.seatVersion, seatVersion)) {
        logger.info(`[延迟验证通过] 席位版本不匹配，丢弃信号: ${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)} ${signal.action}`);
        signalObjectPool.release(signal);
        return;
      }

      if (signal.symbol !== seatState.symbol) {
        logger.info(`[延迟验证通过] 标的已切换，丢弃信号: ${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)} ${signal.action}`);
        signalObjectPool.release(signal);
        return;
      }

      logger.info(`[延迟验证通过] 信号推入任务队列: ${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)} ${signal.action}`);

      // 根据信号类型分流到不同队列
      const isSellSignal = signal.action === 'SELLCALL' || signal.action === 'SELLPUT';

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

  // 创建买卖处理器，分别消费各自队列中的交易任务
  const buyProcessor = createBuyProcessor({
    taskQueue: buyTaskQueue,
    getMonitorContext: (monitorSymbol: string) => monitorContexts.get(monitorSymbol),
    signalProcessor,
    trader,
    doomsdayProtection,
    getLastState: () => lastState,
    getIsHalfDay: () => lastState.isHalfDay ?? false,
  });

  const sellProcessor = createSellProcessor({
    taskQueue: sellTaskQueue,
    getMonitorContext: (monitorSymbol: string) => monitorContexts.get(monitorSymbol),
    signalProcessor,
    trader,
    getLastState: () => lastState,
  });

  // 启动 BuyProcessor 和 SellProcessor
  buyProcessor.start();
  sellProcessor.start();

  // 注册退出清理函数（Ctrl+C 时优雅关闭）
  const cleanup = createCleanup({
    buyProcessor,
    sellProcessor,
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
        runtimeGateMode: gatePolicies.runtimeGate,
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
