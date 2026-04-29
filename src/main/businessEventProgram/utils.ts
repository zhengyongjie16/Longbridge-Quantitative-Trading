/**
 * businessEventProgram 工具模块
 *
 * 职责：
 * - 提供普通信号链路内部的展示与日志格式化工具
 */
import { SIGNAL_ACTION_DESCRIPTIONS } from '../../constants/index.js';
import type { SignalType } from '../../types/signal.js';

/**
 * 格式化信号日志。
 *
 * @param signal 包含 action、symbol、symbolName、reason 的信号对象
 * @returns 格式化后的信号日志字符串
 */
export function formatSignalLog(signal: {
  readonly action: SignalType;
  readonly symbol: string;
  readonly symbolName?: string | null;
  readonly reason?: string | null;
}): string {
  const actionDesc = SIGNAL_ACTION_DESCRIPTIONS[signal.action];
  const symbolDisplay = signal.symbolName
    ? `${signal.symbolName}(${signal.symbol})`
    : signal.symbol;
  const reason =
    signal.reason === null || signal.reason === undefined || signal.reason === ''
      ? '策略信号'
      : signal.reason;
  return `${actionDesc} ${symbolDisplay} - ${reason}`;
}
