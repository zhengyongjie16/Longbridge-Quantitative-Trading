import type { Candlestick } from 'longport';
import type { CandleData } from '../../src/types/data.js';
import type { IndicatorSnapshot, Quote } from '../../src/types/quote.js';
import { decimalToNumber } from '../../src/utils/helpers/index.js';
import { toHongKongTimeLog } from '../../src/utils/primitives/index.js';
import { formatFiniteNumber } from '../utils.js';
import type {
  ChangeDetectConfig,
  DisplayContext,
  IndicatorPeriods,
  MonitorState,
} from './types.js';

/**
 * 格式化数字文本。默认行为：无效值返回 "-"。
 *
 * @param value 待格式化值
 * @param digits 小数位数
 * @returns 格式化后的文本
 */
function formatNumber(value: number | null | undefined, digits: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '-';
  }
  return value.toFixed(digits);
}

/**
 * 格式化 K 线时间前缀。默认行为：无效时间返回空字符串。
 *
 * @param timestamp 毫秒时间戳
 * @returns 日志前缀文本
 */
export function formatKlineTimePrefix(timestamp: number | null | undefined): string {
  if (timestamp === null || timestamp === undefined || !Number.isFinite(timestamp)) {
    return '';
  }
  const timeText = toHongKongTimeLog(new Date(timestamp));
  const hhmmss = timeText.split(' ')[1] ?? timeText;
  return `[K线时间: ${hhmmss}] `;
}

/**
 * 格式化指标值。默认行为：无效值返回 `-`。
 *
 * @param value 指标值
 * @param decimals 小数位
 * @returns 格式化后的文本
 */
export function formatIndicator(value: number | null | undefined, decimals: number = 3): string {
  return formatFiniteNumber(value, decimals);
}

/**
 * 判断数值是否发生变化。默认行为：任一值为空时做严格不等比较。
 *
 * @param current 当前值
 * @param last 上一次值
 * @param threshold 变化阈值
 * @returns 是否发生变化
 */
export function hasChanged(
  current: number | null | undefined,
  last: number | null | undefined,
  threshold: number,
): boolean {
  if (current === null || current === undefined || last === null || last === undefined) {
    return current !== last;
  }
  if (!Number.isFinite(current) || !Number.isFinite(last)) {
    return false;
  }
  return Math.abs(current - last) > threshold;
}

/**
 * 将 LongPort K 线数组转换为 CandleData。默认行为：字段统一转 number。
 *
 * @param candles LongPort K 线数组
 * @returns CandleData 数组
 */
export function convertToCandleData(
  candles: ReadonlyArray<Candlestick>,
): ReadonlyArray<CandleData> {
  return candles.map((candle) => ({
    high: decimalToNumber(candle.high),
    low: decimalToNumber(candle.low),
    close: decimalToNumber(candle.close),
    open: decimalToNumber(candle.open),
    volume: decimalToNumber(candle.volume),
  }));
}

/**
 * 计算涨跌幅百分比。默认行为：输入无效时返回 null。
 *
 * @param currentPrice 当前价
 * @param prevClose 前收盘价
 * @returns 涨跌幅百分比或 null
 */
export function calculateChangePercent(
  currentPrice: number | null | undefined,
  prevClose: number | null | undefined,
): number | null {
  if (
    currentPrice === null ||
    currentPrice === undefined ||
    prevClose === null ||
    prevClose === undefined
  ) {
    return null;
  }
  if (
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(prevClose) ||
    currentPrice <= 0 ||
    prevClose <= 0
  ) {
    return null;
  }
  return ((currentPrice - prevClose) / prevClose) * 100;
}

/**
 * 检查周期指标记录是否发生变化。默认行为：任一周期命中变化即返回 true。
 *
 * @param current 当前指标记录
 * @param last 上一次指标记录
 * @param periods 周期数组
 * @param threshold 变化阈值
 * @returns 是否发生变化
 */
function hasPeriodRecordChanged(
  current: Readonly<Record<number, number>> | null,
  last: Readonly<Record<number, number>> | null,
  periods: ReadonlyArray<number>,
  threshold: number,
): boolean {
  if (current === null) {
    return false;
  }

  for (const period of periods) {
    const currentValue = current[period];
    const lastValue = last?.[period];
    if (
      currentValue !== undefined &&
      Number.isFinite(currentValue) &&
      (lastValue === undefined || hasChanged(currentValue, lastValue, threshold))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 检查 KDJ 是否发生变化。默认行为：任一分量变化即返回 true。
 *
 * @param current 当前 KDJ
 * @param last 上一次 KDJ
 * @param threshold 变化阈值
 * @returns 是否变化
 */
function hasKdjChanged(
  current: IndicatorSnapshot['kdj'],
  last: IndicatorSnapshot['kdj'],
  threshold: number,
): boolean {
  if (current === null) {
    return false;
  }

  const kChanged =
    Number.isFinite(current.k) &&
    (last?.k === undefined || hasChanged(current.k, last.k, threshold));
  const dChanged =
    Number.isFinite(current.d) &&
    (last?.d === undefined || hasChanged(current.d, last.d, threshold));
  const jChanged =
    Number.isFinite(current.j) &&
    (last?.j === undefined || hasChanged(current.j, last.j, threshold));

  return kChanged || dChanged || jChanged;
}

/**
 * 检查 MACD 是否发生变化。默认行为：任一分量变化即返回 true。
 *
 * @param current 当前 MACD
 * @param last 上一次 MACD
 * @param threshold 变化阈值
 * @returns 是否变化
 */
function hasMacdChanged(
  current: IndicatorSnapshot['macd'],
  last: IndicatorSnapshot['macd'],
  threshold: number,
): boolean {
  if (current === null) {
    return false;
  }

  const macdChanged =
    Number.isFinite(current.macd) &&
    (last?.macd === undefined || hasChanged(current.macd, last.macd, threshold));
  const difChanged =
    Number.isFinite(current.dif) &&
    (last?.dif === undefined || hasChanged(current.dif, last.dif, threshold));
  const deaChanged =
    Number.isFinite(current.dea) &&
    (last?.dea === undefined || hasChanged(current.dea, last.dea, threshold));

  return macdChanged || difChanged || deaChanged;
}

/**
 * 检测当前指标快照是否有必要输出。默认行为：价格、涨跌幅、任一指标变化即触发。
 *
 * @param snapshot 当前指标快照
 * @param quote 当前行情
 * @param state 监控状态
 * @param config 变化检测配置
 * @returns 是否有变化
 */
export function detectIndicatorChanges(
  snapshot: IndicatorSnapshot,
  quote: Quote | null,
  state: MonitorState,
  config: ChangeDetectConfig,
): boolean {
  const changePercent = calculateChangePercent(snapshot.price, quote?.prevClose ?? null);

  if (
    state.lastPrice === null ||
    hasChanged(snapshot.price, state.lastPrice, config.changeThreshold)
  ) {
    return true;
  }
  if (
    changePercent !== null &&
    (state.lastChangePercent === null || hasChanged(changePercent, state.lastChangePercent, 0.01))
  ) {
    return true;
  }

  if (
    hasPeriodRecordChanged(
      snapshot.ema,
      state.lastEma,
      config.indicatorPeriods.emaPeriods,
      config.changeThreshold,
    )
  ) {
    return true;
  }
  if (
    hasPeriodRecordChanged(
      snapshot.rsi,
      state.lastRsi,
      config.indicatorPeriods.rsiPeriods,
      config.changeThreshold,
    )
  ) {
    return true;
  }

  if (
    snapshot.mfi !== null &&
    Number.isFinite(snapshot.mfi) &&
    (state.lastMfi === null || hasChanged(snapshot.mfi, state.lastMfi, config.changeThreshold))
  ) {
    return true;
  }

  if (hasKdjChanged(snapshot.kdj, state.lastKdj, config.changeThreshold)) {
    return true;
  }
  if (hasMacdChanged(snapshot.macd, state.lastMacd, config.changeThreshold)) {
    return true;
  }

  return false;
}

/**
 * 更新监控状态快照。默认行为：按当前快照全量覆盖可记录字段。
 *
 * @param snapshot 当前指标快照
 * @param quote 当前行情
 * @param state 可变监控状态
 * @returns 无返回值
 */
export function updateState(
  snapshot: IndicatorSnapshot,
  quote: Quote | null,
  state: MonitorState,
): void {
  state.lastPrice = snapshot.price;
  state.lastChangePercent = calculateChangePercent(snapshot.price, quote?.prevClose ?? null);
  state.lastEma = snapshot.ema === null ? null : { ...snapshot.ema };
  state.lastRsi = snapshot.rsi === null ? null : { ...snapshot.rsi };
  state.lastMfi = snapshot.mfi;
  state.lastKdj = snapshot.kdj === null ? null : { ...snapshot.kdj };
  state.lastMacd = snapshot.macd === null ? null : { ...snapshot.macd };
}

/**
 * 按主程序顺序构建指标显示片段。默认行为：仅输出有效值字段。
 *
 * @param snapshot 指标快照
 * @param changePercent 涨跌幅
 * @param periods 指标周期配置
 * @returns 指标文本数组
 */
function buildIndicatorSegments(
  snapshot: IndicatorSnapshot,
  changePercent: number | null,
  periods: IndicatorPeriods,
): ReadonlyArray<string> {
  const segments: string[] = [];

  if (Number.isFinite(snapshot.price)) {
    segments.push(`价格=${formatNumber(snapshot.price, 3)}`);
  }

  if (changePercent !== null) {
    const sign = changePercent >= 0 ? '+' : '';
    segments.push(`涨跌幅=${sign}${formatNumber(changePercent, 2)}%`);
  }

  if (snapshot.ema !== null) {
    for (const period of periods.emaPeriods) {
      const value = snapshot.ema[period];
      if (value !== undefined && Number.isFinite(value)) {
        segments.push(`EMA${period}=${formatIndicator(value, 3)}`);
      }
    }
  }

  if (snapshot.rsi !== null) {
    for (const period of periods.rsiPeriods) {
      const value = snapshot.rsi[period];
      if (value !== undefined && Number.isFinite(value)) {
        segments.push(`RSI${period}=${formatIndicator(value, 3)}`);
      }
    }
  }

  if (snapshot.mfi !== null && Number.isFinite(snapshot.mfi)) {
    segments.push(`MFI=${formatIndicator(snapshot.mfi, 3)}`);
  }

  if (snapshot.kdj !== null) {
    if (Number.isFinite(snapshot.kdj.k)) {
      segments.push(`K=${formatIndicator(snapshot.kdj.k, 3)}`);
    }
    if (Number.isFinite(snapshot.kdj.d)) {
      segments.push(`D=${formatIndicator(snapshot.kdj.d, 3)}`);
    }
    if (Number.isFinite(snapshot.kdj.j)) {
      segments.push(`J=${formatIndicator(snapshot.kdj.j, 3)}`);
    }
  }

  if (snapshot.macd !== null) {
    if (Number.isFinite(snapshot.macd.macd)) {
      segments.push(`MACD=${formatIndicator(snapshot.macd.macd, 3)}`);
    }
    if (Number.isFinite(snapshot.macd.dif)) {
      segments.push(`DIF=${formatIndicator(snapshot.macd.dif, 3)}`);
    }
    if (Number.isFinite(snapshot.macd.dea)) {
      segments.push(`DEA=${formatIndicator(snapshot.macd.dea, 3)}`);
    }
  }

  return segments;
}

/**
 * 输出监控日志行。默认行为：按主程序字段顺序输出并附带 K 线时间前缀。
 *
 * @param context 显示上下文
 * @returns 无返回值
 */
export function displayIndicators(context: DisplayContext): void {
  const changePercent = calculateChangePercent(
    context.snapshot.price,
    context.quote?.prevClose ?? null,
  );
  const indicatorSegments = buildIndicatorSegments(
    context.snapshot,
    changePercent,
    context.indicatorPeriods,
  );
  const symbolName = context.quote?.name ?? context.monitorSymbol;
  const timePrefix = formatKlineTimePrefix(context.quote?.timestamp);

  console.log(
    `${timePrefix}[监控标的] ${symbolName}(${context.monitorSymbol}) ${indicatorSegments.join(' ')}`,
  );
}

/**
 * 创建监控状态初始值。默认行为：所有指标缓存均为 null。
 *
 * @returns 初始监控状态
 */
export function createInitialState(): MonitorState {
  return {
    lastPrice: null,
    lastChangePercent: null,
    lastEma: null,
    lastRsi: null,
    lastMfi: null,
    lastKdj: null,
    lastMacd: null,
  };
}
