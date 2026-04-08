/**
 * monitorTaskProcessor 类型契约测试
 *
 * 功能：
 * - 锁定 monitorTaskProcessor 公开任务类型边界
 * - 确保旧 distance 任务类型已从契约中删除
 */
import { describe, expect, it } from 'bun:test';

import type { MonitorTaskDataMap } from '../../../../src/main/asyncProgram/monitorTaskProcessor/types.js';

type ExpectedTaskType = 'AUTO_SYMBOL_TICK' | 'SEAT_REFRESH';
type ActualTaskType = keyof MonitorTaskDataMap;
type IsExactTaskTypeMatch = [ActualTaskType] extends [ExpectedTaskType]
  ? [ExpectedTaskType] extends [ActualTaskType]
    ? true
    : false
  : false;

const exactTaskTypeMatch: IsExactTaskTypeMatch = true;

describe('monitorTaskProcessor task type contract', () => {
  it('exposes only tick and seat refresh task types', () => {
    expect(exactTaskTypeMatch).toBeTrue();
  });
});
