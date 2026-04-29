/**
 * ordinarySignalGuard 业务测试
 *
 * 功能：验证普通信号入队门禁只复用生命周期、连续交易与末日保护接管语义。
 */
import { describe, expect, it } from 'bun:test';

import { ordinarySignalGuard } from '../../../src/main/ordinarySignalGuard/index.js';

describe('ordinarySignalGuard minimal gate', () => {
  it('allows ordinary signal admission when lifecycle and continuous trading gates are open', () => {
    const allowed = ordinarySignalGuard({
      lastState: {
        isTradingEnabled: true,
        canTrade: true,
        isHalfDay: false,
      },
      now: new Date('2026-02-16T01:31:00.000Z'),
      doomsdayProtectionEnabled: false,
    });

    expect(allowed).toBe(true);
  });

  it('still rejects when lifecycle or continuous trading gate is closed', () => {
    expect(
      ordinarySignalGuard({
        lastState: {
          isTradingEnabled: false,
          canTrade: true,
          isHalfDay: false,
        },
        now: new Date('2026-02-16T01:31:00.000Z'),
        doomsdayProtectionEnabled: false,
      }),
    ).toBe(false);

    expect(
      ordinarySignalGuard({
        lastState: {
          isTradingEnabled: true,
          canTrade: false,
          isHalfDay: false,
        },
        now: new Date('2026-02-16T01:31:00.000Z'),
        doomsdayProtectionEnabled: false,
      }),
    ).toBe(false);
  });
});
