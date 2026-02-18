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

export type EmaStreamState = {
  readonly period: number;
  readonly per: number;
  seedCount: number;
  seedSum: number;
  emaValue: number | null;
};

export type RsiStreamState = {
  readonly period: number;
  readonly per: number;
  previousClose: number | null;
  seedDiffCount: number;
  seedUpSum: number;
  seedDownSum: number;
  smoothUp: number;
  smoothDown: number;
  lastRawValue: number | null;
};

export type PsyStreamState = {
  readonly period: number;
  readonly upFlags: number[];
  previousClose: number | null;
  validCloseCount: number;
  windowCount: number;
  windowIndex: number;
  upCount: number;
};
