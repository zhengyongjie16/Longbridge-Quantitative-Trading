import type { createSdkConfigFromAuth } from '../../config/auth/index.js';
import type { createTrader } from '../../core/trader/index.js';
import type { createMarketDataClient } from '../../services/quoteClient/index.js';

/**
 * pre-gate runtime 工厂依赖。
 * 类型用途：约束 createPreGateRuntimeFactory 可替换的外部依赖边界。
 * 数据来源：生产环境使用默认实现，测试可注入 double。
 * 使用范围：仅 app/runtime/createPreGateRuntime 使用。
 */
export type CreatePreGateRuntimeDeps = Readonly<{
  createSdkConfigFromAuth: typeof createSdkConfigFromAuth;
  createMarketDataClient: typeof createMarketDataClient;
}>;

/**
 * post-gate runtime 工厂依赖。
 * 类型用途：约束 createPostGateRuntimeFactory 可替换的外部依赖边界。
 * 数据来源：生产环境使用默认实现，测试可注入 double。
 * 使用范围：仅 app/runtime/createPostGateRuntime 使用。
 */
export type CreatePostGateRuntimeDeps = Readonly<{
  createTrader: typeof createTrader;
}>;
