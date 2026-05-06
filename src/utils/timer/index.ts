/**
 * bounded one-shot timer 工具模块
 *
 * 职责：把未来 epoch 毫秒目标转换为平台安全的 one-shot timer 分段，避免超长 delay 被运行时钳制为立即触发。
 */
import { TIME } from '../../constants/index.js';
import type { BoundedOneShotTimerController, BoundedOneShotTimerParams } from './types.js';

/**
 * 按目标时间注册 bounded one-shot timer。
 *
 * @param params 目标时间、时间源、timer 注入和到期回调
 * @returns 可取消的 timer 控制器
 */
export function scheduleBoundedOneShotAt<TTimerHandle>(
  params: BoundedOneShotTimerParams<TTimerHandle>,
): BoundedOneShotTimerController {
  const { atMs, now, scheduleTimer, clearTimer, onDue } = params;
  if (!Number.isFinite(atMs)) {
    throw new TypeError(`[Timer] one-shot timer 目标时间非法 atMs=${String(atMs)}`);
  }

  let cancelled = false;
  let currentHandle: TTimerHandle | null = null;

  function clearCurrentTimer(): void {
    if (currentHandle === null) {
      return;
    }

    clearTimer(currentHandle);
    currentHandle = null;
  }

  function scheduleNextSegment(): void {
    if (cancelled) {
      return;
    }

    const nowMs = now().getTime();
    const delayMs = atMs <= nowMs ? 0 : Math.min(atMs - nowMs, TIME.MAX_TIMER_DELAY_MS);
    const handle = scheduleTimer(() => {
      if (currentHandle !== handle) {
        return;
      }

      currentHandle = null;
      if (atMs <= now().getTime()) {
        onDue();
        return;
      }

      scheduleNextSegment();
    }, delayMs);
    currentHandle = handle;
  }

  scheduleNextSegment();

  return {
    cancel: () => {
      cancelled = true;
      clearCurrentTimer();
    },
    hasTimer: () => currentHandle !== null,
  };
}
