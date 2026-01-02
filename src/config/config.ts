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

import dotenv from 'dotenv';
import { Config } from 'longport';

// 加载 .env 文件中的配置
dotenv.config();

/**
 * 区域 URL 配置接口
 */
interface RegionUrls {
  httpUrl: string;
  quoteWsUrl: string;
  tradeWsUrl: string;
}

/**
 * 根据区域获取 API 端点 URL
 * @param region 区域代码 ('cn' 或 'hk')
 * @returns API 端点 URL
 */
function getRegionUrls(region: string | undefined): RegionUrls {
  const normalizedRegion = (region || 'hk').toLowerCase();

  if (normalizedRegion === 'cn') {
    // 中国大陆区域
    return {
      httpUrl: 'https://openapi.longportapp.cn',
      quoteWsUrl: 'wss://openapi-quote.longportapp.cn/v2',
      tradeWsUrl: 'wss://openapi-trade.longportapp.cn/v2',
    };
  } else {
    // 香港及其他地区（默认）
    return {
      httpUrl: 'https://openapi.longportapp.com',
      quoteWsUrl: 'wss://openapi-quote.longportapp.com/v2',
      tradeWsUrl: 'wss://openapi-trade.longportapp.com/v2',
    };
  }
}

/*
 * 创建 LongPort Config
 * 文档参考：https://open.longbridge.com/zh-CN/docs/getting-started
 *
 * 支持的区域配置：
 * - LONGPORT_REGION=cn：中国大陆区域（使用 .cn 域名）
 * - LONGPORT_REGION=hk：香港及其他地区（默认，使用 .com 域名）
 */
export function createConfig(): Config {
  const appKey = process.env.LONGPORT_APP_KEY;
  const appSecret = process.env.LONGPORT_APP_SECRET;
  const accessToken = process.env.LONGPORT_ACCESS_TOKEN;

  // 验证必需的凭证（fail-fast原则）
  if (!appKey || appKey.trim() === '') {
    throw new Error('LONGPORT_APP_KEY is required but not set in environment variables');
  }
  if (!appSecret || appSecret.trim() === '') {
    throw new Error('LONGPORT_APP_SECRET is required but not set in environment variables');
  }
  if (!accessToken || accessToken.trim() === '') {
    throw new Error('LONGPORT_ACCESS_TOKEN is required but not set in environment variables');
  }

  const region = process.env.LONGPORT_REGION || 'hk';
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
