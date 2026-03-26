/**
 * 行情监控模块
 *
 * 功能：
 * - 监控做多/做空标的价格变化
 * - 监控监控标的的技术指标变化
 * - 将监控标的的指标快照复制到本地 MonitorValues 缓存（通过对象池管理），格式化显示价格和指标信息
 *
 * 变化检测阈值（定义在 constants/index.ts 的 MONITOR 常量中）：
 * - 价格变化：MONITOR.PRICE_CHANGE_THRESHOLD
 * - 技术指标变化（EMA/RSI/PSY/MFI/KDJ/MACD/ADX）：MONITOR.INDICATOR_CHANGE_THRESHOLD
 *
 * 对象池与快照解耦：
 * - monitorSnapshot 由指标流水线缓存管理，可能被对象池复用或回收
 * - monitorValues 持有的是 monitorSnapshot 的一份深拷贝（通过 periodRecordPool/kdjObjectPool/macdObjectPool 等），避免引用被回收的对象
 * - 每次检测到指标变化时，会先释放旧的 monitorValues，再从对象池获取新对象并复制当前快照
 *
 * 显示内容：
 * - 做多/做空标的的现价和涨跌幅
 * - 做多/做空标的的距回收价、持仓市值、持仓盈亏、订单数量
 * - 监控标的按指标画像 displayPlan 的技术指标值（仅显示实际使用的指标）
 */
import { logger } from '../../utils/logger/index.js';
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import { toHongKongTimeLog } from '../../utils/time/index.js';
import { isValidNumber, parseIndicatorPeriod } from '../../utils/indicatorHelpers/index.js';
import {
  formatQuoteDisplay,
  formatPositionDisplay,
  formatWarrantDistanceDisplay,
  hasChanged,
} from './utils.js';
import {
  acquireMonitorValues,
  kdjObjectPool,
  macdObjectPool,
  monitorValuesObjectPool,
  periodRecordPool,
} from '../../utils/objectPool/index.js';
import { LOG_COLORS, MONITOR } from '../../constants/index.js';
import type { DisplayIndicatorItem, IndicatorUsageProfile } from '../../types/indicatorProfile.js';
import type { MonitorState } from '../../types/state.js';
import type { IndicatorSnapshot, Quote, KDJIndicator, MACDIndicator } from '../../types/quote.js';
import type { MonitorValues } from '../../types/data.js';
import type {
  CompiledDisplayPlan,
  CompiledDisplayPlanItem,
  MarketMonitor,
  MonitorIndicatorChangesParams,
  PriceDisplayInfo,
} from './types.js';

const compiledDisplayPlanCache = new WeakMap<IndicatorUsageProfile, CompiledDisplayPlan>();

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

function parsePeriodDisplayItem(
  item: DisplayIndicatorItem,
  prefix: 'EMA:' | 'RSI:' | 'PSY:',
): number | null {
  return parseIndicatorPeriod({ indicatorName: item, prefix });
}

function compileDisplayPlanItem(item: DisplayIndicatorItem): CompiledDisplayPlanItem | null {
  if (item === 'price') {
    return { item, kind: 'price' };
  }

  if (item === 'changePercent') {
    return { item, kind: 'changePercent' };
  }

  if (item === 'MFI') {
    return { item, kind: 'mfi' };
  }

  if (item === 'K') {
    return { item, kind: 'kdj', field: 'k' };
  }

  if (item === 'D') {
    return { item, kind: 'kdj', field: 'd' };
  }

  if (item === 'J') {
    return { item, kind: 'kdj', field: 'j' };
  }

  if (item === 'ADX') {
    return { item, kind: 'adx' };
  }

  if (item === 'MACD') {
    return { item, kind: 'macd', field: 'macd' };
  }

  if (item === 'DIF') {
    return { item, kind: 'macd', field: 'dif' };
  }

  if (item === 'DEA') {
    return { item, kind: 'macd', field: 'dea' };
  }

  const emaPeriod = parsePeriodDisplayItem(item, 'EMA:');
  if (emaPeriod !== null) {
    return { item, kind: 'ema', period: emaPeriod };
  }

  const rsiPeriod = parsePeriodDisplayItem(item, 'RSI:');
  if (rsiPeriod !== null) {
    return { item, kind: 'rsi', period: rsiPeriod };
  }

  const psyPeriod = parsePeriodDisplayItem(item, 'PSY:');
  if (psyPeriod !== null) {
    return { item, kind: 'psy', period: psyPeriod };
  }

  return null;
}

function assertUnreachable(value: never): never {
  throw new Error(`Unexpected compiled display plan item: ${JSON.stringify(value)}`);
}

function getCompiledDisplayPlan(indicatorProfile: IndicatorUsageProfile): CompiledDisplayPlan {
  const cached = compiledDisplayPlanCache.get(indicatorProfile);
  if (cached) {
    return cached;
  }

  const items: CompiledDisplayPlanItem[] = [];
  const emaPeriods: number[] = [];
  const rsiPeriods: number[] = [];
  const psyPeriods: number[] = [];
  let needsMfi = false;
  let needsAdx = false;
  let needsKdj = false;
  let needsMacd = false;

  for (const item of indicatorProfile.displayPlan) {
    const compiledItem = compileDisplayPlanItem(item);
    if (!compiledItem) {
      continue;
    }

    items.push(compiledItem);
    switch (compiledItem.kind) {
      case 'ema': {
        emaPeriods.push(compiledItem.period);
        break;
      }

      case 'rsi': {
        rsiPeriods.push(compiledItem.period);
        break;
      }

      case 'psy': {
        psyPeriods.push(compiledItem.period);
        break;
      }

      case 'mfi': {
        needsMfi = true;
        break;
      }

      case 'adx': {
        needsAdx = true;
        break;
      }

      case 'kdj': {
        needsKdj = true;
        break;
      }

      case 'macd': {
        needsMacd = true;
        break;
      }

      case 'price':
      case 'changePercent': {
        break;
      }

      default: {
        return assertUnreachable(compiledItem);
      }
    }
  }

  const compiled: CompiledDisplayPlan = {
    items,
    emaPeriods,
    rsiPeriods,
    psyPeriods,
    needsMfi,
    needsAdx,
    needsKdj,
    needsMacd,
  };
  compiledDisplayPlanCache.set(indicatorProfile, compiled);
  return compiled;
}

/**
 * 按展示计划复制周期指标记录，仅保留实际会参与变化检测的周期。
 * @param params.periods 需要保留的周期列表
 * @param params.snapshot 周期指标快照
 * @returns 复制后的周期记录；若展示计划不需要任何周期值则返回 null
 */
function copyDisplayPeriodRecord(params: {
  readonly periods: ReadonlyArray<number>;
  readonly snapshot: Readonly<Record<number, number>> | null;
}): Readonly<Record<number, number>> | null {
  const { periods, snapshot } = params;
  if (!snapshot) {
    return null;
  }

  const filteredRecord = periodRecordPool.acquire();
  let hasValue = false;
  for (const period of periods) {
    const value = snapshot[period];
    if (value === undefined) {
      continue;
    }

    filteredRecord[period] = value;
    hasValue = true;
  }

  if (hasValue) {
    return filteredRecord;
  }

  periodRecordPool.release(filteredRecord);
  return null;
}

/**
 * 按展示计划复制 KDJ 指标对象。
 * @param needsKdj 展示计划是否需要 KDJ 字段
 * @param kdjData KDJ 快照
 * @returns 复制后的 KDJ 对象；若展示计划不需要 KDJ 或值无效则返回 null
 */
function copyDisplayKdj(needsKdj: boolean, kdjData: IndicatorSnapshot['kdj']): KDJIndicator | null {
  if (!kdjData || !needsKdj) {
    return null;
  }

  const kdjRecord = kdjObjectPool.acquire();
  kdjRecord.k = kdjData.k;
  kdjRecord.d = kdjData.d;
  kdjRecord.j = kdjData.j;
  if (isValidPooledKdj(kdjRecord)) {
    return kdjRecord;
  }

  kdjObjectPool.release(kdjRecord);
  return null;
}

/**
 * 按展示计划复制 MACD 指标对象。
 * @param needsMacd 展示计划是否需要 MACD 字段
 * @param macdData MACD 快照
 * @returns 复制后的 MACD 对象；若展示计划不需要 MACD 或值无效则返回 null
 */
function copyDisplayMacd(
  needsMacd: boolean,
  macdData: IndicatorSnapshot['macd'],
): MACDIndicator | null {
  if (!macdData || !needsMacd) {
    return null;
  }

  const macdRecord = macdObjectPool.acquire();
  macdRecord.dif = macdData.dif;
  macdRecord.dea = macdData.dea;
  macdRecord.macd = macdData.macd;
  if (isValidPooledMacd(macdRecord)) {
    return macdRecord;
  }

  macdObjectPool.release(macdRecord);
  return null;
}

/**
 * 按展示计划构建 monitorValues 缓存，仅保存后续变化检测所需字段。
 * @param params 当前价格、涨跌幅、指标快照与展示计划
 * @returns 用于 monitorState 的缓存对象
 */
function buildMonitorValuesFromDisplayPlan(params: {
  readonly compiledPlan: CompiledDisplayPlan;
  readonly monitorSnapshot: IndicatorSnapshot;
  readonly currentPrice: number;
  readonly changePercent: number | null;
}): MonitorValues {
  const { compiledPlan, monitorSnapshot, currentPrice, changePercent } = params;
  const monitorValues = acquireMonitorValues();
  monitorValues.price = currentPrice;
  monitorValues.changePercent = changePercent;
  monitorValues.ema = copyDisplayPeriodRecord({
    periods: compiledPlan.emaPeriods,
    snapshot: monitorSnapshot.ema,
  });

  monitorValues.rsi = copyDisplayPeriodRecord({
    periods: compiledPlan.rsiPeriods,
    snapshot: monitorSnapshot.rsi,
  });

  monitorValues.psy = copyDisplayPeriodRecord({
    periods: compiledPlan.psyPeriods,
    snapshot: monitorSnapshot.psy,
  });
  monitorValues.mfi = compiledPlan.needsMfi ? monitorSnapshot.mfi : null;
  monitorValues.adx = compiledPlan.needsAdx ? monitorSnapshot.adx : null;
  monitorValues.kdj = copyDisplayKdj(compiledPlan.needsKdj, monitorSnapshot.kdj);
  monitorValues.macd = copyDisplayMacd(compiledPlan.needsMacd, monitorSnapshot.macd);
  return monitorValues;
}

/**
 * 读取展示项在当前快照中的值。
 * @param params 展示项读取参数
 * @returns 数值型展示值，缺失时返回 null
 */
function getSnapshotDisplayValue(params: {
  readonly compiledItem: CompiledDisplayPlanItem;
  readonly snapshot: IndicatorSnapshot;
  readonly currentPrice: number;
  readonly changePercent: number | null;
}): number | null {
  const { compiledItem, snapshot, currentPrice, changePercent } = params;
  switch (compiledItem.kind) {
    case 'price': {
      return Number.isFinite(currentPrice) ? currentPrice : null;
    }

    case 'changePercent': {
      return changePercent !== null && Number.isFinite(changePercent) ? changePercent : null;
    }

    case 'mfi': {
      return Number.isFinite(snapshot.mfi) ? snapshot.mfi : null;
    }

    case 'kdj': {
      const value = snapshot.kdj?.[compiledItem.field];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    case 'adx': {
      return Number.isFinite(snapshot.adx) ? snapshot.adx : null;
    }

    case 'macd': {
      const value = snapshot.macd?.[compiledItem.field];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    case 'ema': {
      const value = snapshot.ema?.[compiledItem.period];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    case 'rsi': {
      const value = snapshot.rsi?.[compiledItem.period];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    case 'psy': {
      const value = snapshot.psy?.[compiledItem.period];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    default: {
      return null;
    }
  }
}

/**
 * 读取展示项在 monitorValues 缓存中的上一次值。
 * @param monitorValues monitorState 中缓存的展示值对象
 * @param item 展示项
 * @returns 上一次展示值，缺失时返回 null
 */
function getCachedDisplayValue(
  monitorValues: MonitorValues | null,
  compiledItem: CompiledDisplayPlanItem,
): number | null {
  if (!monitorValues) {
    return null;
  }

  switch (compiledItem.kind) {
    case 'price': {
      return Number.isFinite(monitorValues.price) ? monitorValues.price : null;
    }

    case 'changePercent': {
      return Number.isFinite(monitorValues.changePercent) ? monitorValues.changePercent : null;
    }

    case 'mfi': {
      return Number.isFinite(monitorValues.mfi) ? monitorValues.mfi : null;
    }

    case 'kdj': {
      const value = monitorValues.kdj?.[compiledItem.field];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    case 'adx': {
      return Number.isFinite(monitorValues.adx) ? monitorValues.adx : null;
    }

    case 'macd': {
      const value = monitorValues.macd?.[compiledItem.field];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    case 'ema': {
      const value = monitorValues.ema?.[compiledItem.period];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    case 'rsi': {
      const value = monitorValues.rsi?.[compiledItem.period];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    case 'psy': {
      const value = monitorValues.psy?.[compiledItem.period];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    default: {
      return null;
    }
  }
}

/**
 * 返回展示项对应的变化阈值。
 * @param item 展示项
 * @returns 变化阈值
 */
function resolveDisplayThreshold(item: DisplayIndicatorItem): number {
  if (item === 'price') {
    return MONITOR.PRICE_CHANGE_THRESHOLD;
  }

  if (item === 'changePercent') {
    return MONITOR.CHANGE_PERCENT_THRESHOLD;
  }

  return MONITOR.INDICATOR_CHANGE_THRESHOLD;
}

/**
 * 将标的行情与距回收价信息格式化并输出到日志。
 * @param quote - 行情数据，可为 null
 * @param symbol - 标的代码
 * @param label - 显示标签（如「做多标的」）
 * @param displayInfo - 展示附加信息（距回收价、持仓市值/持仓盈亏、订单数量）
 * @returns void
 */
function displayQuoteInfo(
  quote: Quote | null,
  symbol: string,
  label: string,
  displayInfo: PriceDisplayInfo | null,
): void {
  const display = formatQuoteDisplay(quote, symbol);
  if (display) {
    const timePrefix = formatKlineTimePrefix(quote?.timestamp);
    const distanceText = formatWarrantDistanceDisplay(displayInfo?.warrantDistanceInfo ?? null);
    const distanceSuffix = distanceText ? ` ${distanceText}` : '';
    const positionRealtimeText = formatPositionDisplay(
      displayInfo?.unrealizedLossMetrics ?? null,
      displayInfo?.orderCount ?? null,
    );
    logger.info(
      `${timePrefix}[${label}] ${display.nameText}(${display.codeText}) 最新价格=${display.priceText} 涨跌额=${display.changeAmountText} 涨跌幅度=${display.changePercentText}${distanceSuffix} ${positionRealtimeText}`,
    );
  } else {
    logger.warn(`未获取到${label}行情。`);
  }
}

/**
 * 将监控值对象及其嵌套的 ema/rsi/psy/kdj/macd 归还对象池，避免泄漏。
 * @param monitorValues - 当前缓存的 MonitorValues，可为 null
 * @returns void
 */
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

/**
 * 将指标数值格式化为固定小数位字符串，无效值返回 '-'。
 * @param value - 指标值
 * @param decimals - 小数位数，默认 2
 * @returns 格式化字符串或 '-'
 */
function formatIndicator(value: number | null | undefined, decimals: number = 2): string {
  if (isValidNumber(value)) {
    return value.toFixed(decimals);
  }

  return '-';
}

/**
 * 类型守卫：判断对象池 KDJ 记录是否具备有效数值（用于安全写入到 MonitorValues）。
 * @param record 对象池获取的 KDJ 记录
 * @returns 具备有效 k/d/j 时返回 true
 */
function isValidPooledKdj(record: {
  readonly k: number | null;
  readonly d: number | null;
  readonly j: number | null;
}): record is KDJIndicator {
  return isValidNumber(record.k) && isValidNumber(record.d) && isValidNumber(record.j);
}

/**
 * 类型守卫：判断对象池 MACD 记录是否具备有效数值（用于安全写入到 MonitorValues）。
 * @param record 对象池获取的 MACD 记录
 * @returns 具备有效 macd/dif/dea 时返回 true
 */
function isValidPooledMacd(record: {
  readonly macd: number | null;
  readonly dif: number | null;
  readonly dea: number | null;
}): record is MACDIndicator {
  return isValidNumber(record.macd) && isValidNumber(record.dif) && isValidNumber(record.dea);
}

/**
 * 按 indicatorProfile.displayPlan 组装并输出监控标的指标行。
 *
 * @param params 含 monitorSnapshot、monitorQuote、指标画像、klineTimestamp 等
 * @returns 无返回值
 */
function displayIndicators(params: {
  readonly monitorSnapshot: IndicatorSnapshot;
  readonly monitorQuote: Quote | null;
  readonly monitorSymbol: string;
  readonly currentPrice: number;
  readonly changePercent: number | null;
  readonly compiledPlan: CompiledDisplayPlan;
  readonly klineTimestamp: number | null;
}): void {
  const {
    monitorSnapshot,
    monitorQuote,
    monitorSymbol,
    currentPrice,
    changePercent,
    compiledPlan,
    klineTimestamp,
  } = params;

  const indicators: string[] = [];

  for (const compiledItem of compiledPlan.items) {
    if (compiledItem.kind === 'price') {
      indicators.push(Number.isFinite(currentPrice) ? `价格=${currentPrice.toFixed(3)}` : '价格=-');
      continue;
    }

    if (compiledItem.kind === 'changePercent') {
      if (changePercent !== null && Number.isFinite(changePercent)) {
        const sign = changePercent >= 0 ? '+' : '';
        indicators.push(`涨跌幅=${sign}${changePercent.toFixed(2)}%`);
      } else {
        indicators.push('涨跌幅=-');
      }

      continue;
    }

    const value = getSnapshotDisplayValue({
      compiledItem,
      snapshot: monitorSnapshot,
      currentPrice,
      changePercent,
    });
    if (value === null) {
      continue;
    }

    switch (compiledItem.kind) {
      case 'ema': {
        indicators.push(`EMA${compiledItem.period}=${formatIndicator(value, 3)}`);
        break;
      }

      case 'rsi': {
        indicators.push(`RSI${compiledItem.period}=${formatIndicator(value, 3)}`);
        break;
      }

      case 'psy': {
        indicators.push(`PSY${compiledItem.period}=${formatIndicator(value, 3)}`);
        break;
      }

      case 'mfi':
      case 'adx':
      case 'kdj':
      case 'macd': {
        indicators.push(`${compiledItem.item}=${formatIndicator(value, 3)}`);
        break;
      }

      default: {
        assertUnreachable(compiledItem);
      }
    }
  }

  const monitorSymbolName = monitorQuote?.name ?? monitorSymbol;

  // 格式化K线时间戳（仅显示时分秒）
  const timePrefix = formatKlineTimePrefix(klineTimestamp);

  logger.info(
    `${LOG_COLORS.cyan}${timePrefix}[监控标的] ${monitorSymbolName}(${monitorSymbol}) ${indicators.join(' ')}${LOG_COLORS.reset}`,
  );
}

/**
 * 创建行情监控器，供主循环每 tick 调用以检测价格与指标变化并输出到控制台。
 * 职责：监控做多/做空标的价格变化、监控标的指标变化，并格式化显示；变化超过阈值时更新状态并打日志。
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
      longDisplayInfo: PriceDisplayInfo | null = null,
      shortDisplayInfo: PriceDisplayInfo | null = null,
    ): boolean => {
      const longPrice = longQuote?.price;
      const shortPrice = shortQuote?.price;

      // 检查做多标的价格是否变化
      const longPriceChanged =
        monitorState.longPrice === null && Number.isFinite(longPrice)
          ? true // 首次出现价格
          : hasChanged(
              longPrice ?? null,
              monitorState.longPrice ?? null,
              MONITOR.PRICE_CHANGE_THRESHOLD,
            );

      // 检查做空标的价格是否变化
      const shortPriceChanged =
        monitorState.shortPrice === null && Number.isFinite(shortPrice)
          ? true // 首次出现价格
          : hasChanged(
              shortPrice ?? null,
              monitorState.shortPrice ?? null,
              MONITOR.PRICE_CHANGE_THRESHOLD,
            );

      if (longPriceChanged || shortPriceChanged) {
        displayQuoteInfo(longQuote, longSymbol, '做多标的', longDisplayInfo);
        displayQuoteInfo(shortQuote, shortSymbol, '做空标的', shortDisplayInfo);

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
    monitorIndicatorChanges: (params: MonitorIndicatorChangesParams): boolean => {
      const {
        monitorSnapshot,
        monitorQuote,
        monitorSymbol,
        indicatorProfile,
        klineTimestamp,
        monitorState,
      } = params;

      if (!monitorSnapshot) {
        return false;
      }

      const compiledPlan = getCompiledDisplayPlan(indicatorProfile);
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

      let hasIndicatorChanged = false;
      for (const compiledItem of compiledPlan.items) {
        const currentValue = getSnapshotDisplayValue({
          compiledItem,
          snapshot: monitorSnapshot,
          currentPrice,
          changePercent,
        });
        if (currentValue === null) {
          continue;
        }

        const lastValue = getCachedDisplayValue(monitorState.monitorValues, compiledItem);
        if (
          compiledItem.kind === 'price' &&
          lastValue === null &&
          isValidPositiveNumber(currentValue)
        ) {
          hasIndicatorChanged = true;
          break;
        }

        if (
          lastValue === null ||
          hasChanged(currentValue, lastValue, resolveDisplayThreshold(compiledItem.item))
        ) {
          hasIndicatorChanged = true;
          break;
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
          compiledPlan,
          klineTimestamp,
        });

        releaseMonitorValuesObjects(monitorState.monitorValues);

        monitorState.monitorValues = buildMonitorValuesFromDisplayPlan({
          compiledPlan,
          monitorSnapshot,
          currentPrice,
          changePercent,
        });

        return true; // 指标发生变化
      }

      return false; // 指标未变化
    },
  };
}
