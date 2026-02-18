/**
 * 行情监控模块
 *
 * 功能：
 * - 监控做多/做空标的价格变化
 * - 监控监控标的的技术指标变化
 * - 格式化显示价格和指标信息
 *
 * 变化检测阈值（定义在 constants/index.ts 的 MONITOR 常量中）：
 * - 价格变化：MONITOR.PRICE_CHANGE_THRESHOLD
 * - 技术指标变化（EMA/RSI/PSY/MFI/KDJ/MACD）：MONITOR.INDICATOR_CHANGE_THRESHOLD
 *
 * 显示内容：
 * - 做多/做空标的的现价和涨跌幅
 * - 监控标的的所有技术指标值
 */
import { colors, logger } from '../../utils/logger/index.js';
import {
  formatQuoteDisplay,
  isValidPositiveNumber,
  toHongKongTimeLog,
} from '../../utils/helpers/index.js';
import { isValidNumber } from '../../utils/helpers/indicatorHelpers.js';
import { copyPeriodRecord, formatWarrantDistanceDisplay, hasChanged, indicatorChanged } from './utils.js';
import {
  kdjObjectPool,
  macdObjectPool,
  monitorValuesObjectPool,
  periodRecordPool,
} from '../../utils/objectPool/index.js';
import { MONITOR } from '../../constants/index.js';
import type { MonitorState } from '../../types/state.js';
import type { IndicatorSnapshot, Quote } from '../../types/quote.js';
import type { MonitorValues } from '../../types/data.js';
import type { WarrantDistanceInfo } from '../../types/services.js';
import { MarketMonitor } from './types.js';

/**
 * 格式化K线时间戳为日志前缀（仅显示时分秒）
 * @param timestamp 时间戳（毫秒），为 0 或 falsy 时不显示
 * @returns 格式化的时间前缀字符串，如 "[K线时间: 10:30:15] " 或空字符串
 */
function formatKlineTimePrefix(timestamp: number | null | undefined): string {
  if (timestamp && Number.isFinite(timestamp)) {
    const timeStr = toHongKongTimeLog(new Date(timestamp));
    return `[K线时间: ${timeStr.split(' ')[1]}] `;
  }
  return '';
}

/** 添加周期指标到显示列表 */
function addPeriodIndicators(
  indicators: string[],
  indicatorData: Record<number, number> | null | undefined,
  periods: ReadonlyArray<number>,
  indicatorName: string,
  decimals: number = 3,
): void {
  if (!indicatorData) return;

  for (const period of periods) {
    const value = indicatorData[period];
    if (typeof value === 'number' && Number.isFinite(value)) {
      indicators.push(`${indicatorName}${period}=${value.toFixed(decimals)}`);
    }
  }
}

/** 显示标的行情信息 */
function displayQuoteInfo(
  quote: Quote | null,
  symbol: string,
  label: string,
  warrantDistanceInfo: WarrantDistanceInfo | null,
): void {
  const display = formatQuoteDisplay(quote, symbol);
  if (display) {
    const timePrefix = formatKlineTimePrefix(quote?.timestamp);
    const distanceText = formatWarrantDistanceDisplay(warrantDistanceInfo);
    const distanceSuffix = distanceText ? ` ${distanceText}` : '';
    logger.info(
      `${timePrefix}[${label}] ${display.nameText}(${display.codeText}) 最新价格=${display.priceText} 涨跌额=${display.changeAmountText} 涨跌幅度=${display.changePercentText}${distanceSuffix}`,
    );
  } else {
    logger.warn(`未获取到${label}行情。`);
  }
}

/** 释放旧的监控值对象及其嵌套对象 */
function releaseMonitorValuesObjects(monitorValues: MonitorValues | null): void {
  if (!monitorValues) return;

  if (monitorValues.ema) {
    periodRecordPool.release(monitorValues.ema);
  }
  if (monitorValues.rsi) {
    periodRecordPool.release(monitorValues.rsi);
  }
  if (monitorValues.psy) {
    periodRecordPool.release(monitorValues.psy);
  }
  if (monitorValues.kdj) {
    kdjObjectPool.release(monitorValues.kdj);
  }
  if (monitorValues.macd) {
    macdObjectPool.release(monitorValues.macd);
  }
  monitorValuesObjectPool.release(monitorValues);
}

/** 格式化指标值 */
function formatIndicator(value: number | null | undefined, decimals: number = 2): string {
  if (isValidNumber(value)) {
    return value.toFixed(decimals);
  }
  return '-';
}

/** 显示监控标的的所有指标 */
function displayIndicators(params: {
  readonly monitorSnapshot: IndicatorSnapshot;
  readonly monitorQuote: Quote | null;
  readonly monitorSymbol: string;
  readonly currentPrice: number;
  readonly changePercent: number | null;
  readonly emaPeriods: ReadonlyArray<number>;
  readonly rsiPeriods: ReadonlyArray<number>;
  readonly psyPeriods: ReadonlyArray<number>;
  readonly klineTimestamp: number | null;
}): void {
  const { monitorSnapshot, monitorQuote, monitorSymbol, currentPrice, changePercent, emaPeriods, rsiPeriods, psyPeriods, klineTimestamp } = params;

  // 构建指标显示字符串（按照指定顺序：最新价、涨跌幅、EMAn、RSIn、MFI、PSY、K、D、J、MACD、DIF、DEA）
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

  // 6. PSY（所有配置的PSY周期）
  addPeriodIndicators(indicators, monitorSnapshot.psy, psyPeriods, 'PSY', 3);

  // 7. KDJ（K、D、J三个值）
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

  // 8. MACD（MACD、DIF、DEA三个值）
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

  const monitorSymbolName = monitorQuote?.name ?? monitorSymbol;

  // 格式化K线时间戳（仅显示时分秒）
  const timePrefix = formatKlineTimePrefix(klineTimestamp);

  logger.info(
    `${colors.cyan}${timePrefix}[监控标的] ${monitorSymbolName}(${monitorSymbol}) ${indicators.join(
      ' ',
    )}${colors.reset}`,
  );
}

/**
 * 创建行情监控器
 * 监控做多/做空标的价格变化、监控标的指标变化，并格式化显示
 */
export function createMarketMonitor(): MarketMonitor {
  return {
    /**
     * 检测做多/做空标的价格变化，变化时打印行情并更新状态。
     * 首次出现有效价格也视为变化，确保启动后立即输出一次行情。
     */
    monitorPriceChanges: (
      longQuote: Quote | null,
      shortQuote: Quote | null,
      longSymbol: string,
      shortSymbol: string,
      monitorState: MonitorState,
      longWarrantDistanceInfo: WarrantDistanceInfo | null = null,
      shortWarrantDistanceInfo: WarrantDistanceInfo | null = null,
    ): boolean => {
      const longPrice = longQuote?.price;
      const shortPrice = shortQuote?.price;

      // 检查做多标的价格是否变化
      const longPriceChanged =
        monitorState.longPrice == null && Number.isFinite(longPrice)
          ? true // 首次出现价格
          : hasChanged(longPrice ?? null, monitorState.longPrice ?? null, MONITOR.PRICE_CHANGE_THRESHOLD);

      // 检查做空标的价格是否变化
      const shortPriceChanged =
        monitorState.shortPrice == null && Number.isFinite(shortPrice)
          ? true // 首次出现价格
          : hasChanged(shortPrice ?? null, monitorState.shortPrice ?? null, MONITOR.PRICE_CHANGE_THRESHOLD);

      if (longPriceChanged || shortPriceChanged) {
        displayQuoteInfo(longQuote, longSymbol, '做多标的', longWarrantDistanceInfo);
        displayQuoteInfo(shortQuote, shortSymbol, '做空标的', shortWarrantDistanceInfo);

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

    /**
     * 检测监控标的技术指标变化，变化时打印全量指标并通过对象池更新状态缓存。
     * 任意指标（价格、涨跌幅、EMA/RSI/PSY/MFI/KDJ/MACD）超过阈值即触发显示与状态更新。
     */
    monitorIndicatorChanges: (
      monitorSnapshot: IndicatorSnapshot | null,
      monitorQuote: Quote | null,
      monitorSymbol: string,
      emaPeriods: ReadonlyArray<number>,
      rsiPeriods: ReadonlyArray<number>,
      psyPeriods: ReadonlyArray<number>,
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
        hasChanged(currentPrice, lastPrice ?? null, MONITOR.PRICE_CHANGE_THRESHOLD)
      ) {
        hasIndicatorChanged = true;
      }

      // 检查涨跌幅变化
      const lastChangePercent = monitorState.monitorValues?.changePercent;
      if (!hasIndicatorChanged && changePercent !== null) {
        if (lastChangePercent == null || hasChanged(changePercent, lastChangePercent, MONITOR.CHANGE_PERCENT_THRESHOLD)) {
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
            (lastEma == null || hasChanged(currentEma, lastEma, MONITOR.INDICATOR_CHANGE_THRESHOLD))
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
            (lastRsi == null || hasChanged(currentRsi, lastRsi, MONITOR.INDICATOR_CHANGE_THRESHOLD))
          ) {
            hasIndicatorChanged = true;
            break;
          }
        }
      }

      // 检查PSY变化
      if (!hasIndicatorChanged && monitorSnapshot.psy) {
        for (const period of psyPeriods) {
          const currentPsy = monitorSnapshot.psy[period];
          const lastPsy = monitorState.monitorValues?.psy?.[period];
          if (
            Number.isFinite(currentPsy) &&
            (lastPsy == null || hasChanged(currentPsy, lastPsy, MONITOR.INDICATOR_CHANGE_THRESHOLD))
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
          (lastMfi == null || hasChanged(monitorSnapshot.mfi, lastMfi, MONITOR.INDICATOR_CHANGE_THRESHOLD))
        ) {
          hasIndicatorChanged = true;
        }
      }

      // 检查KDJ变化
      if (!hasIndicatorChanged && monitorSnapshot.kdj) {
        const lastKdj = monitorState.monitorValues?.kdj;
        const kdj = monitorSnapshot.kdj;
        const threshold = MONITOR.INDICATOR_CHANGE_THRESHOLD;
        if (
          indicatorChanged(kdj.k, lastKdj?.k, threshold) ||
          indicatorChanged(kdj.d, lastKdj?.d, threshold) ||
          indicatorChanged(kdj.j, lastKdj?.j, threshold)
        ) {
          hasIndicatorChanged = true;
        }
      }

      // 检查MACD变化
      if (!hasIndicatorChanged && monitorSnapshot.macd) {
        const lastMacd = monitorState.monitorValues?.macd;
        const macd = monitorSnapshot.macd;
        const threshold = MONITOR.INDICATOR_CHANGE_THRESHOLD;
        if (
          indicatorChanged(macd.macd, lastMacd?.macd, threshold) ||
          indicatorChanged(macd.dif, lastMacd?.dif, threshold) ||
          indicatorChanged(macd.dea, lastMacd?.dea, threshold)
        ) {
          hasIndicatorChanged = true;
        }
      }

      // 如果任何指标发生变化，则显示所有指标
      if (hasIndicatorChanged) {
        displayIndicators({
          monitorSnapshot,
          monitorQuote,
          monitorSymbol,
          currentPrice,
          changePercent,
          emaPeriods,
          rsiPeriods,
          psyPeriods,
          klineTimestamp: monitorQuote?.timestamp ?? null,
        });

        releaseMonitorValuesObjects(monitorState.monitorValues);

        // 从对象池获取新的监控值对象
        const newMonitorValues = monitorValuesObjectPool.acquire();
        newMonitorValues.price = currentPrice;
        newMonitorValues.changePercent = changePercent;

        // 从对象池获取 ema/rsi/psy 对象，复制值
        newMonitorValues.ema = copyPeriodRecord(periodRecordPool, monitorSnapshot.ema);
        newMonitorValues.rsi = copyPeriodRecord(periodRecordPool, monitorSnapshot.rsi);
        newMonitorValues.psy = copyPeriodRecord(periodRecordPool, monitorSnapshot.psy);

        newMonitorValues.mfi = monitorSnapshot.mfi;

        // 从对象池获取 kdj 和 macd 对象，复制值
        // 避免直接引用对象池中的对象，防止对象池回收时数据被意外修改
        const kdjData = monitorSnapshot.kdj;
        if (kdjData) {
          const kdjRecord = kdjObjectPool.acquire();
          kdjRecord.k = kdjData.k;
          kdjRecord.d = kdjData.d;
          kdjRecord.j = kdjData.j;
          newMonitorValues.kdj = kdjRecord;
        } else {
          newMonitorValues.kdj = null;
        }

        const macdData = monitorSnapshot.macd;
        if (macdData) {
          const macdRecord = macdObjectPool.acquire();
          macdRecord.dif = macdData.dif;
          macdRecord.dea = macdData.dea;
          macdRecord.macd = macdData.macd;
          newMonitorValues.macd = macdRecord;
        } else {
          newMonitorValues.macd = null;
        }

        monitorState.monitorValues = newMonitorValues as MonitorValues;

        return true; // 指标发生变化
      }

      return false; // 指标未变化
    },
  };
}
