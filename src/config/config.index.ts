/**
 * LongBridge API 配置模块
 *
 * 功能：
 * - 从环境变量读取 LongPort API 凭证（APP_KEY、APP_SECRET、ACCESS_TOKEN）
 * - 根据区域配置 API 端点URL（大陆使用 .cn 域名，香港使用 .com 域名）
 * - 创建并导出 LongPort Config 对象供其他模块使用
 *
 * 环境变量：
 * - LONGPORT_APP_KEY：应用密钥
 * - LONGPORT_APP_SECRET：应用密钥
 * - LONGPORT_ACCESS_TOKEN：访问令牌
 * - LONGPORT_REGION：区域配置（'cn' 或 'hk'，默认 'hk'）
 */

import { Config } from 'longport';
import { getRegionUrls } from './utils.js';

/*
 * 创建 LongPort Config
 * 文档参考：https://open.longbridge.com/zh-CN/docs/getting-started
 *
 * 支持的区域配置：
 * - LONGPORT_REGION=cn：中国大陆区域（使用 .cn 域名）
 * - LONGPORT_REGION=hk：香港及其他地区（默认，使用 .com 域名）
 *
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
