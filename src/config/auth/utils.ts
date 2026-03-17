import { Language, PushCandlestickMode, type ExtraConfigParams } from 'longbridge';
import { getStringConfig } from '../utils.js';
import type {
  ApiKeyAuthConfig,
  AuthMode,
  LongbridgeConfigValidationIssue,
  OAuthAuthConfig,
} from './types.js';

const VALID_AUTH_MODE_VALUES = new Set(['oauth', 'apikey']);
const VALID_LONGBRIDGE_LANGUAGE_VALUES = new Set(['zh-CN', 'zh-HK', 'en']);
const VALID_LONGBRIDGE_PUSH_CANDLESTICK_MODE_VALUES = new Set(['realtime', 'confirmed']);
const VALID_BOOLEAN_CONFIG_VALUES = new Set(['true', 'false']);

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
 * @returns 可直接传给 Config.fromOAuth / Config.fromApikey 的 extra 配置对象
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

/**
 * 校验 Longbridge 认证与 SDK extra 配置。
 *
 * @param env 进程环境变量
 * @returns 当前 env 中所有认证/extra 配置问题；为空表示校验通过
 */
export function validateLongbridgeConfig(env: NodeJS.ProcessEnv): ReadonlyArray<LongbridgeConfigValidationIssue> {
  const issues: LongbridgeConfigValidationIssue[] = [];
  const authModeValue = getStringConfig(env, 'LONGBRIDGE_AUTH_MODE');
  const authMode = readAuthMode(env);

  if (authModeValue === null) {
    issues.push({
      envKey: 'LONGBRIDGE_AUTH_MODE',
      message: 'LONGBRIDGE_AUTH_MODE 未配置',
    });
  } else if (!VALID_AUTH_MODE_VALUES.has(authModeValue) || authMode === null) {
    issues.push({
      envKey: 'LONGBRIDGE_AUTH_MODE',
      message: 'LONGBRIDGE_AUTH_MODE 无效（仅支持 oauth / apikey）',
    });
  }

  if (authMode === 'oauth') {
    const oauthAuthConfig = readOAuthAuthConfig(env);
    if (oauthAuthConfig.clientId === null) {
      issues.push({
        envKey: 'LONGBRIDGE_CLIENT_ID',
        message: 'LONGBRIDGE_CLIENT_ID 未配置',
      });
    }

    const callbackPortValue = getStringConfig(env, 'LONGBRIDGE_CALLBACK_PORT');
    if (callbackPortValue !== null && oauthAuthConfig.callbackPort === null) {
      issues.push({
        envKey: 'LONGBRIDGE_CALLBACK_PORT',
        message: 'LONGBRIDGE_CALLBACK_PORT 无效（必须为 1-65535 的整数端口）',
      });
    }
  }

  if (authMode === 'apikey') {
    const apiKeyAuthConfig = readApiKeyAuthConfig(env);
    const requiredApiKeyFields = [
      {
        envKey: 'LONGBRIDGE_APP_KEY',
        value: apiKeyAuthConfig.appKey,
      },
      {
        envKey: 'LONGBRIDGE_APP_SECRET',
        value: apiKeyAuthConfig.appSecret,
      },
      {
        envKey: 'LONGBRIDGE_ACCESS_TOKEN',
        value: apiKeyAuthConfig.accessToken,
      },
    ] as const;

    for (const field of requiredApiKeyFields) {
      if (field.value !== null) {
        continue;
      }

      issues.push({
        envKey: field.envKey,
        message: `${field.envKey} 未配置`,
      });
    }
  }

  const urlConfigKeys = [
    'LONGBRIDGE_HTTP_URL',
    'LONGBRIDGE_QUOTE_WS_URL',
    'LONGBRIDGE_TRADE_WS_URL',
  ] as const;
  for (const urlConfigKey of urlConfigKeys) {
    const urlValue = getStringConfig(env, urlConfigKey);
    if (urlValue !== null && !URL.canParse(urlValue)) {
      issues.push({
        envKey: urlConfigKey,
        message: `${urlConfigKey} 无效（必须为合法 URL）`,
      });
    }
  }

  const languageValue = getStringConfig(env, 'LONGBRIDGE_LANGUAGE');
  if (languageValue !== null && !VALID_LONGBRIDGE_LANGUAGE_VALUES.has(languageValue)) {
    issues.push({
      envKey: 'LONGBRIDGE_LANGUAGE',
      message: 'LONGBRIDGE_LANGUAGE 无效（仅支持 zh-CN / zh-HK / en）',
    });
  }

  const pushCandlestickModeValue = getStringConfig(env, 'LONGBRIDGE_PUSH_CANDLESTICK_MODE');
  if (
    pushCandlestickModeValue !== null &&
    !VALID_LONGBRIDGE_PUSH_CANDLESTICK_MODE_VALUES.has(pushCandlestickModeValue)
  ) {
    issues.push({
      envKey: 'LONGBRIDGE_PUSH_CANDLESTICK_MODE',
      message: 'LONGBRIDGE_PUSH_CANDLESTICK_MODE 无效（仅支持 realtime / confirmed）',
    });
  }

  const booleanConfigKeys = [
    'LONGBRIDGE_ENABLE_OVERNIGHT',
    'LONGBRIDGE_PRINT_QUOTE_PACKAGES',
  ] as const;
  for (const booleanConfigKey of booleanConfigKeys) {
    const booleanValue = getStringConfig(env, booleanConfigKey);
    if (booleanValue !== null && !VALID_BOOLEAN_CONFIG_VALUES.has(booleanValue)) {
      issues.push({
        envKey: booleanConfigKey,
        message: `${booleanConfigKey} 无效（仅支持 true / false）`,
      });
    }
  }

  return issues;
}
