/**
 * app/startupModes 单元测试
 *
 * 覆盖：
 * - RUN_MODE 解析默认 prod，dev 显式切换为跳过门禁
 * - startup/runtime gate 策略矩阵保持一致
 */
import { describe, expect, it } from 'bun:test';
import { resolveGatePolicies, resolveRunMode } from '../../src/app/startupModes.js';

describe('app startupModes', () => {
  it('resolves prod as the default run mode', () => {
    expect(resolveRunMode({})).toBe('prod');
    expect(resolveRunMode({ RUN_MODE: ' PROD ' })).toBe('prod');
  });

  it('resolves dev run mode case-insensitively', () => {
    expect(resolveRunMode({ RUN_MODE: 'dev' })).toBe('dev');
    expect(resolveRunMode({ RUN_MODE: 'DeV' })).toBe('dev');
  });

  it('maps run mode to startup/runtime gate policies', () => {
    expect(resolveGatePolicies('prod')).toEqual({
      startupGate: 'strict',
      runtimeGate: 'strict',
    });

    expect(resolveGatePolicies('dev')).toEqual({
      startupGate: 'skip',
      runtimeGate: 'skip',
    });
  });
});
