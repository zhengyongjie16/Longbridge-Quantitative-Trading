/**
 * app/startupModes 单元测试
 *
 * 覆盖：
 * - RUN_MODE 仅保留 dev/prod 解析语义
 * - startup/runtime gate 仅由独立环境变量控制
 */
import { describe, expect, it } from 'bun:test';
import {
  resolveGatePolicies,
  resolveGatePolicySources,
  resolveRunMode,
} from '../../src/app/startup/startupModes.js';

describe('app startupModes', () => {
  it('resolves prod as the default run mode', () => {
    expect(resolveRunMode({})).toBe('prod');
    expect(resolveRunMode({ RUN_MODE: ' PROD ' })).toBe('prod');
  });

  it('resolves dev run mode case-insensitively', () => {
    expect(resolveRunMode({ RUN_MODE: 'dev' })).toBe('dev');
    expect(resolveRunMode({ RUN_MODE: 'DeV' })).toBe('dev');
  });

  it('defaults startup/runtime gates to strict when env vars are absent', () => {
    expect(resolveGatePolicies({})).toEqual({
      startupGate: 'strict',
      runtimeGate: 'strict',
    });

    expect(resolveGatePolicySources({})).toEqual({
      startupGateSource: 'default',
      runtimeGateSource: 'default',
    });
  });

  it('keeps strict gate defaults in RUN_MODE=dev without explicit gate overrides', () => {
    expect(resolveGatePolicies({ RUN_MODE: 'dev' })).toEqual({
      startupGate: 'strict',
      runtimeGate: 'strict',
    });

    expect(resolveGatePolicySources({ RUN_MODE: 'dev' })).toEqual({
      startupGateSource: 'default',
      runtimeGateSource: 'default',
    });
  });

  it('uses explicit skip only for the configured gate env key', () => {
    expect(resolveGatePolicies({ STARTUP_GATE_MODE: ' skip ' })).toEqual({
      startupGate: 'skip',
      runtimeGate: 'strict',
    });

    expect(resolveGatePolicySources({ STARTUP_GATE_MODE: ' skip ' })).toEqual({
      startupGateSource: 'explicit',
      runtimeGateSource: 'default',
    });

    expect(resolveGatePolicies({ RUNTIME_GATE_MODE: 'SKIP' })).toEqual({
      startupGate: 'strict',
      runtimeGate: 'skip',
    });

    expect(resolveGatePolicySources({ RUNTIME_GATE_MODE: 'SKIP' })).toEqual({
      startupGateSource: 'default',
      runtimeGateSource: 'explicit',
    });
  });
});
