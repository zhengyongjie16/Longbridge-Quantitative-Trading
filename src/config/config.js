import dotenv from "dotenv";
import { Config } from "longport";

// 加载 .env 文件中的配置
dotenv.config();

/**
 * 根据区域获取 API 端点 URL
 * @param {string} region 区域代码 ('cn' 或 'hk')
 * @returns {{httpUrl: string, quoteWsUrl: string, tradeWsUrl: string}} API 端点 URL
 */
function getRegionUrls(region) {
  const normalizedRegion = (region || "hk").toLowerCase();

  if (normalizedRegion === "cn") {
    // 中国大陆区域
    return {
      httpUrl: "https://openapi.longportapp.cn",
      quoteWsUrl: "wss://openapi-quote.longportapp.cn/v2",
      tradeWsUrl: "wss://openapi-trade.longportapp.cn/v2",
    };
  } else {
    // 香港及其他地区（默认）
    return {
      httpUrl: "https://openapi.longportapp.com",
      quoteWsUrl: "wss://openapi-quote.longportapp.com/v2",
      tradeWsUrl: "wss://openapi-trade.longportapp.com/v2",
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
export function createConfig() {
  const region = process.env.LONGPORT_REGION || "hk";
  const urls = getRegionUrls(region);

  return new Config({
    appKey: process.env.LONGPORT_APP_KEY || "",
    appSecret: process.env.LONGPORT_APP_SECRET || "",
    accessToken: process.env.LONGPORT_ACCESS_TOKEN || "",
    enablePrintQuotePackages: true,
    httpUrl: urls.httpUrl,
    quoteWsUrl: urls.quoteWsUrl,
    tradeWsUrl: urls.tradeWsUrl,
  });
}
