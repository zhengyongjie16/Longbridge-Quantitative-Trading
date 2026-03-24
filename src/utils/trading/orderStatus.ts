import type { CancelOrderOutcome } from '../../types/trader.js';

/**
 * 将撤单结果格式化为稳定的日志标签。
 *
 * @param outcome 撤单结果
 * @returns 用于日志与错误原因输出的稳定标签字符串
 */
export function formatCancelOutcomeTag(outcome: CancelOrderOutcome): string {
  if (outcome.kind === 'ALREADY_CLOSED') {
    return `${outcome.kind}:${outcome.closedReason}`;
  }

  if (outcome.kind === 'RETRYABLE_FAILURE' || outcome.kind === 'UNKNOWN_FAILURE') {
    return `${outcome.kind}:${outcome.errorCode ?? 'UNKNOWN'}`;
  }

  return outcome.kind;
}

/**
 * 判断撤单结果是否为「撤单请求已被接受」或「已确认非成交终态」。
 *
 * @param outcome 撤单结果
 * @returns true 表示可停止继续发起撤单，且不会把 FILLED 误判为撤单成功
 */
export function isCancelAcceptedOrTerminalNonFilledClose(outcome: CancelOrderOutcome): boolean {
  if (outcome.kind === 'CANCEL_CONFIRMED') {
    return true;
  }

  return isTerminalNonFilledCloseConfirmed(outcome);
}

/**
 * 判断撤单结果是否已确认「非成交关闭」终态。
 *
 * @param outcome 撤单结果
 * @returns true 表示订单已被权威确认为非成交终态
 */
export function isTerminalNonFilledCloseConfirmed(outcome: CancelOrderOutcome): boolean {
  return (
    outcome.kind === 'ALREADY_CLOSED' &&
    (outcome.closedReason === 'CANCELED' || outcome.closedReason === 'REJECTED')
  );
}
