// 简单日志封装：统一输出格式，便于后续替换为专业日志库

function ts() {
  return new Date().toISOString();
}

export const logger = {
  debug(msg, extra) {
    // debug 级别日志，默认不输出（可以通过环境变量控制）
    if (process.env.DEBUG === "true") {
      if (extra) {
        console.log(`[DEBUG] ${ts()} ${msg}`, extra);
      } else {
        console.log(`[DEBUG] ${ts()} ${msg}`);
      }
    }
  },
  info(msg, extra) {
    if (extra) {
      console.log(`[INFO] ${ts()} ${msg}`, extra);
    } else {
      console.log(`[INFO] ${ts()} ${msg}`);
    }
  },
  warn(msg, extra) {
    if (extra) {
      console.warn(`[WARN] ${ts()} ${msg}`, extra);
    } else {
      console.warn(`[WARN] ${ts()} ${msg}`);
    }
  },
  error(msg, extra) {
    if (extra) {
      console.error(`[ERROR] ${ts()} ${msg}`, extra);
    } else {
      console.error(`[ERROR] ${ts()} ${msg}`);
    }
  },
};


