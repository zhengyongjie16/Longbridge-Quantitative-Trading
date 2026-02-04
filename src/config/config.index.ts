/**
 * LongPort API 配置模块
 *
 * 从环境变量读取 API 凭证，根据区域配置端点 URL，创建 LongPort Config 对象
 */
import { Config } from 'longport';
import { getRegionUrls } from './utils.js';

/**
 * 创建 LongPort Config 对象
 * 文档参考：https://open.longbridge.com/zh-CN/docs/getting-started
 */
export function createConfig({ env }: { env: NodeJS.ProcessEnv }): Config {
  // 配置验证已在 config.validator.ts 的 validateAllConfig() 中统一处理
  // 此处使用非空断言，因为调用前已完成验证
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
    httpUrl: urls.httpUrl,
    quoteWsUrl: urls.quoteWsUrl,
    tradeWsUrl: urls.tradeWsUrl,
  });
}
