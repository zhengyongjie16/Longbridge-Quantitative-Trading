/**
 * 运行时档位类型。
 * 类型用途：表示程序当前运行环境（正式运行或测试运行），作为 runtime 解析函数的返回类型。
 * 数据来源：由环境变量解析逻辑（APP_RUNTIME_PROFILE/BUN_TEST）推导。
 * 使用范围：runtime 模块及其调用方使用。
 */
export type RuntimeProfile = 'app' | 'test';
