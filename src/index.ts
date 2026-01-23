/**
 * LongBridge 港股自动化量化交易系统 - 主入口模块
 *
 * 系统概述：
 * - 监控恒生指数等目标资产的技术指标（RSI、KDJ、MACD、MFI）
 * - 根据指标信号在牛熊证上执行双向交易（做多/做空）
 * - 采用多指标组合策略，开仓信号延迟验证60秒，平仓信号立即执行
 *
 * 核心流程：
 * 1. 初始化所有模块实例（MarketMonitor、DoomsdayProtection、UnrealizedLossMonitor等）
 * 2. 主循环 mainProgram() 每秒执行一次，协调各模块
 * 3. 获取行情数据和技术指标
 * 4. 生成和验证交易信号
 * 5. 执行风险检查和订单交易
 *
 * 相关模块：
 * - strategy.ts：信号生成
 * - signalVerification.ts：延迟信号验证
 * - signalProcessor.ts：信号处理和风险检查
 * - trader.ts：订单执行
 */

import dotenv from 'dotenv';
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
import { TRADING } from './constants/index.js';

// 导入新模块
import { displayAccountAndPositions } from './utils/helpers/accountDisplay.js';
import { createPositionCache } from './utils/helpers/positionCache.js';
import { createMarketMonitor } from './services/marketMonitor/index.js';
import { createDoomsdayProtection } from './core/doomsdayProtection/index.js';
import { createSignalProcessor } from './core/signalProcessor/index.js';

// 导入重构后的新架构模块
import { createIndicatorCache } from './main/asyncProgram/indicatorCache/index.js';
import { createBuyTaskQueue, createSellTaskQueue } from './main/asyncProgram/tradeTaskQueue/index.js';
import { createBuyProcessor } from './main/asyncProgram/buyProcessor/index.js';
import { createSellProcessor } from './main/asyncProgram/sellProcessor/index.js';

// 导入主程序初始化模块（已迁移至 src/services/）
import { createMonitorContext } from './services/monitorContext/index.js';
import { createCleanup } from './services/cleanup/index.js';

// 导入主程序循环
import { mainProgram } from './main/mainProgram/index.js';

// 类型直接从 types.ts 导入，避免 re-export 模式
import type {
  LastState,
  MonitorContext,
  ValidateAllConfigResult,
} from './types/index.js';
import { getSprintSacreMooacreMoo } from './utils/asciiArt/sacreMooacre.js';

dotenv.config({ path: '.env.local' });

async function main(): Promise<void> {
  // 牛牛登场
  getSprintSacreMooacreMoo();
  // 首先验证配置，并获取标的的中文名称
  const env = process.env;
  const tradingConfig = createMultiMonitorTradingConfig({ env });

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

  // 使用配置验证返回的标的名称和行情客户端实例
  const { marketDataClient } = symbolNames;
  const trader = await createTrader({ config, tradingConfig });

  logger.info('程序开始运行，在交易时段将进行实时监控和交易（按 Ctrl+C 退出）');

  // 预先计算所有交易标的集合（静态配置，只计算一次）
  const allTradingSymbols = new Set<string>();
  for (const monitorConfig of tradingConfig.monitors) {
    if (monitorConfig.longSymbol) {
      allTradingSymbols.add(monitorConfig.longSymbol);
    }
    if (monitorConfig.shortSymbol) {
      allTradingSymbols.add(monitorConfig.shortSymbol);
    }
  }

  // 记录上一次的数据状态
  const lastState: LastState = {
    canTrade: null,
    isHalfDay: null,
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

  // 初始化新模块实例
  const marketMonitor = createMarketMonitor();
  const doomsdayProtection = createDoomsdayProtection();
  const signalProcessor = createSignalProcessor({ tradingConfig });

  // 初始化异步程序架构模块
  // 计算 IndicatorCache 的容量：max(buyDelay, sellDelay) + 15 + 10
  // 注意：IndicatorCache 需要在 monitorContexts 创建之前初始化，因为每个 MonitorContext 中的
  // DelayedSignalVerifier 需要引用 IndicatorCache
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
  const allInitSymbols = collectAllQuoteSymbols(tradingConfig.monitors);
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
    const context = createMonitorContext(monitorConfig, monitorState, trader, initQuotesMap, indicatorCache);
    monitorContexts.set(monitorConfig.monitorSymbol, context);

    // 初始化每个监控标的牛熊证信息
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

  // 程序启动时刷新订单记录（为所有监控标的初始化订单记录）
  // 复用之前批量获取的行情数据（initQuotesMap 已包含所有交易标的的行情）
  // 为每个监控标的初始化订单记录
  for (const monitorContext of monitorContexts.values()) {
    const { config: ctxConfig, orderRecorder } = monitorContext;
    if (ctxConfig.longSymbol) {
      const quote = initQuotesMap.get(ctxConfig.longSymbol) ?? null;
      await orderRecorder
        .refreshOrders(ctxConfig.longSymbol, true, quote)
        .catch((err: unknown) => {
          logger.warn(
            `[订单记录初始化失败] 监控标的 ${formatSymbolDisplay(ctxConfig.monitorSymbol, monitorContext.monitorSymbolName)} 做多标的 ${formatSymbolDisplay(ctxConfig.longSymbol, monitorContext.longSymbolName)}`,
            formatError(err),
          );
        });
    }
    if (ctxConfig.shortSymbol) {
      const quote = initQuotesMap.get(ctxConfig.shortSymbol) ?? null;
      await orderRecorder
        .refreshOrders(ctxConfig.shortSymbol, false, quote)
        .catch((err: unknown) => {
          logger.warn(
            `[订单记录初始化失败] 监控标的 ${formatSymbolDisplay(ctxConfig.monitorSymbol, monitorContext.monitorSymbolName)} 做空标的 ${formatSymbolDisplay(ctxConfig.shortSymbol, monitorContext.shortSymbolName)}`,
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

  // 为每个监控标的的 DelayedSignalVerifier 注册回调
  // 验证通过后根据信号类型分流到不同队列
  for (const [monitorSymbol, monitorContext] of monitorContexts) {
    const { delayedSignalVerifier } = monitorContext;

    delayedSignalVerifier.onVerified((signal, signalMonitorSymbol) => {
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

  // 创建 BuyProcessor（处理买入信号）
  const buyProcessor = createBuyProcessor({
    taskQueue: buyTaskQueue,
    getMonitorContext: (monitorSymbol: string) => monitorContexts.get(monitorSymbol),
    signalProcessor,
    trader,
    doomsdayProtection,
    getLastState: () => lastState,
    getIsHalfDay: () => lastState.isHalfDay ?? false,
  });

  // 创建 SellProcessor（处理卖出信号）
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

  // 使用 createCleanup 创建清理模块并注册退出处理函数
  const cleanup = createCleanup({
    buyProcessor,
    sellProcessor,
    monitorContexts,
    indicatorCache,
    lastState,
  });
  cleanup.registerExitHandlers();

  // 无限循环监控
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

try {
  await main();
} catch (err: unknown) {
  logger.error('程序异常退出', formatError(err));
  // 注意：异常退出时无法访问lastState，所以不在catch中清理
  process.exit(1);
}
