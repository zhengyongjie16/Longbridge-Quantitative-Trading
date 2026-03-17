/**
 * 认证模式。
 * 类型用途：约束 Longbridge SDK 认证来源，仅允许 oauth 或 apikey。
 * 数据来源：由 LONGBRIDGE_AUTH_MODE 环境变量解析得到。
 * 使用范围：仅 config/auth 模块与配置校验层使用。
 */
export type AuthMode = 'oauth' | 'apikey';

/**
 * OAuth 认证配置读取结果。
 * 类型用途：表达 OAuth 模式字段的解析结果，便于校验层与工厂层复用。
 * 数据来源：由 config/auth/utils 解析环境变量后得到。
 * 使用范围：仅 config/auth 模块与配置校验层使用。
 */
export type OAuthAuthConfig = {
  readonly mode: 'oauth';
  readonly clientId: string | null;
  readonly callbackPort: number | null;
};

/**
 * API Key 认证配置读取结果。
 * 类型用途：表达 API Key 模式字段的解析结果，便于校验层与工厂层复用。
 * 数据来源：由 config/auth/utils 解析环境变量后得到。
 * 使用范围：仅 config/auth 模块与配置校验层使用。
 */
export type ApiKeyAuthConfig = {
  readonly mode: 'apikey';
  readonly appKey: string | null;
  readonly appSecret: string | null;
  readonly accessToken: string | null;
};

/**
 * 已完成必填字段解析的 OAuth 认证配置。
 * 类型用途：供统一 SDK Config 工厂安全创建 OAuth Config。
 * 数据来源：由 config/auth/index 在确认必填字段完整后构造。
 * 使用范围：仅 config/auth 模块使用。
 */
export type ResolvedOAuthAuthConfig = {
  readonly mode: 'oauth';
  readonly clientId: string;
  readonly callbackPort: number | null;
};

/**
 * 已完成必填字段解析的 API Key 认证配置。
 * 类型用途：供统一 SDK Config 工厂安全创建 API Key Config。
 * 数据来源：由 config/auth/index 在确认必填字段完整后构造。
 * 使用范围：仅 config/auth 模块使用。
 */
export type ResolvedApiKeyAuthConfig = {
  readonly mode: 'apikey';
  readonly appKey: string;
  readonly appSecret: string;
  readonly accessToken: string;
};

/**
 * 已解析完成的统一认证配置联合类型。
 * 类型用途：表达可直接用于创建 SDK Config 的认证配置。
 * 数据来源：由 config/auth/index 在校验通过后构造。
 * 使用范围：仅 config/auth 模块使用。
 */
export type ResolvedAuthConfig = ResolvedOAuthAuthConfig | ResolvedApiKeyAuthConfig;

/**
 * 统一 SDK Config 创建参数。
 * 类型用途：封装 createSdkConfigFromAuth 所需环境变量与 OAuth 授权 URL 回调。
 * 数据来源：由启动入口传入。
 * 使用范围：仅 config/auth 模块使用。
 */
export type CreateSdkConfigFromAuthParams = {
  readonly env: NodeJS.ProcessEnv;
  readonly onOpenUrl?: (url: string) => void;
};

/**
 * Longbridge 认证与 SDK extra 配置校验问题。
 * 类型用途：统一表达 auth 模块内可复用的环境变量校验结果，供校验层与工厂层共享。
 * 数据来源：由 config/auth/utils 中的校验函数生成。
 * 使用范围：仅 config/auth 模块与配置校验层使用。
 */
export type LongbridgeConfigValidationIssue = Readonly<{
  envKey: string;
  message: string;
}>;
