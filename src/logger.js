// 简单日志封装：统一输出格式，便于后续替换为专业日志库
// 使用异步队列批量处理日志输出，避免阻塞主循环
import { toBeijingTimeLog } from "./utils.js";

// ANSI 颜色代码
export const colors = {
  reset: "\x1b[0m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  green: "\x1b[32m",
};

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
  }

  /**
   * 添加日志到队列
   * @param {Function} outputFn 输出函数（console.log/warn/error）
   * @param {Array} args 日志参数
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

    // 日志入队
    this._queue.push({ outputFn, args });

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
        item.outputFn(...item.args);
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
        item.outputFn(...item.args);
      } catch (err) {
        // 忽略错误，尽力输出
      }
    }
    this._processing = false;
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
  });

  process.on("SIGINT", () => {
    logQueue.flushSync();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    logQueue.flushSync();
    process.exit(0);
  });

  // 未捕获异常时也刷新日志
  process.on("uncaughtException", (err) => {
    logQueue.flushSync();
    console.error("[FATAL] Uncaught Exception:", err);
    process.exit(1);
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

  /**
   * 手动刷新日志（用于测试或特殊场景）
   * 同步输出所有待处理的日志
   */
  flush() {
    logQueue.flushSync();
  },
};
