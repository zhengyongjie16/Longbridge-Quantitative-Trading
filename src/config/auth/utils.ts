import { Language, PushCandlestickMode, type ExtraConfigParams } from 'longbridge';
import { getStringConfig } from '../utils.js';
import type { ApiKeyAuthConfig, AuthMode, OAuthAuthConfig } from './types.js';

const LANGUAGE_CONFIG_MAP: Readonly<Record<string, Language>> = {
  'zh-CN': Language.ZH_CN,
  'zh-HK': Language.ZH_HK,
  en: Language.EN,
};

const PUSH_CANDLESTICK_MODE_CONFIG_MAP: Readonly<Record<string, PushCandlestickMode>> = {
  realtime: PushCandlestickMode.Realtime,
  confirmed: PushCandlestickMode.Confirmed,
};

function parseBooleanEnvValue(value: string | null): boolean | undefined {
  if (value === null) {
    return undefined;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  return undefined;
}

function parseCallbackPort(env: NodeJS.ProcessEnv): number | null {
  const callbackPortValue = getStringConfig(env, 'LONGBRIDGE_CALLBACK_PORT');
  if (callbackPortValue === null) {
    return null;
  }

  const callbackPort = Number(callbackPortValue);
  if (!Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65_535) {
    return null;
  }

  return callbackPort;
}

function isAuthMode(value: string): value is AuthMode {
  return value === 'oauth' || value === 'apikey';
}

function readOptionalLanguage(env: NodeJS.ProcessEnv): Language | undefined {
  const languageValue = getStringConfig(env, 'LONGBRIDGE_LANGUAGE');
  if (languageValue === null) {
    return undefined;
  }

  return LANGUAGE_CONFIG_MAP[languageValue];
}

function readOptionalPushCandlestickMode(env: NodeJS.ProcessEnv): PushCandlestickMode | undefined {
  const pushCandlestickModeValue = getStringConfig(env, 'LONGBRIDGE_PUSH_CANDLESTICK_MODE');
  if (pushCandlestickModeValue === null) {
    return undefined;
  }

  return PUSH_CANDLESTICK_MODE_CONFIG_MAP[pushCandlestickModeValue];
}

/**
 * 读取认证模式。
 * 默认行为：仅识别 oauth / apikey；非法值返回 null，由校验层报错。
 *
 * @param env 进程环境变量
 * @returns 认证模式，未配置或无效时返回 null
 */
export function readAuthMode(env: NodeJS.ProcessEnv): AuthMode | null {
  const authModeValue = getStringConfig(env, 'LONGBRIDGE_AUTH_MODE');
  if (authModeValue === null || !isAuthMode(authModeValue)) {
    return null;
  }

  return authModeValue;
}

/**
 * 读取 OAuth 认证配置。
 * 默认行为：仅解析 client_id 与 callback_port；非法 callback_port 返回 null，由校验层报错。
 *
 * @param env 进程环境变量
 * @returns OAuth 认证配置解析结果
 */
export function readOAuthAuthConfig(env: NodeJS.ProcessEnv): OAuthAuthConfig {
  return {
    mode: 'oauth',
    clientId: getStringConfig(env, 'LONGBRIDGE_CLIENT_ID'),
    callbackPort: parseCallbackPort(env),
  };
}

/**
 * 读取 API Key 认证配置。
 * 默认行为：仅解析 API Key 三元组，未配置或占位值返回 null，由校验层报错。
 *
 * @param env 进程环境变量
 * @returns API Key 认证配置解析结果
 */
export function readApiKeyAuthConfig(env: NodeJS.ProcessEnv): ApiKeyAuthConfig {
  return {
    mode: 'apikey',
    appKey: getStringConfig(env, 'LONGBRIDGE_APP_KEY'),
    appSecret: getStringConfig(env, 'LONGBRIDGE_APP_SECRET'),
    accessToken: getStringConfig(env, 'LONGBRIDGE_ACCESS_TOKEN'),
  };
}

/**
 * 读取官方支持的 Longbridge SDK 扩展配置。
 * 默认行为：仅映射当前 Node SDK 4.0.0 已确认支持的 extra 字段，不处理任何认证字段。
 *
 * @param env 进程环境变量
 * @returns 可直接传给 Config.fromOAuth 的 extra 配置对象
 */
export function readSdkExtraConfig(env: NodeJS.ProcessEnv): ExtraConfigParams {
  const extraConfig: ExtraConfigParams = {};
  const enableOvernight = parseBooleanEnvValue(getStringConfig(env, 'LONGBRIDGE_ENABLE_OVERNIGHT'));
  const enablePrintQuotePackages = parseBooleanEnvValue(
    getStringConfig(env, 'LONGBRIDGE_PRINT_QUOTE_PACKAGES'),
  );
  const httpUrl = getStringConfig(env, 'LONGBRIDGE_HTTP_URL');
  const quoteWsUrl = getStringConfig(env, 'LONGBRIDGE_QUOTE_WS_URL');
  const tradeWsUrl = getStringConfig(env, 'LONGBRIDGE_TRADE_WS_URL');
  const language = readOptionalLanguage(env);
  const pushCandlestickMode = readOptionalPushCandlestickMode(env);
  const logPath = getStringConfig(env, 'LONGBRIDGE_LOG_PATH');

  if (httpUrl !== null) {
    extraConfig.httpUrl = httpUrl;
  }

  if (quoteWsUrl !== null) {
    extraConfig.quoteWsUrl = quoteWsUrl;
  }

  if (tradeWsUrl !== null) {
    extraConfig.tradeWsUrl = tradeWsUrl;
  }

  if (language !== undefined) {
    extraConfig.language = language;
  }

  if (enableOvernight !== undefined) {
    extraConfig.enableOvernight = enableOvernight;
  }

  if (pushCandlestickMode !== undefined) {
    extraConfig.pushCandlestickMode = pushCandlestickMode;
  }

  if (enablePrintQuotePackages !== undefined) {
    extraConfig.enablePrintQuotePackages = enablePrintQuotePackages;
  }

  if (logPath !== null) {
    extraConfig.logPath = logPath;
  }

  return extraConfig;
}
