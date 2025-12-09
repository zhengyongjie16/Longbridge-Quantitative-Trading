// 简单日志封装：统一输出格式，便于后续替换为专业日志库
import { toBeijingTimeLog } from "./utils.js";

export const logger = {
  debug(msg, extra) {
    // debug 级别日志，默认不输出（可以通过环境变量控制）
    if (process.env.DEBUG === "true") {
      const timestamp = toBeijingTimeLog();
      if (extra) {
        console.log(`[DEBUG] ${timestamp} ${msg}`, extra);
      } else {
        console.log(`[DEBUG] ${timestamp} ${msg}`);
      }
    }
  },
  info(msg, extra) {
    const timestamp = toBeijingTimeLog();
    if (extra) {
      console.log(`[INFO] ${timestamp} ${msg}`, extra);
    } else {
      console.log(`[INFO] ${timestamp} ${msg}`);
    }
  },
  warn(msg, extra) {
    const timestamp = toBeijingTimeLog();
    if (extra) {
      console.warn(`[WARN] ${timestamp} ${msg}`, extra);
    } else {
      console.warn(`[WARN] ${timestamp} ${msg}`);
    }
  },
  error(msg, extra) {
    const timestamp = toBeijingTimeLog();
    if (extra) {
      console.error(`[ERROR] ${timestamp} ${msg}`, extra);
    } else {
      console.error(`[ERROR] ${timestamp} ${msg}`);
    }
  },
};
