import type { StartupGate, StartupGateDeps } from './types.js';

type StartupGateState = 'notTradingDay' | 'outOfSession' | 'openProtection' | 'ready' | null;

export function createStartupGate(deps: StartupGateDeps): StartupGate {
  const {
    now,
    sleep,
    resolveTradingDayInfo,
    isInSession,
    isInOpenProtection,
    openProtection,
    intervalMs,
    logger,
  } = deps;

  let startupGateState: StartupGateState = null;

  function logState(state: StartupGateState, message: string): void {
    if (startupGateState !== state) {
      startupGateState = state;
      logger.info(message);
    }
  }

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

      const openProtectionActive =
        openProtection.enabled &&
        openProtection.minutes != null &&
        isInOpenProtection(currentTime, openProtection.minutes);
      if (openProtectionActive) {
        logState(
          'openProtection',
          `[开盘保护] 早盘开盘后 ${openProtection.minutes} 分钟内等待启动`,
        );
        await sleep(intervalMs);
        continue;
      }

      logState('ready', '交易时段门禁通过，继续初始化');
      return tradingDayInfo;
    }
  }

  return { wait };
}
