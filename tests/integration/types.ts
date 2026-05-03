import type { SeatState } from '../../src/types/seat.js';

/**
 * 多监控集成测试的 seat 快照。
 * 类型用途：维护每个 monitorSymbol 下 long/short 席位与 seatVersion。
 * 数据来源：由集成测试构造测试内 symbolRegistry 时维护。
 * 使用范围：tests/integration 下多监控 seat 状态测试。
 */
export type MultiMonitorSeatEntry = {
  longState: SeatState;
  shortState: SeatState;
  longVersion: number;
  shortVersion: number;
};
