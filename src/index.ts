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
import { validateAllConfig } from './config/config.validator.js';
import {
  formatError,
  formatSymbolDisplay,
  initMonitorState,
  sleep,
} from './utils/helpers/index.js';
import { collectAllQuoteSymbols } from './utils/helpers/quoteHelpers.js';
import { getLatestTradedSymbol } from './core/orderRecorder/orderOwnershipParser.js';
import { TRADING } from './constants/index.js';

// 账户显示、持仓缓存和核心服务模块
import { displayAccountAndPositions } from './utils/helpers/accountDisplay.js';
import { createPositionCache } from './utils/helpers/positionCache.js';
import { createMarketMonitor } from './services/marketMonitor/index.js';
import { createDoomsdayProtection } from './core/doomsdayProtection/index.js';
import { createSignalProcessor } from './core/signalProcessor/index.js';
import { createLiquidationCooldownTracker } from './services/liquidationCooldown/index.js';
import { createTradeLogHydrator } from './services/liquidationCooldown/tradeLogHydrator.js';

// 异步任务处理架构模块
import { createIndicatorCache } from './main/asyncProgram/indicatorCache/index.js';
import { createBuyTaskQueue, createSellTaskQueue } from './main/asyncProgram/tradeTaskQueue/index.js';
import { createBuyProcessor } from './main/asyncProgram/buyProcessor/index.js';
import { createSellProcessor } from './main/asyncProgram/sellProcessor/index.js';

// 服务模块（monitorContext 用于初始化监控上下文，cleanup 用于退出清理）
import { createMonitorContext } from './services/monitorContext/index.js';
import { createSymbolRegistry, isSeatReady, isSeatVersionMatch } from './services/autoSymbolManager/utils.js';
import { createCleanup } from './services/cleanup/index.js';

// 导入主程序循环
import { mainProgram } from './main/mainProgram/index.js';

// 类型直接从 types.ts 导入，避免 re-export 模式
import type {
  LastState,
  MonitorContext,
  RawOrderFromAPI,
  ValidateAllConfigResult,
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

  let symbolNames: ValidateAllConfigResult;
  try {
    symbolNames = await validateAllConfig({ env, tradingConfig });
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
  const liquidationCooldownTracker = createLiquidationCooldownTracker({ nowMs: () => Date.now() });
  const tradeLogHydrator = createTradeLogHydrator({
    readFileSync: fs.readFileSync,
    existsSync: fs.existsSync,
    cwd: () => process.cwd(),
    nowMs: () => Date.now(),
    logger,
    tradingConfig,
    liquidationCooldownTracker,
  });

  tradeLogHydrator.hydrate();

  // 使用配置验证返回的标的名称和行情客户端实例
  const { marketDataClient } = symbolNames;
  const trader = await createTrader({
    config,
    tradingConfig,
    liquidationCooldownTracker,
    symbolRegistry,
  });

  logger.info('程序开始运行，在交易时段将进行实时监控和交易（按 Ctrl+C 退出）');

  // 预先计算所有交易标的集合（包含监控标的与席位标的）
  const allTradingSymbols = collectAllQuoteSymbols(tradingConfig.monitors, symbolRegistry);

  // 记录上一次的数据状态
  const lastState: LastState = {
    canTrade: null,
    isHalfDay: null,
    openProtectionActive: null,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: createPositionCache(), // 初始化持仓缓存（O(1) 查找）
    cachedTradingDayInfo: null, // 缓存的交易日信息 { isTradingDay, isHalfDay, checkDate }
    monitorStates: new Map(
      tradingConfig.monitors.map((monitorConfig) => [
        monitorConfig.monitorSymbol,
        initMonitorState(monitorConfig),
      ]),
    ),
    allTradingSymbols, // 缓存所有交易标的集合
  };

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

  // 初始化监控标的上下文
  // 首先批量获取所有标的行情（用于获取标的名称，减少 API 调用次数）
  const allInitSymbols = collectAllQuoteSymbols(tradingConfig.monitors, symbolRegistry);
  // getQuotes 接口已支持 Iterable，无需 Array.from() 转换
  const initQuotesMap = await marketDataClient.getQuotes(allInitSymbols);

  const monitorContexts: Map<string, MonitorContext> = new Map();
  for (const monitorConfig of tradingConfig.monitors) {
    const monitorState = lastState.monitorStates.get(monitorConfig.monitorSymbol);
    // 获取监控标的名称（用于日志显示）
    const monitorQuote = initQuotesMap.get(monitorConfig.monitorSymbol) ?? null;
    const monitorSymbolName = monitorQuote?.name ?? null;
    if (!monitorState) {
      logger.warn(`监控标的状态不存在: ${formatSymbolDisplay(monitorConfig.monitorSymbol, monitorSymbolName)}`);
      continue;
    }

    // 使用预先获取的行情数据创建上下文（无需单独 API 调用）
    // 每个监控标的创建独立的 DelayedSignalVerifier（使用各自的验证配置）
    const context = createMonitorContext(
      monitorConfig,
      monitorState,
      trader,
      marketDataClient,
      initQuotesMap,
      indicatorCache,
      symbolRegistry,
    );
    monitorContexts.set(monitorConfig.monitorSymbol, context);

    // 初始化每个监控标的牛熊证信息（自动寻标时延后刷新）
    if (!monitorConfig.autoSearchConfig.autoSearchEnabled) {
      await context.riskChecker
        .initializeWarrantInfo(
          marketDataClient,
          monitorConfig.longSymbol,
          monitorConfig.shortSymbol,
          context.longSymbolName,
          context.shortSymbolName,
        )
        .catch((err: unknown) => {
          logger.warn(
            `[牛熊证初始化失败] 监控标的 ${formatSymbolDisplay(monitorConfig.monitorSymbol, monitorSymbolName)}`,
            formatError(err),
          );
        });
    }
  }

  // 程序启动时立即获取一次账户和持仓信息
  await displayAccountAndPositions(trader, marketDataClient, lastState);

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

  logger.info('账户和持仓信息获取成功，程序初始化完成');

  let allOrders: ReadonlyArray<RawOrderFromAPI> = [];
  try {
    allOrders = await trader._orderRecorder.fetchAllOrdersFromAPI();
  } catch (err) {
    logger.warn('[全量订单获取失败] 将按空订单继续初始化', formatError(err));
  }

  function hasPositionForSymbol(symbol: string): boolean {
    return lastState.cachedPositions.some((position) => {
      return position.symbol === symbol && (position.quantity ?? 0) > 0;
    });
  }

  // 程序启动时刷新订单记录（为所有监控标的初始化订单记录）
  // 复用之前批量获取的行情数据（initQuotesMap 已包含所有交易标的的行情）
  // 为每个监控标的初始化订单记录
  for (const monitorContext of monitorContexts.values()) {
    const { config: ctxConfig, orderRecorder } = monitorContext;
    const autoSearchEnabled = ctxConfig.autoSearchConfig.autoSearchEnabled;

    const resolvedLongSymbol = autoSearchEnabled
      ? getLatestTradedSymbol(allOrders, ctxConfig.monitorSymbol, 'LONG')
      : ctxConfig.longSymbol;
    const resolvedShortSymbol = autoSearchEnabled
      ? getLatestTradedSymbol(allOrders, ctxConfig.monitorSymbol, 'SHORT')
      : ctxConfig.shortSymbol;

    monitorContext.autoSymbolManager.ensureSeatOnStartup({
      direction: 'LONG',
      initialSymbol: resolvedLongSymbol ?? null,
    });
    monitorContext.autoSymbolManager.ensureSeatOnStartup({
      direction: 'SHORT',
      initialSymbol: resolvedShortSymbol ?? null,
    });
    monitorContext.seatState = {
      long: monitorContext.symbolRegistry.getSeatState(ctxConfig.monitorSymbol, 'LONG'),
      short: monitorContext.symbolRegistry.getSeatState(ctxConfig.monitorSymbol, 'SHORT'),
    };
    monitorContext.seatVersion = {
      long: monitorContext.symbolRegistry.getSeatVersion(ctxConfig.monitorSymbol, 'LONG'),
      short: monitorContext.symbolRegistry.getSeatVersion(ctxConfig.monitorSymbol, 'SHORT'),
    };

    if (autoSearchEnabled) {
      async function refreshSeatWarrantInfo(
        symbol: string | null,
        isLongSymbol: boolean,
      ): Promise<void> {
        if (!symbol) {
          return;
        }
        const quote = initQuotesMap.get(symbol) ?? null;
        const symbolName = quote?.name ?? null;
        const result = await monitorContext.riskChecker.refreshWarrantInfoForSymbol(
          marketDataClient,
          symbol,
          isLongSymbol,
          symbolName,
        );
        if (result.status === 'error' || result.status === 'skipped') {
          const directionLabel = isLongSymbol ? '做多' : '做空';
          logger.warn(
            `[牛熊证初始化失败] 监控标的 ${formatSymbolDisplay(ctxConfig.monitorSymbol, monitorContext.monitorSymbolName)} ${directionLabel}标的 ${formatSymbolDisplay(symbol, symbolName)}`,
            result.status === 'error' ? result.reason : '未提供行情客户端',
          );
        }
      }

      await refreshSeatWarrantInfo(resolvedLongSymbol ?? null, true);
      await refreshSeatWarrantInfo(resolvedShortSymbol ?? null, false);
    }

    if (resolvedLongSymbol && (!autoSearchEnabled || hasPositionForSymbol(resolvedLongSymbol))) {
      const quote = initQuotesMap.get(resolvedLongSymbol) ?? null;
      await orderRecorder
        .refreshOrdersFromAllOrders(resolvedLongSymbol, true, allOrders, quote)
        .catch((err: unknown) => {
          logger.warn(
            `[订单记录初始化失败] 监控标的 ${formatSymbolDisplay(ctxConfig.monitorSymbol, monitorContext.monitorSymbolName)} 做多标的 ${formatSymbolDisplay(resolvedLongSymbol, quote?.name ?? null)}`,
            formatError(err),
          );
        });
    }

    if (resolvedShortSymbol && (!autoSearchEnabled || hasPositionForSymbol(resolvedShortSymbol))) {
      const quote = initQuotesMap.get(resolvedShortSymbol) ?? null;
      await orderRecorder
        .refreshOrdersFromAllOrders(resolvedShortSymbol, false, allOrders, quote)
        .catch((err: unknown) => {
          logger.warn(
            `[订单记录初始化失败] 监控标的 ${formatSymbolDisplay(ctxConfig.monitorSymbol, monitorContext.monitorSymbolName)} 做空标的 ${formatSymbolDisplay(resolvedShortSymbol, quote?.name ?? null)}`,
            formatError(err),
          );
        });
    }
  }

  // 程序启动时初始化浮亏监控数据（为所有监控标的初始化）
  for (const monitorContext of monitorContexts.values()) {
    const { config: ctxConfig, riskChecker, orderRecorder } = monitorContext;
    if ((ctxConfig.maxUnrealizedLossPerSymbol ?? 0) > 0) {
      if (ctxConfig.longSymbol) {
        const quote = initQuotesMap.get(ctxConfig.longSymbol) ?? null;
        await riskChecker
          .refreshUnrealizedLossData(orderRecorder, ctxConfig.longSymbol, true, quote)
          .catch((err: unknown) => {
            logger.warn(
              `[浮亏监控初始化失败] 监控标的 ${formatSymbolDisplay(ctxConfig.monitorSymbol, monitorContext.monitorSymbolName)} 做多标的 ${formatSymbolDisplay(ctxConfig.longSymbol, monitorContext.longSymbolName)}`,
              formatError(err),
            );
          });
      }
      if (ctxConfig.shortSymbol) {
        const quote = initQuotesMap.get(ctxConfig.shortSymbol) ?? null;
        await riskChecker
          .refreshUnrealizedLossData(orderRecorder, ctxConfig.shortSymbol, false, quote)
          .catch((err: unknown) => {
            logger.warn(
              `[浮亏监控初始化失败] 监控标的 ${formatSymbolDisplay(ctxConfig.monitorSymbol, monitorContext.monitorSymbolName)} 做空标的 ${formatSymbolDisplay(ctxConfig.shortSymbol, monitorContext.shortSymbolName)}`,
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
        monitorContexts,
        symbolRegistry,
        // 异步程序架构模块
        indicatorCache,
        buyTaskQueue,
        sellTaskQueue,
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
