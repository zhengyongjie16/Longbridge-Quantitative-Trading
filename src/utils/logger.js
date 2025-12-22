// 简单日志封装：统一输出格式，便于后续替换为专业日志库
// 使用异步队列批量处理日志输出，避免阻塞主循环
import { toBeijingTimeLog, toBeijingTimeIso } from "./helpers.js";
import fs from "node:fs";
import path from "node:path";

// ANSI 颜色代码
export const colors = {
  reset: "\x1b[0m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  green: "\x1b[32m",
};

// 移除ANSI颜色代码的函数（用于文件日志）
function stripAnsiCodes(str) {
  if (typeof str !== "string") return str;
  // 移除所有ANSI转义序列
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * 格式化日志参数为字符串（用于文件输出）
 * @param {Array} args 日志参数数组
 * @returns {string} 格式化后的日志行
 */
function formatLogLine(args) {
  if (!args || args.length === 0) return "";

  return args
    .map((arg) => {
      if (typeof arg === "string") {
        return stripAnsiCodes(arg);
      } else if (arg === null || arg === undefined) {
        return String(arg);
      } else if (typeof arg === "object") {
        // 对于对象，转换为JSON字符串（紧凑格式，节省空间）
        try {
          // 使用紧凑格式，不格式化，节省文件空间
          return JSON.stringify(arg);
        } catch {
          // 如果序列化失败（如循环引用），使用toString
          return String(arg);
        }
      }
      return String(arg);
    })
    .join(" ");
}

/**
 * 文件日志管理器
 * 负责创建和管理日志文件流
 */
class FileLogManager {
  constructor(logSubDir = "system") {
    this._logSubDir = logSubDir;
    this._logDir = null;
    this._currentDate = null;
    this._fileStream = null;
    this._initialized = false;
  }

  /**
   * 初始化日志目录和文件流
   */
  _initialize() {
    if (this._initialized) return;

    try {
      // 创建日志目录
      this._logDir = path.join(process.cwd(), "logs", this._logSubDir);
      if (!fs.existsSync(this._logDir)) {
        fs.mkdirSync(this._logDir, { recursive: true });
      }

      // 获取当前日期（北京时间）- 使用统一的时区转换函数
      const now = new Date();
      // 使用 toBeijingTimeIso 获取日期部分
      // toBeijingTimeIso 返回格式：YYYY/MM/DD/HH:mm:ss，需要转换为 YYYY-MM-DD
      const beijingTimeStr = toBeijingTimeIso(now);
      // 提取日期部分并替换分隔符
      const datePart = beijingTimeStr.split("/").slice(0, 3).join("-");
      this._currentDate = datePart;

      // 创建日志文件流
      this._openFileStream();

      this._initialized = true;
    } catch (err) {
      // 文件日志初始化失败，静默处理（不影响控制台日志）
      if (process.env.DEBUG === "true") {
        console.error("[FileLogManager] 初始化失败:", err);
      }
    }
  }

  /**
   * 打开日志文件流
   */
  _openFileStream() {
    try {
      const logFile = path.join(this._logDir, `${this._currentDate}.log`);
      this._fileStream = fs.createWriteStream(logFile, {
        flags: "a", // 追加模式
        encoding: "utf8",
        autoClose: false, // 不自动关闭，由我们手动管理
      });

      // 监听错误事件
      this._fileStream.on("error", (err) => {
        if (process.env.DEBUG === "true") {
          console.error("[FileLogManager] 文件流错误:", err);
        }
      });
    } catch (err) {
      if (process.env.DEBUG === "true") {
        console.error("[FileLogManager] 打开文件流失败:", err);
      }
    }
  }

  /**
   * 检查是否需要切换日志文件（跨天时）
   */
  _checkDateChange() {
    try {
      // 如果还未初始化，不需要检查日期变化
      if (!this._initialized || !this._logDir) return;

      const now = new Date();
      // 使用统一的时区转换函数
      // toBeijingTimeIso 返回格式：YYYY/MM/DD/HH:mm:ss，需要转换为 YYYY-MM-DD
      const beijingTimeStr = toBeijingTimeIso(now);
      const datePart = beijingTimeStr.split("/").slice(0, 3).join("-");
      const today = datePart;

      // 如果当前日期为null（初始化失败），或者日期发生变化
      if (this._currentDate === null || today !== this._currentDate) {
        // 日期变化，关闭旧文件流，打开新文件流
        this._closeFileStream();
        this._currentDate = today;
        this._openFileStream();
      }
    } catch (err) {
      if (process.env.DEBUG === "true") {
        console.error("[FileLogManager] 检查日期变化失败:", err);
      }
    }
  }

  /**
   * 写入日志到文件
   * @param {string} logLine 日志行（已移除ANSI颜色代码）
   */
  write(logLine) {
    try {
      this._initialize();
      if (!this._fileStream) return;

      this._checkDateChange();

      // 写入文件（追加换行符）
      this._fileStream.write(logLine + "\n", "utf8");
    } catch (err) {
      // 文件写入失败，静默处理
      if (process.env.DEBUG === "true") {
        console.error("[FileLogManager] 写入失败:", err);
      }
    }
  }

  /**
   * 关闭文件流
   */
  _closeFileStream() {
    if (this._fileStream) {
      try {
        // 先尝试同步刷新（如果可能）
        this.flushSync();

        // 保存文件路径，因为end()后可能无法访问
        const logFile =
          this._logDir && this._currentDate
            ? path.join(this._logDir, `${this._currentDate}.log`)
            : null;

        // 结束流，这会确保所有缓冲数据都写入
        // 注意：end()是异步的，但在退出时我们尽力而为
        this._fileStream.end();

        // 尝试通过文件路径刷新（在end()之后，文件流可能已关闭）
        // 注意：这可能在end()完成前执行，但fsync会确保数据写入磁盘
        if (logFile && fs.existsSync(logFile)) {
          try {
            // 使用同步方式打开文件并刷新
            const fd = fs.openSync(logFile, "r+");
            try {
              fs.fsyncSync(fd);
            } catch (err) {
              // 忽略fsync错误（某些系统可能不支持）
            }
            fs.closeSync(fd);
          } catch (err) {
            // 忽略错误（文件可能已被关闭或不存在，或正在被其他进程使用）
          }
        }
      } catch (err) {
        // 忽略关闭错误
      }
      this._fileStream = null;
    }
  }

  /**
   * 同步刷新所有缓冲数据到文件
   */
  flushSync() {
    if (this._fileStream && this._fileStream.writable) {
      try {
        // 尝试获取文件流的文件描述符并同步刷新
        // 注意：Node.js的WriteStream默认不暴露fd，需要检查是否存在
        if (this._fileStream.fd !== null && this._fileStream.fd !== undefined) {
          try {
            fs.fsyncSync(this._fileStream.fd);
          } catch (err) {
            // 如果fsync失败，忽略错误（某些系统可能不支持）
          }
        } else if (this._logDir && this._currentDate) {
          // 如果fd不可用，尝试通过文件路径刷新
          try {
            const logFile = path.join(this._logDir, `${this._currentDate}.log`);
            if (fs.existsSync(logFile)) {
              const fd = fs.openSync(logFile, "r+");
              try {
                fs.fsyncSync(fd);
              } catch (err) {
                // 忽略fsync错误
              }
              fs.closeSync(fd);
            }
          } catch (err) {
            // 忽略错误
          }
        }
      } catch (err) {
        // 忽略错误，尽力而为
      }
    }
  }

  /**
   * 关闭文件日志管理器
   */
  close() {
    this.flushSync();
    this._closeFileStream();
  }
}

/**
 * 异步日志队列（简化版）
 *
 * 设计原则：
 * 1. 简单可靠：避免复杂的并发控制
 * 2. 批量处理：减少异步任务数量
 * 3. 防止阻塞：日志调用立即返回
 * 4. 防止丢失：进程退出时同步刷新
 *
 * 工作流程：
 * 1. logger 调用 → 日志入队 → 立即返回（不阻塞）
 * 2. 如果队列空闲 → 调度 setImmediate 处理
 * 3. 处理函数批量输出日志（每批最多20条）
 * 4. 如果还有日志 → 继续调度下一批
 */
class AsyncLogQueue {
  constructor() {
    this._queue = []; // 日志队列
    this._processing = false; // 是否正在处理
    this._batchSize = 20; // 每批处理数量
    this._maxQueueSize = 1000; // 最大队列长度（防止内存溢出）
    this._fileLogManager = new FileLogManager("system"); // 系统日志文件管理器
    // 仅在DEBUG模式下创建debug文件管理器
    this._debugFileLogManager =
      process.env.DEBUG === "true" ? new FileLogManager("debug") : null;
  }

  /**
   * 添加日志到队列
   * @param {Function} outputFn 输出函数（console.log/warn/error）
   * @param {Array} args 日志参数
   * @param {boolean} isDebugLog 是否为debug日志（可选，用于优化判断）
   */
  enqueue(outputFn, ...args) {
    // 防止队列无限增长
    if (this._queue.length >= this._maxQueueSize) {
      // 丢弃最旧的日志
      this._queue.shift();

      // 在控制台直接输出警告（不进入队列，避免递归）
      if (process.env.DEBUG === "true") {
        console.warn("[AsyncLogger] Queue overflow, dropping oldest log");
      }
    }

    // 判断是否为debug日志（通过检查第一个参数是否包含 [DEBUG] 标记）
    // 使用更精确的匹配：检查是否以 [DEBUG] 开头（去除ANSI颜色代码后）
    let isDebugLog = false;
    if (args && args.length > 0 && typeof args[0] === "string") {
      // 移除ANSI颜色代码后检查
      const firstArg = stripAnsiCodes(args[0]);
      // 检查是否以 [DEBUG] 开头（更精确的匹配）
      isDebugLog = firstArg.startsWith("[DEBUG]");
    }

    // 日志入队，附带debug标记
    this._queue.push({ outputFn, args, isDebugLog });

    // 如果当前没有在处理，启动处理
    if (!this._processing) {
      this._processing = true;
      // 使用 setImmediate 异步处理，不阻塞当前执行
      setImmediate(() => this._processQueue());
    }
  }

  /**
   * 批量处理队列中的日志
   */
  _processQueue() {
    // 取出一批日志（最多 batchSize 条）
    const batch = this._queue.splice(0, this._batchSize);

    // 逐条输出
    for (const item of batch) {
      try {
        // 输出到控制台
        item.outputFn(...item.args);

        // 同时写入文件（移除ANSI颜色代码）
        if (item.args && item.args.length > 0) {
          const logLine = formatLogLine(item.args);
          if (logLine) {
            // 写入系统日志文件（所有日志）
            this._fileLogManager.write(logLine);

            // 如果是debug日志且debug文件管理器存在，也写入debug文件
            // 使用入队时标记的isDebugLog，避免字符串匹配
            if (item.isDebugLog && this._debugFileLogManager) {
              this._debugFileLogManager.write(logLine);
            }
          }
        }
      } catch (err) {
        // 日志输出失败，静默处理（避免无限循环）
        // 仅在 DEBUG 模式下输出到 stderr
        if (process.env.DEBUG === "true") {
          console.error("[AsyncLogger] Output error:", err);
        }
      }
    }

    // 检查队列是否还有日志
    if (this._queue.length > 0) {
      // 还有日志，继续处理
      // _processing 保持为 true，无需重新设置
      setImmediate(() => this._processQueue());
    } else {
      // 队列为空，释放锁
      this._processing = false;

      // 关键修复：释放锁后立即再次检查队列
      // 如果在释放锁的瞬间有新日志入队，立即重新获取锁
      // 这个 if 语句必须紧跟在 _processing = false 之后，避免竞态窗口
      if (this._queue.length > 0) {
        // 有新日志入队了，重新获取锁
        this._processing = true;
        setImmediate(() => this._processQueue());
      }
    }
  }

  /**
   * 同步刷新所有日志（用于进程退出时）
   * 确保所有日志都被输出，不会丢失
   */
  flushSync() {
    while (this._queue.length > 0) {
      const item = this._queue.shift();
      try {
        // 输出到控制台
        item.outputFn(...item.args);

        // 同时写入文件（移除ANSI颜色代码）
        if (item.args && item.args.length > 0) {
          const logLine = formatLogLine(item.args);
          if (logLine) {
            // 写入系统日志文件
            this._fileLogManager.write(logLine);

            // 如果是debug日志且debug文件管理器存在，也写入debug文件
            // 使用入队时标记的isDebugLog，避免字符串匹配
            if (item.isDebugLog && this._debugFileLogManager) {
              this._debugFileLogManager.write(logLine);
            }
          }
        }
      } catch (err) {
        // 忽略错误，尽力输出
      }
    }
    this._processing = false;

    // 刷新文件流
    this._fileLogManager.flushSync();
    if (this._debugFileLogManager) {
      this._debugFileLogManager.flushSync();
    }
  }
}

// 创建全局日志队列实例
const logQueue = new AsyncLogQueue();

/**
 * 异步日志输出函数
 * 将日志添加到队列，由队列批量处理
 */
function asyncLog(outputFn, ...args) {
  logQueue.enqueue(outputFn, ...args);
}

// 确保进程退出处理器只注册一次（使用全局标志）
if (!global.__loggerExitHandlersRegistered) {
  global.__loggerExitHandlersRegistered = true;

  // 进程退出时同步刷新日志，确保不丢失
  process.on("beforeExit", () => {
    logQueue.flushSync();
    // 关闭文件流
    if (logQueue._fileLogManager) {
      logQueue._fileLogManager.close();
    }
    if (logQueue._debugFileLogManager) {
      logQueue._debugFileLogManager.close();
    }
  });

  process.on("SIGINT", () => {
    logQueue.flushSync();
    // 关闭文件流
    if (logQueue._fileLogManager) {
      logQueue._fileLogManager.close();
    }
    if (logQueue._debugFileLogManager) {
      logQueue._debugFileLogManager.close();
    }
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    logQueue.flushSync();
    // 关闭文件流
    if (logQueue._fileLogManager) {
      logQueue._fileLogManager.close();
    }
    if (logQueue._debugFileLogManager) {
      logQueue._debugFileLogManager.close();
    }
    process.exit(0);
  });

  // 未捕获异常时也刷新日志
  process.on("uncaughtException", (err) => {
    logQueue.flushSync();
    // 关闭文件流
    if (logQueue._fileLogManager) {
      logQueue._fileLogManager.close();
    }
    if (logQueue._debugFileLogManager) {
      logQueue._debugFileLogManager.close();
    }
    console.error("[FATAL] Uncaught Exception:", err);
    process.exit(1);
  });

  // 处理未处理的Promise拒绝
  process.on("unhandledRejection", (reason, promise) => {
    logQueue.flushSync();
    // 注意：这里不关闭文件流，因为可能还有其他日志需要写入
    console.error(
      "[FATAL] Unhandled Rejection at:",
      promise,
      "reason:",
      reason
    );
  });
}

export const logger = {
  debug(msg, extra) {
    // debug 级别日志，默认不输出（可以通过环境变量控制）
    if (process.env.DEBUG === "true") {
      const timestamp = toBeijingTimeLog();
      if (extra) {
        asyncLog(
          console.log,
          `${colors.gray}[DEBUG] ${timestamp} ${msg}${colors.reset}`,
          extra
        );
      } else {
        asyncLog(
          console.log,
          `${colors.gray}[DEBUG] ${timestamp} ${msg}${colors.reset}`
        );
      }
    }
  },
  info(msg, extra) {
    const timestamp = toBeijingTimeLog();
    if (extra) {
      asyncLog(console.log, `[INFO] ${timestamp} ${msg}`, extra);
    } else {
      asyncLog(console.log, `[INFO] ${timestamp} ${msg}`);
    }
  },
  warn(msg, extra) {
    const timestamp = toBeijingTimeLog();
    if (extra) {
      asyncLog(
        console.warn,
        `${colors.yellow}[WARN] ${timestamp} ${msg}${colors.reset}`,
        extra
      );
    } else {
      asyncLog(
        console.warn,
        `${colors.yellow}[WARN] ${timestamp} ${msg}${colors.reset}`
      );
    }
  },
  error(msg, extra) {
    const timestamp = toBeijingTimeLog();
    if (extra) {
      asyncLog(
        console.error,
        `${colors.red}[ERROR] ${timestamp} ${msg}${colors.reset}`,
        extra
      );
    } else {
      asyncLog(
        console.error,
        `${colors.red}[ERROR] ${timestamp} ${msg}${colors.reset}`
      );
    }
  },
};
