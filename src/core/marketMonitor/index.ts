/**
 * 行情监控模块
 *
 * 功能：
 * - 监控做多/做空标的价格变化
 * - 监控监控标的的技术指标变化
 * - 格式化显示价格和指标信息
 *
 * 变化检测阈值：
 * - 价格变化：0.0001
 * - RSI/MFI/KDJ 变化：0.1
 * - MACD/EMA 变化：0.0001
 *
 * 显示内容：
 * - 做多/做空标的的现价和涨跌幅
 * - 监控标的的所有技术指标值
 */

import { logger, colors } from '../../utils/logger/index.js';
import {
  normalizeHKSymbol,
  formatQuoteDisplay,
  isValidPositiveNumber,
  toBeijingTimeLog,
} from '../../utils/helpers/index.js';
import { isValidNumber } from '../../utils/indicatorHelpers/index.js';
import { hasChanged } from '../../utils/tradingTime/index.js';
import {
  monitorValuesObjectPool,
  kdjObjectPool,
  macdObjectPool,
} from '../../utils/objectPool/index.js';
import type { Quote, IndicatorSnapshot, MonitorValues, LastState } from '../../types/index.js';
import type { MarketMonitor } from './type.js';

/**
 * 创建行情监控器
 * 监控做多/做空标的价格变化、监控标的指标变化，并格式化显示
 */
export const createMarketMonitor = (): MarketMonitor => {
  /**
   * 显示监控标的的所有指标（内部辅助函数）
   */
  const displayIndicators = (
    monitorSnapshot: IndicatorSnapshot,
    monitorQuote: Quote | null,
    monitorSymbol: string,
    currentPrice: number,
    changePercent: number | null,
    emaPeriods: ReadonlyArray<number>,
    rsiPeriods: ReadonlyArray<number>,
    klineTimestamp: number | null,
  ): void => {
    // 格式化指标值
    const formatIndicator = (value: number | null | undefined, decimals: number = 2): string => {
      if (isValidNumber(value)) {
        return value.toFixed(decimals);
      }
      return '-';
    };

    // 构建指标显示字符串（按照指定顺序：最新价、涨跌幅、EMAn、RSIn、MFI、K、D、J、MACD、DIF、DEA）
    const indicators: string[] = [];

    // 1. 最新价
    if (Number.isFinite(currentPrice)) {
      indicators.push(`价格=${currentPrice.toFixed(3)}`);
    }

    // 2. 涨跌幅（基于上日收盘价）
    if (changePercent !== null) {
      const sign = changePercent >= 0 ? '+' : '';
      indicators.push(`涨跌幅=${sign}${changePercent.toFixed(2)}%`);
    }

    // 3. EMAn（所有配置的EMA周期）
    if (monitorSnapshot.ema) {
      for (const period of emaPeriods) {
        const emaValue = monitorSnapshot.ema[period];
        if (Number.isFinite(emaValue)) {
          indicators.push(`EMA${period}=${formatIndicator(emaValue, 3)}`);
        }
      }
    }

    // 4. RSIn（所有配置的RSI周期）
    if (monitorSnapshot.rsi) {
      for (const period of rsiPeriods) {
        const rsiValue = monitorSnapshot.rsi[period];
        if (Number.isFinite(rsiValue)) {
          indicators.push(`RSI${period}=${formatIndicator(rsiValue, 3)}`);
        }
      }
    }

    // 5. MFI
    if (Number.isFinite(monitorSnapshot.mfi)) {
      indicators.push(`MFI=${formatIndicator(monitorSnapshot.mfi, 3)}`);
    }

    // 6. KDJ（K、D、J三个值）
    if (monitorSnapshot.kdj) {
      const kdj = monitorSnapshot.kdj;
      if (Number.isFinite(kdj.k)) {
        indicators.push(`K=${formatIndicator(kdj.k, 3)}`);
      }
      if (Number.isFinite(kdj.d)) {
        indicators.push(`D=${formatIndicator(kdj.d, 3)}`);
      }
      if (Number.isFinite(kdj.j)) {
        indicators.push(`J=${formatIndicator(kdj.j, 3)}`);
      }
    }

    // 7. MACD（MACD、DIF、DEA三个值）
    if (monitorSnapshot.macd) {
      const macd = monitorSnapshot.macd;
      if (Number.isFinite(macd.macd)) {
        indicators.push(
          `MACD=${formatIndicator(macd.macd, 3)}`,
        );
      }
      if (Number.isFinite(macd.dif)) {
        indicators.push(`DIF=${formatIndicator(macd.dif, 3)}`);
      }
      if (Number.isFinite(macd.dea)) {
        indicators.push(`DEA=${formatIndicator(macd.dea, 3)}`);
      }
    }

    const normalizedMonitorSymbol = normalizeHKSymbol(monitorSymbol);
    const monitorSymbolName = monitorQuote?.name ?? monitorSymbol;

    // 格式化K线时间戳（仅显示时分秒）
    const timePrefix = klineTimestamp && Number.isFinite(klineTimestamp)
      ? `[K线时间: ${toBeijingTimeLog(new Date(klineTimestamp)).split(' ')[1]}] `
      : '';

    logger.info(
      `${colors.cyan}${timePrefix}[监控标的] ${monitorSymbolName}(${normalizedMonitorSymbol}) ${indicators.join(
        ' ',
      )}${colors.reset}`,
    );
  };

  return {
    monitorPriceChanges: (
      longQuote: Quote | null,
      shortQuote: Quote | null,
      longSymbol: string,
      shortSymbol: string,
      lastState: LastState,
    ): boolean => {
      const longPrice = longQuote?.price;
      const shortPrice = shortQuote?.price;

      // 检查做多标的价格是否变化（阈值：0.0001）
      const longPriceChanged =
        lastState.longPrice == null && Number.isFinite(longPrice)
          ? true // 首次出现价格
          : hasChanged(longPrice ?? null, lastState.longPrice ?? null, 0.0001);

      // 检查做空标的价格是否变化（阈值：0.0001）
      const shortPriceChanged =
        lastState.shortPrice == null && Number.isFinite(shortPrice)
          ? true // 首次出现价格
          : hasChanged(shortPrice ?? null, lastState.shortPrice ?? null, 0.0001);

      if (longPriceChanged || shortPriceChanged) {
        // 显示做多标的行情
        const longDisplay = formatQuoteDisplay(longQuote, longSymbol);
        if (longDisplay) {
          // 格式化K线时间戳（仅显示时分秒）
          const longTimePrefix = longQuote?.timestamp && Number.isFinite(longQuote.timestamp)
            ? `[K线时间: ${toBeijingTimeLog(new Date(longQuote.timestamp)).split(' ')[1]}] `
            : '';
          logger.info(
            `${longTimePrefix}[做多标的] ${longDisplay.nameText}(${longDisplay.codeText}) 最新价格=${longDisplay.priceText} 涨跌额=${longDisplay.changeAmountText} 涨跌幅度=${longDisplay.changePercentText}`,
          );
        } else {
          logger.warn('未获取到做多标的行情。');
        }

        // 显示做空标的行情
        const shortDisplay = formatQuoteDisplay(shortQuote, shortSymbol);
        if (shortDisplay) {
          // 格式化K线时间戳（仅显示时分秒）
          const shortTimePrefix = shortQuote?.timestamp && Number.isFinite(shortQuote.timestamp)
            ? `[K线时间: ${toBeijingTimeLog(new Date(shortQuote.timestamp)).split(' ')[1]}] `
            : '';
          logger.info(
            `${shortTimePrefix}[做空标的] ${shortDisplay.nameText}(${shortDisplay.codeText}) 最新价格=${shortDisplay.priceText} 涨跌额=${shortDisplay.changeAmountText} 涨跌幅度=${shortDisplay.changePercentText}`,
          );
        } else {
          logger.warn('未获取到做空标的行情。');
        }

        // 更新价格状态（只更新有效价格，避免将 undefined 写入状态）
        if (Number.isFinite(longPrice)) {
          lastState.longPrice = longPrice ?? null;
        }
        if (Number.isFinite(shortPrice)) {
          lastState.shortPrice = shortPrice ?? null;
        }

        return true; // 价格发生变化
      }

      return false; // 价格未变化
    },

    monitorIndicatorChanges: (
      monitorSnapshot: IndicatorSnapshot | null,
      monitorQuote: Quote | null,
      monitorSymbol: string,
      emaPeriods: ReadonlyArray<number>,
      rsiPeriods: ReadonlyArray<number>,
      lastState: LastState,
    ): boolean => {
      if (!monitorSnapshot) {
        return false;
      }

      const currentPrice = monitorSnapshot.price;

      // 从行情数据中获取上日收盘价
      const prevClose = monitorQuote?.prevClose ?? null;

      // 计算涨跌幅（基于上日收盘价）
      let changePercent: number | null = null;
      if (
        Number.isFinite(currentPrice) &&
        currentPrice > 0 &&
        Number.isFinite(prevClose) &&
        prevClose !== null &&
        prevClose > 0
      ) {
        changePercent = ((currentPrice - prevClose) / prevClose) * 100;
      }

      // 检测指标变化（检查所有指标是否发生变化）
      let hasIndicatorChanged = false;

      // 检查价格变化
      const lastPrice = lastState.monitorValues?.price;
      if (
        (lastPrice == null && isValidPositiveNumber(currentPrice)) ||
        hasChanged(currentPrice, lastPrice ?? null, 0.0001)
      ) {
        hasIndicatorChanged = true;
      }

      // 检查涨跌幅变化
      const lastChangePercent = lastState.monitorValues?.changePercent;
      if (!hasIndicatorChanged && changePercent !== null) {
        if (lastChangePercent == null || hasChanged(changePercent, lastChangePercent, 0.01)) {
          // 涨跌幅变化阈值：0.01%
          hasIndicatorChanged = true;
        }
      }

      // 检查EMA变化
      if (!hasIndicatorChanged && monitorSnapshot.ema) {
        for (const period of emaPeriods) {
          const currentEma = monitorSnapshot.ema[period];
          const lastEma = lastState.monitorValues?.ema?.[period];
          if (
            Number.isFinite(currentEma) &&
            (lastEma == null || hasChanged(currentEma, lastEma, 0.0001))
          ) {
            hasIndicatorChanged = true;
            break;
          }
        }
      }

      // 检查RSI变化
      if (!hasIndicatorChanged && monitorSnapshot.rsi) {
        for (const period of rsiPeriods) {
          const currentRsi = monitorSnapshot.rsi[period];
          const lastRsi = lastState.monitorValues?.rsi?.[period];
          if (
            Number.isFinite(currentRsi) &&
            (lastRsi == null || hasChanged(currentRsi, lastRsi, 0.1))
          ) {
            hasIndicatorChanged = true;
            break;
          }
        }
      }

      // 检查MFI变化
      if (!hasIndicatorChanged) {
        const lastMfi = lastState.monitorValues?.mfi;
        if (
          Number.isFinite(monitorSnapshot.mfi) &&
          (lastMfi == null || hasChanged(monitorSnapshot.mfi, lastMfi, 0.1))
        ) {
          hasIndicatorChanged = true;
        }
      }

      // 检查KDJ变化
      if (!hasIndicatorChanged && monitorSnapshot.kdj) {
        const lastKdj = lastState.monitorValues?.kdj;
        const kdj = monitorSnapshot.kdj;
        if (
          (Number.isFinite(kdj.k) && (lastKdj?.k == null || hasChanged(kdj.k, lastKdj.k, 0.1))) ||
          (Number.isFinite(kdj.d) && (lastKdj?.d == null || hasChanged(kdj.d, lastKdj.d, 0.1))) ||
          (Number.isFinite(kdj.j) && (lastKdj?.j == null || hasChanged(kdj.j, lastKdj.j, 0.1)))
        ) {
          hasIndicatorChanged = true;
        }
      }

      // 检查MACD变化
      if (!hasIndicatorChanged && monitorSnapshot.macd) {
        const lastMacd = lastState.monitorValues?.macd;
        const macd = monitorSnapshot.macd;
        if (
          (Number.isFinite(macd.macd) && (lastMacd?.macd == null || hasChanged(macd.macd, lastMacd.macd, 0.0001))) ||
          (Number.isFinite(macd.dif) && (lastMacd?.dif == null || hasChanged(macd.dif, lastMacd.dif, 0.0001))) ||
          (Number.isFinite(macd.dea) && (lastMacd?.dea == null || hasChanged(macd.dea, lastMacd.dea, 0.0001)))
        ) {
          hasIndicatorChanged = true;
        }
      }

      // 如果任何指标发生变化，则显示所有指标
      if (hasIndicatorChanged) {
        displayIndicators(
          monitorSnapshot,
          monitorQuote,
          monitorSymbol,
          currentPrice,
          changePercent,
          emaPeriods,
          rsiPeriods,
          monitorQuote?.timestamp ?? null,
        );

        // 如果存在旧的 monitorValues，先释放其中的 kdj 和 macd 对象，再释放 monitorValues 本身
        if (lastState.monitorValues) {
          // 释放旧的 kdj 对象到对象池
          if (lastState.monitorValues.kdj) {
            kdjObjectPool.release(lastState.monitorValues.kdj);
          }
          // 释放旧的 macd 对象到对象池
          if (lastState.monitorValues.macd) {
            macdObjectPool.release(lastState.monitorValues.macd);
          }
          // 释放 monitorValues 对象本身
          monitorValuesObjectPool.release(lastState.monitorValues);
        }

        // 从对象池获取新的监控值对象
        const newMonitorValues = monitorValuesObjectPool.acquire() as MonitorValues;
        newMonitorValues.price = currentPrice;
        newMonitorValues.changePercent = changePercent;
        newMonitorValues.ema = monitorSnapshot.ema
          ? { ...monitorSnapshot.ema }
          : null;
        newMonitorValues.rsi = monitorSnapshot.rsi
          ? { ...monitorSnapshot.rsi }
          : null;
        newMonitorValues.mfi = monitorSnapshot.mfi;
        // 创建 kdj 和 macd 对象的浅拷贝，避免直接引用对象池中的对象
        // 这样可以防止对象池回收时数据被意外修改
        const kdjData = monitorSnapshot.kdj;
        const macdData = monitorSnapshot.macd;
        newMonitorValues.kdj = kdjData
          ? { k: kdjData.k, d: kdjData.d, j: kdjData.j }
          : null;
        newMonitorValues.macd = macdData
          ? { dif: macdData.dif, dea: macdData.dea, macd: macdData.macd }
          : null;

        lastState.monitorValues = newMonitorValues;

        return true; // 指标发生变化
      }

      return false; // 指标未变化
    },
  };
};
