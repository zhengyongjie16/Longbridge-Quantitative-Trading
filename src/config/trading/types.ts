/**
 * 带上下限的数值配置读取参数。
 * 类型用途：作为 parseBoundedNumberConfig 的入参，从环境变量读取并校验范围内的数值。
 * 数据来源：调用方从 process.env 及配置键传入。
 * 使用范围：仅 trading 模块内部使用。
 */
export type BoundedNumberConfig = {
  readonly env: NodeJS.ProcessEnv;
  readonly envKey: string;
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
};

/**
 * 仅带下限的数值配置读取参数。
 * 类型用途：作为 parseFailFastMinimumNumberConfig 的入参，从环境变量读取并校验最小值约束。
 * 数据来源：调用方从 process.env 及配置键传入。
 * 使用范围：仅 trading 模块内部使用。
 */
export type MinimumNumberConfig = {
  readonly env: NodeJS.ProcessEnv;
  readonly envKey: string;
  readonly defaultValue: number;
  readonly min: number;
};
