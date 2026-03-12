import { Language, PushCandlestickMode, type ExtraConfigParams } from 'longbridge';
import { getStringConfig } from '../utils.js';
import type { ParsedOAuthBootstrapConfig } from './types.js';

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
 * 读取 OAuth 启动配置。
 * 默认行为：仅解析 client_id 与 callback_port；非法 callback_port 返回 null，由校验层报错。
 *
 * @param env 进程环境变量
 * @returns OAuth 启动配置解析结果
 */
export function readOAuthBootstrapConfig(env: NodeJS.ProcessEnv): ParsedOAuthBootstrapConfig {
  return {
    clientId: getStringConfig(env, 'LONGBRIDGE_CLIENT_ID'),
    callbackPort: parseCallbackPort(env),
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
