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
import { isValidNumber } from '../../utils/helpers/indicatorHelpers.js';
import { hasChanged } from '../../utils/helpers/tradingTime.js';
import {
  monitorValuesObjectPool,
  kdjObjectPool,
  macdObjectPool,
} from '../../utils/objectPool/index.js';
import type { Quote, IndicatorSnapshot, MonitorValues, MonitorState } from '../../types/index.js';
import type { MarketMonitor } from './types.js';

/**
 * 创建行情监控器
 * 监控做多/做空标的价格变化、监控标的指标变化，并格式化显示
 */
export const createMarketMonitor = (): MarketMonitor => {
  /**
   * 格式化K线时间戳为日志前缀（仅显示时分秒）
   * @param timestamp 时间戳（毫秒）
   * @returns 格式化的时间前缀字符串，如 "[K线时间: 10:30:15] " 或空字符串
   */
  const formatKlineTimePrefix = (timestamp: number | null | undefined): string => {
    // 保持与原实现一致：timestamp 为 0 时不显示
    if (timestamp && Number.isFinite(timestamp)) {
      const timeStr = toBeijingTimeLog(new Date(timestamp));
      return `[K线时间: ${timeStr.split(' ')[1]}] `;
    }
    return '';
  };

  /**
   * 显示标的行情信息
   * @param quote 行情数据
   * @param symbol 标的代码
   * @param label 标的类型标签（如 "做多标的"、"做空标的"）
   */
  const displayQuoteInfo = (
    quote: Quote | null,
    symbol: string,
    label: string,
  ): void => {
    const display = formatQuoteDisplay(quote, symbol);
    if (display) {
      const timePrefix = formatKlineTimePrefix(quote?.timestamp);
      logger.info(
        `${timePrefix}[${label}] ${display.nameText}(${display.codeText}) 最新价格=${display.priceText} 涨跌额=${display.changeAmountText} 涨跌幅度=${display.changePercentText}`,
      );
    } else {
      logger.warn(`未获取到${label}行情。`);
    }
  };

  /**
   * 添加周期指标到显示列表
   * @param indicators 显示列表
   * @param indicatorData 指标数据（如 ema 或 rsi）
   * @param periods 周期数组
   * @param indicatorName 指标名称（如 "EMA"、"RSI"）
   * @param decimals 小数位数
   */
  const addPeriodIndicators = (
    indicators: string[],
    indicatorData: Record<number, number> | null | undefined,
    periods: ReadonlyArray<number>,
    indicatorName: string,
    decimals: number = 3,
  ): void => {
    if (!indicatorData) return;

    for (const period of periods) {
      const value = indicatorData[period];
      if (typeof value === 'number' && Number.isFinite(value)) {
        indicators.push(`${indicatorName}${period}=${value.toFixed(decimals)}`);
      }
    }
  };

  /**
   * 释放旧的监控值对象及其嵌套对象
   * @param monitorValues 旧的监控值对象
   */
  const releaseMonitorValuesObjects = (monitorValues: MonitorValues | null): void => {
    if (!monitorValues) return;

    // 释放嵌套的 kdj 对象到对象池
    if (monitorValues.kdj) {
      kdjObjectPool.release(monitorValues.kdj);
    }
    // 释放嵌套的 macd 对象到对象池
    if (monitorValues.macd) {
      macdObjectPool.release(monitorValues.macd);
    }
    // 释放 monitorValues 对象本身
    monitorValuesObjectPool.release(monitorValues);
  };

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
    addPeriodIndicators(indicators, monitorSnapshot.ema, emaPeriods, 'EMA', 3);

    // 4. RSIn（所有配置的RSI周期）
    addPeriodIndicators(indicators, monitorSnapshot.rsi, rsiPeriods, 'RSI', 3);

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
    const timePrefix = formatKlineTimePrefix(klineTimestamp);

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
      monitorState: MonitorState,
    ): boolean => {
      const longPrice = longQuote?.price;
      const shortPrice = shortQuote?.price;

      // 检查做多标的价格是否变化（阈值：0.0001）
      const longPriceChanged =
        monitorState.longPrice == null && Number.isFinite(longPrice)
          ? true // 首次出现价格
          : hasChanged(longPrice ?? null, monitorState.longPrice ?? null, 0.0001);

      // 检查做空标的价格是否变化（阈值：0.0001）
      const shortPriceChanged =
        monitorState.shortPrice == null && Number.isFinite(shortPrice)
          ? true // 首次出现价格
          : hasChanged(shortPrice ?? null, monitorState.shortPrice ?? null, 0.0001);

      if (longPriceChanged || shortPriceChanged) {
        displayQuoteInfo(longQuote, longSymbol, '做多标的');
        displayQuoteInfo(shortQuote, shortSymbol, '做空标的');

        // 更新价格状态（只更新有效价格，避免将 undefined 写入状态）
        if (Number.isFinite(longPrice)) {
          monitorState.longPrice = longPrice ?? null;
        }
        if (Number.isFinite(shortPrice)) {
          monitorState.shortPrice = shortPrice ?? null;
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
      monitorState: MonitorState,
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
      const lastPrice = monitorState.monitorValues?.price;
      if (
        (lastPrice == null && isValidPositiveNumber(currentPrice)) ||
        hasChanged(currentPrice, lastPrice ?? null, 0.0001)
      ) {
        hasIndicatorChanged = true;
      }

      // 检查涨跌幅变化
      const lastChangePercent = monitorState.monitorValues?.changePercent;
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
          const lastEma = monitorState.monitorValues?.ema?.[period];
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
          const lastRsi = monitorState.monitorValues?.rsi?.[period];
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
        const lastMfi = monitorState.monitorValues?.mfi;
        if (
          Number.isFinite(monitorSnapshot.mfi) &&
          (lastMfi == null || hasChanged(monitorSnapshot.mfi, lastMfi, 0.1))
        ) {
          hasIndicatorChanged = true;
        }
      }

      // 检查KDJ变化
      if (!hasIndicatorChanged && monitorSnapshot.kdj) {
        const lastKdj = monitorState.monitorValues?.kdj;
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
        const lastMacd = monitorState.monitorValues?.macd;
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

        releaseMonitorValuesObjects(monitorState.monitorValues);

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

        monitorState.monitorValues = newMonitorValues;

        return true; // 指标发生变化
      }

      return false; // 指标未变化
    },
  };
};
