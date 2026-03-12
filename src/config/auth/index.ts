import { Config, OAuth } from 'longbridge';
import { readOAuthBootstrapConfig, readSdkExtraConfig } from './utils.js';
import type { CreateSdkConfigFromOAuthParams, InitializeOAuthParams } from './types.js';

/**
 * 初始化 Longbridge OAuth 句柄。
 *
 * @param params.env 进程环境变量
 * @param params.onOpenUrl 首次授权时输出授权 URL 的回调
 * @returns 可供 Config.fromOAuth 使用的 OAuth 句柄
 */
export async function initializeOAuth(params: InitializeOAuthParams): Promise<OAuth> {
  const { env, onOpenUrl } = params;
  const oauthBootstrapConfig = readOAuthBootstrapConfig(env);
  if (oauthBootstrapConfig.clientId === null) {
    throw new Error('LONGBRIDGE_CLIENT_ID 未配置，无法初始化 Longbridge OAuth');
  }

  return await OAuth.build(
    oauthBootstrapConfig.clientId,
    (error: Error | null, url: string) => {
      if (error !== null) {
        throw error;
      }

      onOpenUrl(url);
    },
    oauthBootstrapConfig.callbackPort ?? undefined,
  );
}

/**
 * 使用 OAuth 句柄与官方扩展配置创建 SDK Config。
 *
 * @param params.oauth 已完成初始化的 OAuth 句柄
 * @param params.env 进程环境变量
 * @returns 统一的 Longbridge SDK Config
 */
export function createSdkConfigFromOAuth(params: CreateSdkConfigFromOAuthParams): Config {
  const { oauth, env } = params;
  const extraConfig = readSdkExtraConfig(env);

  return Config.fromOAuth(oauth, extraConfig);
}
