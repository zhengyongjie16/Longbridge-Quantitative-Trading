/**
 * LongPort API 配置模块
 *
 * 从环境变量读取 API 凭证，根据区域配置端点 URL，创建 LongPort Config 对象
 */
import { Config, PushCandlestickMode } from 'longport';
import { getRegionUrls } from './utils.js';

/**
 * 创建 LongPort API 配置对象，从环境变量读取凭证与区域并设置端点 URL。
 * @param deps - 依赖，包含 env（进程环境变量对象）
 * @returns LongPort Config 实例，用于 QuoteContext/TradeContext 初始化
 */
export function createConfig({ env }: { env: NodeJS.ProcessEnv }): Config {
  const appKey = env['LONGPORT_APP_KEY'] ?? '';
  const appSecret = env['LONGPORT_APP_SECRET'] ?? '';
  const accessToken = env['LONGPORT_ACCESS_TOKEN'] ?? '';

  const region = env['LONGPORT_REGION'] || 'hk';
  const urls = getRegionUrls(region);

  return new Config({
    appKey,
    appSecret,
    accessToken,
    enablePrintQuotePackages: true,
    pushCandlestickMode: PushCandlestickMode.Realtime,
    httpUrl: urls.httpUrl,
    quoteWsUrl: urls.quoteWsUrl,
    tradeWsUrl: urls.tradeWsUrl,
  });
}
