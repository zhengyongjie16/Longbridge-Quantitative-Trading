/**
 * 启动门禁模块
 *
 * 功能：
 * - 控制程序启动流程，确保在满足交易日、交易时段与开盘保护条件后才继续执行
 * - 提供阻塞式等待方法 wait()，在条件不满足时自动休眠并重试
 * - 支持开发模式（skip）跳过检查快速启动
 *
 * 状态流转：
 * - 'notTradingDay': 今天不是交易日，等待开市
 * - 'outOfSession': 当前不在连续交易时段，等待开市
 * - 'openProtection': 处于开盘保护期内，等待保护期结束
 * - 'ready': 所有条件满足，可以继续执行
 */
import type { StartupGate, StartupGateDeps, StartupGateState } from './types.js';

/**
 * 创建启动门禁实例。
 * 返回的 wait() 方法会阻塞直到满足交易日、交易时段和开盘保护三个条件，
 * 开发模式（skip）下跳过所有检查直接返回。
 *
 * @param deps 依赖注入，包含时间解析、会话判断、开盘保护配置等
 * @returns StartupGate 接口，包含 wait() 方法用于等待条件满足
 */
export function createStartupGate(deps: StartupGateDeps): StartupGate {
  const {
    now,
    sleep,
    resolveTradingDayInfo,
    isInSession,
    isInMorningOpenProtection,
    isInAfternoonOpenProtection,
    openProtection,
    intervalMs,
    logger,
  } = deps;

  let startupGateState: StartupGateState = null;

  // 避免重复输出相同状态日志
  function logState(state: StartupGateState, message: string): void {
    if (startupGateState !== state) {
      startupGateState = state;
      logger.info(message);
    }
  }

  /**
   * 等待满足交易时段与开盘保护条件。
   * 轮询直至为交易日、处于连续交易时段且不在开盘保护期内；skip 模式直接返回。
   *
   * @param params.mode 门禁模式：strict 严格检查交易日与时段，skip 跳过检查直接返回
   * @returns 满足条件时返回当日交易日信息（isTradingDay、isHalfDay）
   */
  async function wait({ mode }: { readonly mode: 'strict' | 'skip' }): Promise<{
    isTradingDay: boolean;
    isHalfDay: boolean;
  }> {
    if (mode === 'skip') {
      logger.info('[启动门禁] 开发模式跳过交易时段检查');
      return { isTradingDay: true, isHalfDay: false };
    }

    while (true) {
      const currentTime = now();
      const tradingDayInfo = await resolveTradingDayInfo(currentTime);

      if (!tradingDayInfo.isTradingDay) {
        logState('notTradingDay', '今天不是交易日，等待开市...');
        await sleep(intervalMs);
        continue;
      }

      const inSession = isInSession(currentTime, tradingDayInfo.isHalfDay);
      if (!inSession) {
        logState('outOfSession', '当前不在连续交易时段，等待开市...');
        await sleep(intervalMs);
        continue;
      }

      const { morning, afternoon } = openProtection;

      const morningProtectionActive =
        morning.enabled &&
        morning.minutes != null &&
        isInMorningOpenProtection(currentTime, morning.minutes);

      const afternoonProtectionActive =
        !tradingDayInfo.isHalfDay &&
        afternoon.enabled &&
        afternoon.minutes != null &&
        isInAfternoonOpenProtection(currentTime, afternoon.minutes);

      if (morningProtectionActive || afternoonProtectionActive) {
        const message = morningProtectionActive
          ? `[开盘保护] 早盘开盘后 ${morning.minutes} 分钟内等待启动`
          : `[开盘保护] 午盘开盘后 ${afternoon.minutes} 分钟内等待启动`;
        logState('openProtection', message);
        await sleep(intervalMs);
        continue;
      }

      logState('ready', '交易时段门禁通过，继续初始化');
      return tradingDayInfo;
    }
  }

  return { wait };
}
