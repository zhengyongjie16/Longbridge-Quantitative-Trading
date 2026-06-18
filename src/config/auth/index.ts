/**
 * Longbridge 认证配置装配模块
 *
 * 功能/职责：
 * - 基于环境变量解析 OAuth 或 API Key 认证参数
 * - 先执行统一配置校验，再按认证模式构造 Longbridge SDK Config
 * - 在 OAuth 模式下透传授权 URL 打开回调
 */
import { Config, OAuth } from 'longbridge';
import {
  readApiKeyAuthConfig,
  readAuthMode,
  readOAuthAuthConfig,
  readSdkExtraConfig,
  validateLongbridgeConfig,
} from './utils.js';
import type {
  CreateSdkConfigFromAuthParams,
  ResolvedApiKeyAuthConfig,
  ResolvedAuthConfig,
  ResolvedOAuthAuthConfig,
} from './types.js';

function resolveOAuthAuthConfig(env: NodeJS.ProcessEnv): ResolvedOAuthAuthConfig {
  const oauthAuthConfig = readOAuthAuthConfig(env);
  if (oauthAuthConfig.clientId === null) {
    throw new Error('LONGBRIDGE_CLIENT_ID 未配置，无法创建 Longbridge OAuth Config');
  }

  return {
    mode: 'oauth',
    clientId: oauthAuthConfig.clientId,
    callbackPort: oauthAuthConfig.callbackPort,
  };
}

function resolveApiKeyAuthConfig(env: NodeJS.ProcessEnv): ResolvedApiKeyAuthConfig {
  const apiKeyAuthConfig = readApiKeyAuthConfig(env);
  if (
    apiKeyAuthConfig.appKey === null ||
    apiKeyAuthConfig.appSecret === null ||
    apiKeyAuthConfig.accessToken === null
  ) {
    throw new Error('LONGBRIDGE API Key 认证配置未完整填写，无法创建 Longbridge API Key Config');
  }

  return {
    mode: 'apikey',
    appKey: apiKeyAuthConfig.appKey,
    appSecret: apiKeyAuthConfig.appSecret,
    accessToken: apiKeyAuthConfig.accessToken,
  };
}

function resolveAuthConfig(env: NodeJS.ProcessEnv): ResolvedAuthConfig {
  const authMode = readAuthMode(env);
  if (authMode === null) {
    throw new Error('LONGBRIDGE_AUTH_MODE 未配置或无效，无法创建 Longbridge SDK Config');
  }

  if (authMode === 'oauth') {
    return resolveOAuthAuthConfig(env);
  }

  return resolveApiKeyAuthConfig(env);
}

async function buildOAuth(authConfig: ResolvedOAuthAuthConfig, onOpenUrl?: (url: string) => void) {
  return await OAuth.build(
    authConfig.clientId,
    (error: Error | null, url: string) => {
      if (error !== null) {
        throw error;
      }

      onOpenUrl?.(url);
    },
    authConfig.callbackPort ?? undefined,
  );
}

/**
 * 使用统一认证配置与官方扩展配置创建 SDK Config。
 *
 * @param params.env 进程环境变量
 * @param params.onOpenUrl OAuth 模式下首次授权时输出授权 URL 的回调
 * @returns 统一的 Longbridge SDK Config
 */
export async function createSdkConfigFromAuth(
  params: CreateSdkConfigFromAuthParams,
): Promise<Config> {
  const { env, onOpenUrl } = params;
  const validationIssues = validateLongbridgeConfig(env);
  if (validationIssues.length > 0) {
    throw new Error(validationIssues[0]?.message ?? 'Longbridge 配置无效');
  }

  const authConfig = resolveAuthConfig(env);
  const extraConfig = readSdkExtraConfig(env);

  if (authConfig.mode === 'oauth') {
    const oauth = await buildOAuth(authConfig, onOpenUrl);
    return Config.fromOAuth(oauth, extraConfig);
  }

  return Config.fromApikey(
    authConfig.appKey,
    authConfig.appSecret,
    authConfig.accessToken,
    extraConfig,
  );
}
