/**
 * app/startupModes 单元测试
 *
 * 覆盖：
 * - startup/runtime gate 仅由独立环境变量控制
 */
import { describe, expect, it } from 'bun:test';
import { resolveGatePolicies } from '../../src/app/startup/startupModes.js';

describe('app startupModes', () => {
  it('defaults startup/runtime gates to strict when env vars are absent', () => {
    expect(resolveGatePolicies({})).toEqual({
      startupGate: 'strict',
      runtimeGate: 'strict',
    });
  });

  it('keeps strict gate defaults in RUN_MODE=dev without explicit gate overrides', () => {
    expect(resolveGatePolicies({ RUN_MODE: 'dev' })).toEqual({
      startupGate: 'strict',
      runtimeGate: 'strict',
    });
  });

  it('uses explicit skip only for the configured gate env key', () => {
    expect(resolveGatePolicies({ STARTUP_GATE_MODE: ' skip ' })).toEqual({
      startupGate: 'skip',
      runtimeGate: 'strict',
    });

    expect(resolveGatePolicies({ RUNTIME_GATE_MODE: 'SKIP' })).toEqual({
      startupGate: 'strict',
      runtimeGate: 'skip',
    });
  });
});
