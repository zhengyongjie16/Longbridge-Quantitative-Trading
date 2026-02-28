/**
 * 启动阶段运行时标的校验模块
 *
 * 职责：
 * - 解析监控标的对应的双向 READY 席位标的
 * - 按规则收集运行时标的校验输入并执行去重
 */
import { resolveReadySeatSymbol } from '../startup/seat.js';
import type {
  PushRuntimeValidationSymbolParams,
  ResolveSeatSymbolsByMonitorParams,
  ResolvedSeatSymbols,
} from './types.js';
import { shouldSkipRuntimeValidationSymbol } from '../../utils/utils.js';

/**
 * 解析指定监控标的的双向就绪席位代码。
 * 默认行为：仅返回 READY 席位的 symbol，非 READY 返回 null。
 *
 * @param params 解析参数，包含 symbolRegistry 与 monitorSymbol
 * @returns 当前监控标的的 longSeatSymbol/shortSeatSymbol
 */
export function resolveSeatSymbolsByMonitor(
  params: ResolveSeatSymbolsByMonitorParams,
): ResolvedSeatSymbols {
  const { symbolRegistry, monitorSymbol } = params;
  return {
    longSeatSymbol: resolveReadySeatSymbol(symbolRegistry, monitorSymbol, 'LONG'),
    shortSeatSymbol: resolveReadySeatSymbol(symbolRegistry, monitorSymbol, 'SHORT'),
  };
}

/**
 * 追加一条运行时标的校验输入（含去重逻辑）。
 * 默认行为：symbol 为空或已收录时跳过；required=true 时写入 requiredSymbols 去重集合。
 *
 * @param params 追加参数，包含 symbol、label、required 标记与收集器
 * @returns 无返回值
 */
export function pushRuntimeValidationSymbol(params: PushRuntimeValidationSymbolParams): void {
  const { symbol, label, requireLotSize, required, collector } = params;
  if (symbol === null || shouldSkipRuntimeValidationSymbol(symbol, collector.requiredSymbols)) {
    return;
  }

  if (required) {
    collector.requiredSymbols.add(symbol);
  }

  collector.runtimeValidationInputs.push({
    symbol,
    label,
    requireLotSize,
    required,
  });
}
