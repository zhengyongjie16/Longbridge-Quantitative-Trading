import type { OAuth } from 'longbridge';

/**
 * OAuth 授权 URL 回调。
 * 类型用途：在需要用户手动完成首次授权时，将 SDK 生成的授权 URL 交给上层输出。
 * 数据来源：由 createPreGateRuntime、工具脚本等调用方注入。
 * 使用范围：仅 config/auth 模块及其调用方使用。
 */
export type OAuthUrlHandler = {
  readonly onOpenUrl: (url: string) => void;
};

/**
 * OAuth 初始化参数。
 * 类型用途：封装 initializeOAuth 所需环境变量与授权 URL 回调。
 * 数据来源：由启动入口或工具脚本传入。
 * 使用范围：仅 config/auth 模块使用。
 */
export type InitializeOAuthParams = OAuthUrlHandler & {
  readonly env: NodeJS.ProcessEnv;
};

/**
 * SDK Config 组装参数。
 * 类型用途：封装 createSdkConfigFromOAuth 所需 OAuth 句柄与环境变量。
 * 数据来源：由启动入口或工具脚本在 OAuth 初始化完成后传入。
 * 使用范围：仅 config/auth 模块使用。
 */
export type CreateSdkConfigFromOAuthParams = {
  readonly oauth: OAuth;
  readonly env: NodeJS.ProcessEnv;
};

/**
 * OAuth 启动配置校验结果。
 * 类型用途：表达单个 OAuth 启动字段的读取结果，便于校验层复用。
 * 数据来源：由 config/auth/utils 解析环境变量后得到。
 * 使用范围：仅 config/auth 模块与配置校验层使用。
 */
export type ParsedOAuthBootstrapConfig = {
  readonly clientId: string | null;
  readonly callbackPort: number | null;
};
