import dotenv from "dotenv";
import { Config } from "longport";

// 加载 .env 文件中的配置
dotenv.config();

/**
 * 从环境变量创建 LongPort Config
 * 文档参考：https://open.longbridge.com/zh-CN/docs/getting-started
 */
export function createConfig() {
  // 如果你不想用环境变量，也可以直接在这里传 app_key/app_secret/access_token
  return Config.fromEnv();
}
