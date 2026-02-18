/**
 * 技术指标模块内部类型定义
 *
 * 职责：
 * - 统一承载 indicators 子模块内共享/局部类型
 * - 避免在实现文件中内联类型定义
 */

export type EmaStream = {
  nextValue: (value: number) => number | undefined;
};

export type BufferNewPush = {
  readonly size: number;
  index: number;
  pushes: number;
  sum: number;
  readonly vals: number[];
};

export type MacdPoint = {
  readonly MACD: number;
  readonly signal: number | undefined;
  readonly histogram: number | undefined;
};
