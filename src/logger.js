// 简单日志封装：统一输出格式，便于后续替换为专业日志库
import { toBeijingTimeLog } from "./utils.js";

// ANSI 颜色代码
export const colors = {
  reset: "\x1b[0m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  green: "\x1b[32m",
};

export const logger = {
  debug(msg, extra) {
    // debug 级别日志，默认不输出（可以通过环境变量控制）
    if (process.env.DEBUG === "true") {
      const timestamp = toBeijingTimeLog();
      if (extra) {
        console.log(
          `${colors.gray}[DEBUG] ${timestamp} ${msg}${colors.reset}`,
          extra
        );
      } else {
        console.log(`${colors.gray}[DEBUG] ${timestamp} ${msg}${colors.reset}`);
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
      console.warn(
        `${colors.yellow}[WARN] ${timestamp} ${msg}${colors.reset}`,
        extra
      );
    } else {
      console.warn(`${colors.yellow}[WARN] ${timestamp} ${msg}${colors.reset}`);
    }
  },
  error(msg, extra) {
    const timestamp = toBeijingTimeLog();
    if (extra) {
      console.error(
        `${colors.red}[ERROR] ${timestamp} ${msg}${colors.reset}`,
        extra
      );
    } else {
      console.error(`${colors.red}[ERROR] ${timestamp} ${msg}${colors.reset}`);
    }
  },
};
