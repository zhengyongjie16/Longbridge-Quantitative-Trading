/**
 * app 运行时标的校验组装模块
 *
 * 职责：
 * - 解析监控标的对应的双向 READY 席位标的
 * - 按规则收集运行时标的校验输入并执行去重
 */
import type {
  PushRuntimeValidationSymbolParams,
  ResolveSeatSymbolsByMonitorParams,
  ResolvedSeatSymbols,
  MutableRuntimeValidationCollector,
  RuntimeValidationCollector,
  RuntimeValidationCollectionParams,
} from './types.js';
import { shouldSkipRuntimeValidationSymbol } from '../utils/utils.js';
import { resolveReadySeatSymbol } from '../main/recovery/seatPreparation.js';

/**
 * 解析指定监控标的的双向就绪席位代码。
 * 默认行为：仅返回 READY 席位的 symbol，非 READY 返回 null。
 *
 * @param params 解析参数，包含 symbolRegistry 与 monitorSymbol
 * @returns 当前监控标的的 longSeatSymbol/shortSeatSymbol
 */
function resolveSeatSymbolsByMonitor(
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
function pushRuntimeValidationSymbol(params: PushRuntimeValidationSymbolParams): void {
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

/**
 * 创建运行时标的校验收集器。
 *
 * @returns 含 requiredSymbols 与 runtimeValidationInputs 的空收集器
 */
function createRuntimeValidationCollector(): MutableRuntimeValidationCollector {
  return {
    requiredSymbols: new Set<string>(),
    runtimeValidationInputs: [],
  };
}

/**
 * 收集监控标的、席位标的与持仓标的的运行时校验输入。
 *
 * @param params 收集所需的配置、席位注册表与持仓缓存
 * @returns 已填充的运行时校验收集器
 */
export function collectRuntimeValidationSymbols(
  params: RuntimeValidationCollectionParams,
): RuntimeValidationCollector {
  const { tradingConfig, symbolRegistry, positions } = params;
  const collector = createRuntimeValidationCollector();

  for (const monitorConfig of tradingConfig.monitors) {
    const index = monitorConfig.originalIndex;
    pushRuntimeValidationSymbol({
      symbol: monitorConfig.monitorSymbol,
      label: `监控标的 ${index}`,
      requireLotSize: false,
      required: true,
      collector,
    });

    const { longSeatSymbol, shortSeatSymbol } = resolveSeatSymbolsByMonitor({
      symbolRegistry,
      monitorSymbol: monitorConfig.monitorSymbol,
    });
    const autoSearchEnabled = monitorConfig.autoSearchConfig.autoSearchEnabled;
    pushRuntimeValidationSymbol({
      symbol: longSeatSymbol,
      label: `做多席位标的 ${index}`,
      requireLotSize: true,
      required: !autoSearchEnabled,
      collector,
    });

    pushRuntimeValidationSymbol({
      symbol: shortSeatSymbol,
      label: `做空席位标的 ${index}`,
      requireLotSize: true,
      required: !autoSearchEnabled,
      collector,
    });
  }

  for (const position of positions) {
    pushRuntimeValidationSymbol({
      symbol: position.symbol,
      label: '持仓标的',
      requireLotSize: false,
      required: false,
      collector,
    });
  }

  return collector;
}
