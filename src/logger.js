// 简单日志封装：统一输出格式，便于后续替换为专业日志库

/**
 * 获取当前北京时间（UTC+8）的时间戳字符串
 * @returns {string} 格式：YYYY-MM-DD HH:mm:ss.sss
 */
function ts() {
  const now = new Date();
  // 转换为北京时间（UTC+8）
  const beijingOffset = 8 * 60 * 60 * 1000; // 8小时的毫秒数
  const beijingTime = new Date(now.getTime() + beijingOffset);
  
  const year = beijingTime.getUTCFullYear();
  const month = String(beijingTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(beijingTime.getUTCDate()).padStart(2, '0');
  const hours = String(beijingTime.getUTCHours()).padStart(2, '0');
  const minutes = String(beijingTime.getUTCMinutes()).padStart(2, '0');
  const seconds = String(beijingTime.getUTCSeconds()).padStart(2, '0');
  const milliseconds = String(beijingTime.getUTCMilliseconds()).padStart(3, '0');
  
  // 返回格式：YYYY-MM-DD HH:mm:ss.sss（北京时间）
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
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


