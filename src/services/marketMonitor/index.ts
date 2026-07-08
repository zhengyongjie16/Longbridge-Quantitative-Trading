/**
 * marketMonitor 模块
 *
 * 职责：
 * - 作为终端显示纯渲染器，直接格式化并输出 monitor indicators / trading quote
 * - 不再承担任何本地变化检测与显示缓存所有权
 */
import { logger } from '../../utils/logger/index.js';
import { toHongKongTimeLog } from '../../utils/time/index.js';
import { isValidNumber, parseIndicatorPeriod } from '../../utils/indicatorHelpers/index.js';
import {
  formatQuoteDisplay,
  formatPositionDisplay,
  formatWarrantDistanceDisplay,
} from './utils.js';
import { LOG_COLORS } from '../../constants/index.js';
import type { DisplayIndicatorItem, IndicatorUsageProfile } from '../../types/indicatorProfile.js';
import type { IndicatorSnapshot, Quote } from '../../types/quote.js';
import type {
  CompiledDisplayPlan,
  CompiledDisplayPlanItem,
  MarketMonitor,
  RenderMonitorIndicatorsParams,
  RenderTradingQuoteParams,
} from './types.js';

const compiledDisplayPlanCache = new WeakMap<IndicatorUsageProfile, CompiledDisplayPlan>();

function formatKlineTimePrefix(timestamp: number | null | undefined): string {
  if (timestamp && Number.isFinite(timestamp)) {
    const timeText = toHongKongTimeLog(new Date(timestamp));
    return `[K线时间: ${timeText.split(' ')[1]}] `;
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
  if (cached !== undefined) {
    return cached;
  }

  const items: CompiledDisplayPlanItem[] = [];

  for (const item of indicatorProfile.displayPlan) {
    const compiledItem = compileDisplayPlanItem(item);
    if (compiledItem === null) {
      continue;
    }

    items.push(compiledItem);
  }

  const compiledPlan: CompiledDisplayPlan = {
    items,
  };
  compiledDisplayPlanCache.set(indicatorProfile, compiledPlan);
  return compiledPlan;
}

function getSnapshotDisplayValue(params: {
  readonly compiledItem: CompiledDisplayPlanItem;
  readonly snapshot: IndicatorSnapshot;
  readonly currentPrice: number | null;
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
      return assertUnreachable(compiledItem);
    }
  }
}

function formatIndicator(value: number | null | undefined, decimals: number = 2): string {
  if (isValidNumber(value)) {
    return value.toFixed(decimals);
  }

  return '-';
}

function calculateChangePercent(
  currentPrice: number | null,
  prevClose: number | null,
): number | null {
  if (
    currentPrice === null ||
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0 ||
    prevClose === null ||
    !Number.isFinite(prevClose) ||
    prevClose <= 0
  ) {
    return null;
  }

  return ((currentPrice - prevClose) / prevClose) * 100;
}

function resolveTradingQuoteLabel(direction: RenderTradingQuoteParams['direction']): string {
  return direction === 'LONG' ? '做多标的' : '做空标的';
}

function resolveDisplayQuote(params: RenderTradingQuoteParams): Quote | null {
  if (params.event.symbol !== params.tradingSymbol) {
    return null;
  }

  return params.event.quote;
}

function renderTradingQuote(params: RenderTradingQuoteParams): void {
  const label = resolveTradingQuoteLabel(params.direction);
  const quote = resolveDisplayQuote(params);
  const display = formatQuoteDisplay(quote, params.tradingSymbol);
  if (display === null) {
    logger.warn(`未获取到${label}行情。`);
    return;
  }

  const timePrefix = formatKlineTimePrefix(quote?.timestamp);
  const distanceText = formatWarrantDistanceDisplay(
    params.displayInfo?.warrantDistanceInfo ?? null,
  );
  const distanceSuffix = distanceText ? ` ${distanceText}` : '';
  const positionText = formatPositionDisplay(
    params.displayInfo?.unrealizedLossMetrics ?? null,
    params.displayInfo?.orderCount ?? null,
  );
  logger.info(
    `${timePrefix}[${label}] ${display.nameText}(${display.codeText}) 最新价格=${display.priceText} 涨跌额=${display.changeAmountText} 涨跌幅度=${display.changePercentText}${distanceSuffix} ${positionText}`,
  );
}

/**
 * 渲染监控标的指标日志。
 * 直接根据 displayPlan 读取当前 snapshot 与实时 quote，不保留本地比较状态。
 *
 * @param params monitor snapshot、monitor quote、monitorSymbol、indicatorProfile 与 K 线时间
 */
function renderMonitorIndicators(params: RenderMonitorIndicatorsParams): void {
  const compiledPlan = getCompiledDisplayPlan(params.indicatorProfile);
  const currentPrice = params.monitorQuote?.price ?? null;
  const prevClose = params.monitorQuote?.prevClose ?? null;
  const changePercent = calculateChangePercent(currentPrice, prevClose);
  const indicators: string[] = [];

  for (const compiledItem of compiledPlan.items) {
    if (compiledItem.kind === 'price') {
      if (currentPrice !== null && Number.isFinite(currentPrice)) {
        indicators.push(`价格=${currentPrice.toFixed(3)}`);
      } else {
        indicators.push('价格=-');
      }

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
      snapshot: params.monitorSnapshot,
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

  const monitorSymbolName = params.monitorQuote?.name ?? params.monitorSymbol;
  const timePrefix = formatKlineTimePrefix(params.klineTimestamp);
  logger.info(
    `${LOG_COLORS.cyan}${timePrefix}[监控标的] ${monitorSymbolName}(${params.monitorSymbol}) ${indicators.join(' ')}${LOG_COLORS.reset}`,
  );
}

export function createMarketMonitor(): MarketMonitor {
  return {
    renderTradingQuote,
    renderMonitorIndicators,
  };
}
