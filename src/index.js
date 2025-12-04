import { createConfig } from "./config.js";
import { MarketDataClient } from "./quoteClient.js";
import { HangSengMultiIndicatorStrategy } from "./strategy.js";
import { Trader } from "./trader.js";
import { buildIndicatorSnapshot, getKDJAt } from "./indicators.js";
import { RiskChecker } from "./risk.js";
import { TRADING_CONFIG } from "./config.trading.js";
import { logger } from "./logger.js";
import { validateAllConfig } from "./config.validator.js";
import { SignalType } from "./signalTypes.js";

/**
 * 规范化港股代码，自动添加 .HK 后缀（如果还没有）
 */
function normalizeHKSymbol(symbol) {
  if (!symbol || typeof symbol !== "string") {
    return symbol;
  }
  if (symbol.includes(".")) {
    return symbol;
  }
  return `${symbol}.HK`;
}

/**
 * 判断是否在港股连续交易时段
 * 港股连续交易时段：
 * - 上午：09:30 - 12:00
 * - 下午：13:00 - 16:00
 * @param {Date} date 时间对象（应该是UTC时间）
 * @returns {boolean} true表示在连续交易时段，false表示不在
 */
function isInContinuousHKSession(date) {
  if (!date) return false;
  // 将时间转换为香港时区（UTC+8）
  const utcHour = date.getUTCHours();
  const utcMinute = date.getUTCMinutes();
  const hkHour = (utcHour + 8) % 24;
  const hkMinute = utcMinute;

  // 上午连续交易时段：09:30 - 12:00
  // 条件：小时数为9且分钟数>=30，或者小时数在10-11之间，或者（小时数为12且分钟数为0）
  const inMorning = 
    (hkHour === 9 && hkMinute >= 30) ||  // 9:30 - 9:59
    (hkHour >= 10 && hkHour < 12) ||       // 10:00 - 11:59
    (hkHour === 12 && hkMinute === 0);    // 12:00:00

  // 下午连续交易时段：13:00 - 15:59:59
  // 注意：16:00:00 是收盘时间，不包含在连续交易时段内
  const inAfternoon =
    (hkHour === 13) ||                     // 13:00 - 13:59
    (hkHour >= 14 && hkHour < 16);          // 14:00 - 15:59

  return inMorning || inAfternoon;
}

/**
 * 判断是否在当日收盘前5分钟内
 * 港股当日收盘时间：下午 16:00
 * 收盘前5分钟：15:55 - 16:00（仅判断下午收盘，不包括上午收盘）
 */
function isBeforeClose5Minutes(date) {
  if (!date) return false;
  const utcHour = date.getUTCHours();
  const utcMinute = date.getUTCMinutes();
  const hkHour = (utcHour + 8) % 24;
  const hkMinute = utcMinute;

  // 仅判断下午收盘前5分钟：15:55 - 16:00
  const beforeAfternoonClose =
    (hkHour === 15 && hkMinute >= 55) || (hkHour === 16 && hkMinute === 0);

  return beforeAfternoonClose;
}

/**
 * 主程序：
 * 1. 从环境变量读取 LongPort 配置（见快速开始文档：https://open.longbridge.com/zh-CN/docs/getting-started）
 * 2. 拉取监控标的的 K 线数据（用于计算指标和生成信号）
 * 3. 计算 RSI / KDJ / VWAP，并生成策略信号
 * 4. 根据监控标的的信号，对做多/做空标的执行交易
 */
async function runOnce({
  marketDataClient,
  strategy,
  trader,
  candlePeriod,
  candleCount,
  lastState,
}) {
  // 返回是否有数据变化
  let hasChange = false;

  const account = await trader.getAccountSnapshot().catch((err) => {
    logger.warn("获取账户信息失败", err?.message ?? err);
    return null;
  });
  
  const positions = await trader.getStockPositions().catch((err) => {
    logger.warn("获取股票仓位失败", err?.message ?? err);
    return [];
  });
  
  // 检测账户和持仓变化
  const accountKey = account 
    ? `${account.totalCash.toFixed(2)}_${account.netAssets.toFixed(2)}_${account.positionValue.toFixed(2)}`
    : null;
  const positionsKey = Array.isArray(positions) && positions.length > 0
    ? positions
        .filter(p => p?.symbol) // 过滤无效持仓
        .map(p => `${p.symbol}_${p.quantity}_${p.availableQuantity}`)
        .join('|')
    : 'empty';
  const stateKey = `${accountKey}_${positionsKey}`;
  
  if (!lastState.accountState || lastState.accountState !== stateKey) {
    hasChange = true;
    if (account) {
      logger.info(
        `账户概览 [${account.currency}] 余额=${account.totalCash.toFixed(
          2
        )} 市值=${account.netAssets.toFixed(
          2
        )} 持仓市值≈${account.positionValue.toFixed(2)}`
      );
    }
    if (Array.isArray(positions) && positions.length > 0) {
      logger.info("股票持仓：");
      const formatNumber = (num, digits = 2) =>
        Number.isFinite(num) ? num.toFixed(digits) : String(num ?? "-");
      
      // 批量获取所有持仓标的的当前价格
      const positionSymbols = positions.map(p => p.symbol).filter(Boolean);
      const quotesMap = new Map();
      if (positionSymbols.length > 0) {
        try {
          const quotes = await marketDataClient.getQuotes(positionSymbols);
          if (Array.isArray(quotes)) {
            // decimalToNumber 函数定义（与 trader.js 中相同）
            const decimalToNumber = (decimalLike) =>
              decimalLike && typeof decimalLike.toNumber === "function"
                ? decimalLike.toNumber()
                : Number(decimalLike ?? 0);
            
            quotes.forEach(quote => {
              if (quote?.symbol) {
                // 从 quote 中提取价格（使用 lastDone 字段，这是 LongPort API 的标准字段）
                const price = decimalToNumber(quote.lastDone ?? quote.price ?? 0);
                if (Number.isFinite(price) && price > 0) {
                  quotesMap.set(normalizeHKSymbol(quote.symbol), price);
                }
              }
            });
          }
        } catch (err) {
          logger.warn(`[持仓监控] 获取持仓标的行情失败: ${err?.message ?? err}`);
        }
      }
      
      // 计算总资产用于计算仓位百分比
      const totalAssets = account?.netAssets ?? 0;
      
      positions.forEach((pos) => {
        const nameText = pos.symbolName ?? "-";
        const codeText = normalizeHKSymbol(pos.symbol);
        
        // 获取当前价格（优先使用实时价格，否则使用成本价）
        const normalizedPosSymbol = normalizeHKSymbol(pos.symbol);
        const currentPrice = quotesMap.get(normalizedPosSymbol) ?? pos.costPrice ?? 0;
        
        // 计算持仓市值
        const posQuantity = Number(pos.quantity) || 0;
        const marketValue = Number.isFinite(currentPrice) && currentPrice > 0 && posQuantity > 0
          ? posQuantity * currentPrice
          : 0;
        
        // 计算仓位百分比
        const positionPercent = Number.isFinite(totalAssets) && totalAssets > 0 && marketValue > 0
          ? (marketValue / totalAssets) * 100
          : 0;
        
        // 构建价格显示文本
        const priceText = quotesMap.has(normalizedPosSymbol)
          ? `现价=${formatNumber(currentPrice, 3)}`
          : `成本价=${formatNumber(pos.costPrice, 3)}`;
        
        logger.info(
          `- [${pos.accountChannel}] ${nameText}(${codeText}) 持仓=${formatNumber(
            pos.quantity,
            2
          )} 可用=${formatNumber(pos.availableQuantity, 2)} ${priceText} 市值=${formatNumber(
            marketValue,
            2
          )} 仓位=${formatNumber(positionPercent, 2)}% ${pos.currency ?? ""}`
        );
      });
    } else {
      logger.info("当前无股票持仓。");
    }
    lastState.accountState = stateKey;
  }
  // 获取做多标的的行情（用于判断是否在交易时段）
  const longSymbol = TRADING_CONFIG.longSymbol;
  const longQuote = await marketDataClient.getLatestQuote(longSymbol).catch((err) => {
    logger.warn(`[行情获取失败] 做多标的`, err?.message ?? err);
    return null;
  });
  const longSymbolName = longQuote?.name ?? longSymbol;

  // 判断是否在交易时段（使用当前系统时间，而不是行情数据的时间戳）
  // 因为行情数据的时间戳可能是历史数据或缓存数据，不能准确反映当前是否在交易时段
  const currentTime = new Date();
  const canTradeNow = isInContinuousHKSession(currentTime);
  
  // 如果获取到了行情数据，记录一下行情时间用于调试（仅在DEBUG模式下）
  if (process.env.DEBUG === "true" && longQuote?.timestamp) {
    const quoteTime = longQuote.timestamp;
    logger.debug(
      `[交易时段检查] 当前系统时间: ${currentTime.toISOString()}, 行情时间: ${quoteTime.toISOString()}, 是否在交易时段: ${canTradeNow}`
    );
  }
  
  // 检测交易时段变化
  if (lastState.canTrade !== canTradeNow) {
    hasChange = true;
    if (canTradeNow) {
      logger.info("进入连续交易时段，开始正常交易。");
    } else {
      logger.info("当前为竞价或非连续交易时段，暂停实时监控。");
    }
    lastState.canTrade = canTradeNow;
  }

  // 如果不在交易时段，跳过所有实时监控逻辑
  if (!canTradeNow) {
    return hasChange;
  }

  // 以下逻辑仅在连续交易时段执行
  const shortSymbol = TRADING_CONFIG.shortSymbol;

  // 获取做空标的的行情
  const shortQuote = await marketDataClient.getLatestQuote(shortSymbol).catch((err) => {
    logger.warn(`[行情获取失败] 做空标的`, err?.message ?? err);
    return null;
  });
  const shortSymbolName = shortQuote?.name ?? shortSymbol;

  // 检测价格变化，只在价格变化时显示
  const longPrice = longQuote?.price;
  const shortPrice = shortQuote?.price;
  
  if (longPrice !== lastState.longPrice || shortPrice !== lastState.shortPrice) {
    hasChange = true;
    
    // 统一的行情显示格式化函数
    const formatQuoteDisplay = (quote, symbol, label) => {
      if (!quote) {
        return null;
      }
      
      const nameText = quote.name ?? "-";
      const codeText = normalizeHKSymbol(symbol);
      const currentPrice = quote.price;
      
      // 最新价格
      const priceText = Number.isFinite(currentPrice)
        ? currentPrice.toFixed(3)
        : currentPrice ?? "-";
      
      // 时间
      const tsText = quote.timestamp
        ? quote.timestamp.toLocaleString("zh-CN", {
            timeZone: "Asia/Hong_Kong",
            hour12: false,
          })
        : "未知时间";
      
      // 涨跌额和涨跌幅度
      let changeAmountText = "-";
      let changePercentText = "-";
      
      if (
        Number.isFinite(currentPrice) &&
        Number.isFinite(quote.prevClose) &&
        quote.prevClose !== 0
      ) {
        // 涨跌额 = 当前价格 - 前收盘价
        const changeAmount = currentPrice - quote.prevClose;
        changeAmountText = `${changeAmount >= 0 ? "+" : ""}${changeAmount.toFixed(3)}`;
        
        // 涨跌幅度 = (当前价格 - 前收盘价) / 前收盘价 * 100%
        const changePercent = (changeAmount / quote.prevClose) * 100;
        changePercentText = `${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%`;
      }
      
      return {
        nameText,
        codeText,
        priceText,
        changeAmountText,
        changePercentText,
        tsText,
      };
    };
    
    // 显示做多标的行情
    const longDisplay = formatQuoteDisplay(longQuote, longSymbol, "做多");
    if (longDisplay) {
      logger.info(
        `[做多] ${longDisplay.nameText}(${longDisplay.codeText}) 最新价格=${longDisplay.priceText} 涨跌额=${longDisplay.changeAmountText} 涨跌幅度=${longDisplay.changePercentText} 时间=${longDisplay.tsText}`
      );
    } else {
      logger.warn(`未获取到做多标的行情。`);
    }

    // 显示做空标的行情
    const shortDisplay = formatQuoteDisplay(shortQuote, shortSymbol, "做空");
    if (shortDisplay) {
      logger.info(
        `[做空] ${shortDisplay.nameText}(${shortDisplay.codeText}) 最新价格=${shortDisplay.priceText} 涨跌额=${shortDisplay.changeAmountText} 涨跌幅度=${shortDisplay.changePercentText} 时间=${shortDisplay.tsText}`
      );
    } else {
      logger.warn(`未获取到做空标的行情。`);
    }
    
    // 更新价格状态
    lastState.longPrice = longPrice;
    lastState.shortPrice = shortPrice;
  }

  // 获取监控标的的K线数据（用于计算指标和生成信号）
  const monitorSymbol = TRADING_CONFIG.monitorSymbol;
  const monitorQuote = await marketDataClient.getLatestQuote(monitorSymbol).catch(() => null);
  const monitorSymbolName = monitorQuote?.name ?? monitorSymbol;
  const monitorCandles = await marketDataClient.getCandlesticks(
    monitorSymbol,
    candlePeriod,
    candleCount
  ).catch((err) => {
    logger.error(`获取监控标的 ${monitorSymbol} K线数据失败`, err?.message ?? err);
    return null;
  });

  if (!monitorCandles || monitorCandles.length === 0) {
    throw new Error(`未获取到监控标的 ${monitorSymbol} K 线数据`);
  }
  
  // 只计算监控标的的指标
  const monitorSnapshot = buildIndicatorSnapshot(monitorSymbol, monitorCandles);
  
  // 获取做多和做空标的的持仓信息
  const normalizedLongSymbol = normalizeHKSymbol(longSymbol);
  const normalizedShortSymbol = normalizeHKSymbol(shortSymbol);
  
  let longPosition = null;
  let shortPosition = null;
  
  // 验证 positions 是数组
  if (Array.isArray(positions)) {
    for (const pos of positions) {
      // 验证持仓对象有效性
      if (!pos?.symbol || typeof pos.symbol !== "string") {
        continue; // 跳过无效持仓
      }
      
      const normalizedPosSymbol = pos.symbol.includes(".") 
        ? pos.symbol 
        : `${pos.symbol}.HK`;
      
      // 验证可用数量有效性
      const availableQty = Number(pos.availableQuantity) || 0;
      if (!Number.isFinite(availableQty) || availableQty <= 0) {
        continue; // 跳过无效或零持仓
      }
      
      if (normalizedPosSymbol === normalizedLongSymbol) {
        longPosition = {
          symbol: pos.symbol,
          costPrice: Number(pos.costPrice) || 0,
          quantity: Number(pos.quantity) || 0,
          availableQuantity: availableQty,
        };
      } else if (normalizedPosSymbol === normalizedShortSymbol) {
        shortPosition = {
          symbol: pos.symbol,
          costPrice: Number(pos.costPrice) || 0,
          quantity: Number(pos.quantity) || 0,
          availableQuantity: availableQty,
        };
      }
    }
  }
  
  // 根据新策略生成交易信号（包含立即执行的清仓信号和延迟验证的开仓信号）
  const { immediateSignals, delayedSignals } = strategy.generateCloseSignals(
    monitorSnapshot,
    longPosition,
    longQuote?.price ?? null,
    shortPosition,
    shortQuote?.price ?? null,
    normalizedLongSymbol,
    normalizedShortSymbol
  );
  
  // 将立即执行的信号添加到交易信号列表
  const tradingSignals = [...immediateSignals];
  
  // 初始化待验证信号数组（如果不存在）
  if (!lastState.pendingDelayedSignals) {
    lastState.pendingDelayedSignals = [];
  }
  
  // 处理延迟验证信号，添加到待验证列表
  for (const delayedSignal of delayedSignals) {
    if (delayedSignal && delayedSignal.triggerTime) {
      // 检查是否已存在相同的待验证信号（避免重复添加）
      const existingSignal = lastState.pendingDelayedSignals.find(
        s => s.symbol === delayedSignal.symbol && 
             s.action === delayedSignal.action &&
             s.triggerTime.getTime() === delayedSignal.triggerTime.getTime()
      );
      
      if (!existingSignal) {
        lastState.pendingDelayedSignals.push(delayedSignal);
        hasChange = true;
        const actionDesc = delayedSignal.action === SignalType.BUYCALL ? "买入做多" : "买入做空";
        logger.info(
          `[延迟验证信号] 新增待验证${actionDesc}信号：${delayedSignal.symbol} - ${delayedSignal.reason}`
        );
      }
    }
  }
  
  // 检查是否有待验证的信号到了验证时间
  const now = new Date();
  const signalsToVerify = lastState.pendingDelayedSignals.filter(
    s => s.triggerTime && s.triggerTime <= now
  );
  
  // 处理需要验证的信号
  for (const pendingSignal of signalsToVerify) {
    try {
      // 获取前两分钟的KDJ J值
      // 当前时间是下下分钟的开始（例如10:32:00），需要获取：
      // J1: 前两分钟（10:30）的J值
      // J2: 前一分钟（10:31）的J值
      // 
      // 由于K线数据可能包含当前分钟的数据，我们需要找到对应时间戳的K线
      // 计算目标时间：使用信号的触发时间（必须存在）
      if (!pendingSignal.triggerTime) {
        logger.warn(
          `[延迟验证错误] ${pendingSignal.symbol} 缺少triggerTime，跳过验证`
        );
        // 从待验证列表中移除
        const index = lastState.pendingDelayedSignals.indexOf(pendingSignal);
        if (index >= 0) {
          lastState.pendingDelayedSignals.splice(index, 1);
        }
        continue;
      }
      const verifyTime = pendingSignal.triggerTime;
      const j1Time = new Date(verifyTime.getTime() - 2 * 60 * 1000); // 前两分钟
      const j2Time = new Date(verifyTime.getTime() - 1 * 60 * 1000); // 前一分钟
      
      // 找到对应时间戳的K线索引（精确到分钟，考虑日期）
      const findCandleIndex = (targetTime) => {
        const targetMinute = targetTime.getMinutes();
        const targetHour = targetTime.getHours();
        const targetDate = targetTime.getDate();
        const targetMonth = targetTime.getMonth();
        const targetYear = targetTime.getFullYear();
        
        for (let i = monitorCandles.length - 1; i >= 0; i--) {
          const candle = monitorCandles[i];
          if (!candle || !candle.timestamp) continue;
          
          const candleTime = new Date(candle.timestamp);
          const candleMinute = candleTime.getMinutes();
          const candleHour = candleTime.getHours();
          const candleDate = candleTime.getDate();
          const candleMonth = candleTime.getMonth();
          const candleYear = candleTime.getFullYear();
          
          // 匹配到分钟级别，同时考虑日期（避免跨天问题）
          if (
            candleYear === targetYear &&
            candleMonth === targetMonth &&
            candleDate === targetDate &&
            candleHour === targetHour &&
            candleMinute === targetMinute
          ) {
            return i;
          }
        }
        return -1;
      };
      
      const j1Index = findCandleIndex(j1Time);
      const j2Index = findCandleIndex(j2Time);
      
      // 获取J值
      const j1 = j1Index >= 0 ? getKDJAt(monitorCandles, j1Index, 9) : null;
      const j2 = j2Index >= 0 ? getKDJAt(monitorCandles, j2Index, 9) : null;
      
      if (j1 !== null && j2 !== null && Number.isFinite(j1) && Number.isFinite(j2)) {
        // 根据信号类型使用不同的验证条件
        const isBuyCall = pendingSignal.action === SignalType.BUYCALL;
        const isBuyPut = pendingSignal.action === SignalType.BUYPUT;
        
        // 只处理延迟验证的信号类型
        if (!isBuyCall && !isBuyPut) {
          logger.warn(
            `[延迟验证错误] ${pendingSignal.symbol} 未知的信号类型: ${pendingSignal.action}，跳过验证`
          );
          // 从待验证列表中移除
          const index = lastState.pendingDelayedSignals.indexOf(pendingSignal);
          if (index >= 0) {
            lastState.pendingDelayedSignals.splice(index, 1);
          }
          continue;
        }
        
        let verificationPassed = false;
        let verificationReason = "";
        
        if (isBuyCall) {
          // 买入做多标的：J2 > J1
          verificationPassed = j2 > j1;
          verificationReason = verificationPassed 
            ? `J1=${j1.toFixed(2)} J2=${j2.toFixed(2)} (J2>J1)`
            : `J1=${j1.toFixed(2)} J2=${j2.toFixed(2)} (J2<=J1)`;
        } else if (isBuyPut) {
          // 买入做空标的：J2 < J1
          verificationPassed = j2 < j1;
          verificationReason = verificationPassed 
            ? `J1=${j1.toFixed(2)} J2=${j2.toFixed(2)} (J2<J1)`
            : `J1=${j1.toFixed(2)} J2=${j2.toFixed(2)} (J2>=J1)`;
        }
        
        if (verificationPassed) {
          const actionDesc = isBuyCall ? "买入做多" : "买入做空";
          logger.info(
            `[延迟验证通过] ${pendingSignal.symbol} ${verificationReason}，执行${actionDesc}`
          );
          
          // 获取标的的当前价格和最小买卖单位
          let currentPrice = null;
          let lotSize = null;
          if (isBuyCall && longQuote) {
            currentPrice = longQuote.price;
            lotSize = longQuote.lotSize;
          } else if (isBuyPut && shortQuote) {
            currentPrice = shortQuote.price;
            lotSize = shortQuote.lotSize;
          }
          
          // 获取标的的中文名称
          let symbolName = null;
          if (isBuyCall && longQuote) {
            symbolName = longQuote.name;
          } else if (isBuyPut && shortQuote) {
            symbolName = shortQuote.name;
          }
          
          // 生成买入信号
          const verifiedSignal = {
            symbol: pendingSignal.symbol,
            symbolName: symbolName,
            action: pendingSignal.action,
            reason: `延迟验证通过：${verificationReason}`,
            price: currentPrice,
            lotSize: lotSize,
            signalTriggerTime: pendingSignal.triggerTime, // 信号触发时间
          };
          
          // 添加到交易信号列表
          tradingSignals.push(verifiedSignal);
          hasChange = true;
        } else {
          const actionDesc = isBuyCall ? "买入做多" : "买入做空";
          logger.info(
            `[延迟验证失败] ${pendingSignal.symbol} ${verificationReason}，不执行${actionDesc}`
          );
        }
      } else {
        logger.warn(
          `[延迟验证失败] ${pendingSignal.symbol} 无法获取有效的KDJ J值（J1=${j1}, J2=${j2}）`
        );
      }
      
      // 从待验证列表中移除（无论验证是否通过）
      const index = lastState.pendingDelayedSignals.indexOf(pendingSignal);
      if (index >= 0) {
        lastState.pendingDelayedSignals.splice(index, 1);
      }
    } catch (err) {
      logger.error(
        `[延迟验证错误] 处理待验证信号 ${pendingSignal.symbol} 时发生错误`,
        err?.message ?? err
      );
      // 从待验证列表中移除错误的信号
      const index = lastState.pendingDelayedSignals.indexOf(pendingSignal);
      if (index >= 0) {
        lastState.pendingDelayedSignals.splice(index, 1);
      }
    }
  }
  
  // 检测信号变化
  // 验证信号数组的有效性
  const validSignals = tradingSignals.filter(s => 
    s?.symbol && 
    s?.action && 
    (s.action === SignalType.BUYCALL || s.action === SignalType.SELLCALL || 
     s.action === SignalType.BUYPUT || s.action === SignalType.SELLPUT)
  );
  
  const currentSignalKey = validSignals.length > 0
    ? validSignals.map(s => `${s.action}_${s.symbol}_${s.reason || ""}`).join('|')
    : null;
  const lastSignalKey = lastState.signal;
  
  if (currentSignalKey !== lastSignalKey) {
    hasChange = true;
    const lastCandleTime = monitorCandles.at(-1)?.timestamp;
    if (lastCandleTime) {
      logger.info(
        `交易所时间：${lastCandleTime.toLocaleString("zh-CN", {
          timeZone: "Asia/Hong_Kong",
          hour12: false,
        })}`
      );
    }
    
    if (validSignals.length > 0) {
      validSignals.forEach(signal => {
        // 判断信号类型
        let actionDesc = "";
        
        if (signal.action === SignalType.BUYCALL) {
          actionDesc = "买入做多标的（做多）";
        } else if (signal.action === SignalType.SELLCALL) {
          actionDesc = "卖出做多标的（清仓）";
        } else if (signal.action === SignalType.BUYPUT) {
          actionDesc = "买入做空标的（做空）";
        } else if (signal.action === SignalType.SELLPUT) {
          actionDesc = "卖出做空标的（平空仓）";
        } else {
          actionDesc = `未知操作(${signal.action})`;
        }
        
        logger.info(
          `[交易信号] ${actionDesc} ${signal.symbol} - ${signal.reason || "策略信号"}`
        );
      });
    } else {
      logger.info(
        `[监控标的信号] ${monitorSymbolName}(${normalizeHKSymbol(
          monitorSymbol
        )}) 无交易信号`
      );
    }
    
    lastState.signal = currentSignalKey;
  }
  
  // 使用新策略生成的交易信号
  // 过滤并验证信号，只处理有效的信号
  const signals = tradingSignals
    .filter(signal => {
      if (!signal?.symbol || !signal?.action) {
        logger.warn(`[跳过信号] 无效的信号对象: ${JSON.stringify(signal)}`);
        return false;
      }
      const validActions = [
        SignalType.BUYCALL,
        SignalType.SELLCALL,
        SignalType.BUYPUT,
        SignalType.SELLPUT,
      ];
      if (!validActions.includes(signal.action)) {
        logger.warn(`[跳过信号] 未知的信号类型: ${signal.action}, 标的: ${signal.symbol}`);
        return false;
      }
      return true;
    })
    .map(signal => {
      const normalizedSigSymbol = normalizeHKSymbol(signal.symbol);
      
      // 确定价格、lotSize和名称
      let price = null;
      let lotSize = null;
      let symbolName = signal.symbolName || null; // 优先使用信号中的名称
      
      if (normalizedSigSymbol === normalizedLongSymbol && longQuote) {
        price = longQuote.price;
        lotSize = longQuote.lotSize;
        if (!symbolName) {
          symbolName = longQuote.name;
        }
      } else if (normalizedSigSymbol === normalizedShortSymbol && shortQuote) {
        price = shortQuote.price;
        lotSize = shortQuote.lotSize;
        if (!symbolName) {
          symbolName = shortQuote.name;
        }
      }
      
      return {
        ...signal,
        price,
        lotSize,
        symbolName, // 添加名称信息
      };
    });

  // 检查是否需要在收盘前5分钟清仓
  const shouldClearBeforeClose = TRADING_CONFIG.clearPositionsBeforeClose;
  const isBeforeClose = longQuote && isBeforeClose5Minutes(longQuote.timestamp);
  
  let finalSignals = [];
  
  if (shouldClearBeforeClose && isBeforeClose && canTradeNow && Array.isArray(positions) && positions.length > 0) {
    // 当日收盘前5分钟，清空所有持仓（无论是做多标的持仓还是做空标的持仓）
    logger.info("[收盘清仓] 检测到当日收盘前5分钟（15:55-16:00），准备清空所有持仓");
    
    // 为每个持仓生成清仓信号
    const clearSignals = [];
    const normalizedLongSymbol = normalizeHKSymbol(longSymbol);
    const normalizedShortSymbol = normalizeHKSymbol(shortSymbol);
    // 验证 positions 是数组
    if (Array.isArray(positions)) {
      for (const pos of positions) {
        // 验证持仓对象有效性
        if (!pos || !pos.symbol || typeof pos.symbol !== "string") {
          continue; // 跳过无效持仓
        }
        
        const availableQty = Number(pos.availableQuantity) || 0;
        if (!Number.isFinite(availableQty) || availableQty <= 0) {
          continue; // 跳过无效或零持仓
        }
        
        const normalizedPosSymbol = pos.symbol.includes(".") 
          ? pos.symbol 
          : `${pos.symbol}.HK`;
        const isShortPos = normalizedPosSymbol === normalizedShortSymbol;
        
        // 获取该标的的当前价格、最小买卖单位和名称
        let currentPrice = null;
        let lotSize = null;
        let symbolName = pos.symbolName || null; // 优先使用持仓中的名称
        if (normalizedPosSymbol === normalizedLongSymbol && longQuote) {
          currentPrice = longQuote.price;
          lotSize = longQuote.lotSize;
          if (!symbolName) {
            symbolName = longQuote.name;
          }
        } else if (normalizedPosSymbol === normalizedShortSymbol && shortQuote) {
          currentPrice = shortQuote.price;
          lotSize = shortQuote.lotSize;
          if (!symbolName) {
            symbolName = shortQuote.name;
          }
        }
        
        // 收盘前清仓逻辑：
        // - 做多标的持仓：使用 SELLCALL 信号 → OrderSide.Sell（卖出做多标的，清仓）
        // - 做空标的持仓：使用 SELLPUT 信号 → OrderSide.Sell（卖出做空标的，平空仓）
        const action = isShortPos ? SignalType.SELLPUT : SignalType.SELLCALL;
        const positionType = isShortPos ? "做空标的" : "做多标的";
        
        clearSignals.push({
          symbol: pos.symbol,
          symbolName: symbolName, // 添加名称信息
          action: action,
          price: currentPrice, // 添加当前价格，用于增强限价单
          lotSize: lotSize, // 添加最小买卖单位
          reason: `收盘前5分钟自动清仓（${positionType}持仓）`,
          signalTriggerTime: new Date(), // 收盘前清仓信号的触发时间
        });
        
        logger.info(
          `[收盘清仓] 生成清仓信号：${positionType} ${pos.symbol} 数量=${availableQty} 操作=${action}`
        );
      }
    }
    
    if (clearSignals.length > 0) {
      finalSignals = clearSignals;
      logger.info(`[收盘清仓] 共生成 ${clearSignals.length} 个清仓信号，准备执行`);
    }
  } else if (signals.length > 0 && canTradeNow) {
    // 正常交易信号处理
    const riskChecker = new RiskChecker();
    const orderNotional = TRADING_CONFIG.targetNotional;
    for (const sig of signals) {
      // 获取标的的当前价格用于计算持仓市值
      const normalizedSigSymbol = normalizeHKSymbol(sig.symbol);
      const normalizedLongSymbol = normalizeHKSymbol(longSymbol);
      const normalizedShortSymbol = normalizeHKSymbol(shortSymbol);
      
      let currentPrice = null;
      let underlyingPrice = null;
      if (normalizedSigSymbol === normalizedLongSymbol && longQuote) {
        currentPrice = longQuote.price;
      } else if (normalizedSigSymbol === normalizedShortSymbol && shortQuote) {
        currentPrice = shortQuote.price;
      }

      // 检查牛熊证风险（仅在买入时检查，卖出时不检查）
      // 注意：所有操作均无卖空操作，做空是指买入做空标的而非卖空做空标的
      // 
      // 做多和做空操作根据监控标的信号产生：
      //   - BUYCALL → 买入做多标的（做多操作，需要检查牛熊证风险）
      //   - BUYPUT → 买入做空标的（做空操作，需要检查牛熊证风险）
      // 
      // 卖出操作（不检查牛熊证风险）：
      //   - SELLCALL → 卖出做多标的（清仓）
      //   - SELLPUT → 卖出做空标的（平空仓）
      const isBuyAction = sig.action === SignalType.BUYCALL || sig.action === SignalType.BUYPUT;
      
      if (isBuyAction) {
        // 仅在买入时检查牛熊证风险
        // 获取相关资产价格（如果是牛熊证，需要相关资产价格来计算距离回收价的百分比）
        // 这里先尝试获取监控标的的价格作为相关资产价格
        if (monitorQuote?.price) {
          underlyingPrice = monitorQuote.price;
        }
        
        const warrantRiskResult = await riskChecker.checkWarrantRisk(
          sig.symbol,
          marketDataClient,
          underlyingPrice
        );
        
        if (!warrantRiskResult.allowed) {
          // 获取标的的中文名称
          let sigName = sig.symbol;
          if (normalizedSigSymbol === normalizedLongSymbol) {
            sigName = longSymbolName;
          } else if (normalizedSigSymbol === normalizedShortSymbol) {
            sigName = shortSymbolName;
          }
          const codeText = normalizeHKSymbol(sig.symbol);
          logger.warn(
            `[牛熊证风险拦截] 信号被牛熊证风险控制拦截：${sigName}(${codeText}) ${sig.action} - ${warrantRiskResult.reason}`
          );
          continue; // 跳过这个信号，不加入finalSignals
        } else if (warrantRiskResult.warrantInfo?.isWarrant) {
          // 如果是牛熊证且风险检查通过，记录信息
          const warrantType = warrantRiskResult.warrantInfo.warrantType === "BULL" ? "牛证" : "熊证";
          const distancePercent = warrantRiskResult.warrantInfo.distanceToStrikePercent;
          logger.info(
            `[牛熊证风险检查] ${sig.symbol} 为${warrantType}，距离回收价百分比：${distancePercent?.toFixed(2) ?? "未知"}%，风险检查通过`
          );
        }
      }
      // 卖出操作（平仓）时不检查牛熊证风险
      
      // 基础风险检查
      const riskResult = riskChecker.checkBeforeOrder(
        account,
        positions,
        sig,
        orderNotional,
        currentPrice
      );
      if (riskResult.allowed) {
        finalSignals.push(sig);
      } else {
        // 获取标的的中文名称
        const normalizedSigSymbol = normalizeHKSymbol(sig.symbol);
        const normalizedLongSymbol = normalizeHKSymbol(longSymbol);
        const normalizedShortSymbol = normalizeHKSymbol(shortSymbol);
        let sigName = sig.symbol;
        if (normalizedSigSymbol === normalizedLongSymbol) {
          sigName = longSymbolName;
        } else if (normalizedSigSymbol === normalizedShortSymbol) {
          sigName = shortSymbolName;
        }
        const codeText = normalizeHKSymbol(sig.symbol);
        logger.warn(
          `[风险拦截] 信号被风险控制拦截：${sigName}(${codeText}) ${sig.action} - ${riskResult.reason}`
        );
      }
    }
  }

  // 只在有交易信号时显示执行信息（信号变化时已显示）
  if (finalSignals.length > 0) {
    hasChange = true;
    for (const sig of finalSignals) {
      let targetAction = "未知";
      if (sig.action === SignalType.BUYCALL || sig.action === SignalType.BUYPUT) {
        targetAction = "买入";
      } else if (sig.action === SignalType.SELLCALL || sig.action === SignalType.SELLPUT) {
        targetAction = "卖出";
      }
      // 获取标的的中文名称
      const normalizedSigSymbol = normalizeHKSymbol(sig.symbol);
      const normalizedLongSymbol = normalizeHKSymbol(longSymbol);
      const normalizedShortSymbol = normalizeHKSymbol(shortSymbol);
      let sigName = sig.symbol;
      if (normalizedSigSymbol === normalizedLongSymbol) {
        sigName = longSymbolName;
      } else if (normalizedSigSymbol === normalizedShortSymbol) {
        sigName = shortSymbolName;
      }
      const codeText = normalizeHKSymbol(sig.symbol);
      logger.info(
        `[交易指令] 将对 ${sigName}(${codeText}) 执行${targetAction}操作 - ${sig.reason}`
      );
    }
  } else if (signals.length > 0 && !canTradeNow) {
    // 有信号但不在交易时段
    hasChange = true;
    logger.info("当前为竞价或非连续交易时段，交易信号已生成但暂不执行。");
  }

  // 实时监控价格并管理未成交订单
  if (canTradeNow && (longQuote || shortQuote)) {
    await trader.monitorAndManageOrders(longQuote, shortQuote).catch((err) => {
      logger.warn("订单监控失败", err?.message ?? err);
    });
  }

  // 执行交易（只在有信号时显示）
  if (finalSignals.length > 0) {
    hasChange = true;
    logger.info(`执行交易：共 ${finalSignals.length} 个交易信号`);
    await trader.executeSignals(finalSignals);
  }
  
  // 返回是否有数据变化
  return hasChange;
}

async function sleep(ms) {
  const delay = Number(ms);
  if (!Number.isFinite(delay) || delay < 0) {
    logger.warn(`[sleep] 无效的延迟时间 ${ms}，使用默认值 1000ms`);
    return new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function main() {
  // 首先验证配置
  try {
    await validateAllConfig();
  } catch (err) {
    if (err.name === "ConfigValidationError") {
      logger.error("程序启动失败：配置验证未通过");
      process.exit(1);
    } else {
      logger.error("配置验证过程中发生错误", err);
      process.exit(1);
    }
  }

  const config = createConfig();
  const candlePeriod = "1m";
  const candleCount = 200;
  const intervalMs = 1000;

  const marketDataClient = new MarketDataClient(config);
  const strategy = new HangSengMultiIndicatorStrategy();
  const trader = new Trader(config);

  // 获取标的的中文名称用于显示
  const monitorQuote = await marketDataClient
    .getLatestQuote(TRADING_CONFIG.monitorSymbol)
    .catch(() => null);
  const longQuoteForName = await marketDataClient
    .getLatestQuote(TRADING_CONFIG.longSymbol)
    .catch(() => null);
  const shortQuoteForName = await marketDataClient
    .getLatestQuote(TRADING_CONFIG.shortSymbol)
    .catch(() => null);

  const monitorName = monitorQuote?.name ?? TRADING_CONFIG.monitorSymbol;
  const longName = longQuoteForName?.name ?? TRADING_CONFIG.longSymbol;
  const shortName = shortQuoteForName?.name ?? TRADING_CONFIG.shortSymbol;
  logger.info(
    `监控标的: ${monitorName}(${normalizeHKSymbol(TRADING_CONFIG.monitorSymbol)})`
  );
  logger.info(
    `做多标的: ${longName}(${normalizeHKSymbol(TRADING_CONFIG.longSymbol)})`
  );
  logger.info(
    `做空标的: ${shortName}(${normalizeHKSymbol(TRADING_CONFIG.shortSymbol)})`
  );
  logger.info("程序开始运行，在交易时段将进行实时监控和交易（按 Ctrl+C 退出）");

  // 记录上一次的数据状态，用于检测变化
  let lastState = {
    longPrice: null,
    shortPrice: null,
    monitorPrice: null,
    signal: null,
    canTrade: null,
    accountState: null,
    pendingDelayedSignals: [], // 待验证的延迟信号列表
  };

  // 无限循环监控（用户要求不设执行次数上限）
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const hasChange = await runOnce({
        marketDataClient,
        strategy,
        trader,
        candlePeriod,
        candleCount,
        lastState,
      });

      // 更新状态
      if (hasChange) {
        // 状态已更新，继续下一次循环
      }
    } catch (err) {
      logger.error("本次执行失败", err);
    }

    await sleep(intervalMs);
  }
}

main().catch((err) => {
  logger.error("程序异常退出", err);
  process.exit(1);
});


