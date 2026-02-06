/**
 * LongPort API 配置模块
 *
 * 从环境变量读取 API 凭证，根据区域配置端点 URL，创建 LongPort Config 对象
 */
import { Config, PushCandlestickMode } from 'longport';
import { getRegionUrls } from './utils.js';

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
