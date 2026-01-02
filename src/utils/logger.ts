/**
 * 日志系统模块
 *
 * 功能：
 * - 基于 pino 的高性能日志系统
 * - 双流输出：同时输出到控制台和文件
 * - 按日期自动分割日志文件
 * - 支持 DEBUG/INFO/WARN/ERROR 级别
 *
 * 日志目录：
 * - logs/system/：系统日志（所有级别）
 * - logs/debug/：调试日志（仅 DEBUG 级别，需设置 DEBUG=true）
 *
 * 特性：
 * - 异步队列批量处理，避免阻塞主循环
 * - 控制台输出带颜色高亮
 * - 文件输出纯文本格式
 * - 进程信号处理和异常捕获
 */

import pino from 'pino';
import { toBeijingTimeLog } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';

// 缓存 DEBUG 环境变量，避免重复读取
const IS_DEBUG = process.env.DEBUG === 'true';

// 日志级别常量
const LOG_LEVELS = {
  DEBUG: 20,
  INFO: 30,
  WARN: 40,
  ERROR: 50,
} as const;

type LogLevel = (typeof LOG_LEVELS)[keyof typeof LOG_LEVELS];

// ANSI 颜色代码（保持兼容性）
export const colors = {
  reset: '\x1b[0m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  green: '\x1b[32m',
} as const;

/**
 * 日志对象接口
 */
interface LogObject {
  level: LogLevel;
  time: number;
  msg: string;
  extra?: unknown;
}

/**
 * 按日期分割的文件流（用于 pino 传输）
 */
class DateRotatingStream extends Writable {
  private _logSubDir: string;
  private _logDir: string;
  private _currentDate: string | null = null;
  private _fileStream: fs.WriteStream | null = null;
  private _isRotating: boolean = false; // 防止并发 rotate

  constructor(logSubDir: string = 'system') {
    super();
    this._logSubDir = logSubDir;
    this._logDir = path.join(process.cwd(), 'logs', logSubDir);

    // 确保日志目录存在
    if (!fs.existsSync(this._logDir)) {
      fs.mkdirSync(this._logDir, { recursive: true });
    }
  }

  /**
   * 获取当前北京时间日期字符串 (YYYY-MM-DD)
   */
  private _getCurrentDate(): string {
    const timestamp = toBeijingTimeLog(new Date());
    // 从 "YYYY-MM-DD HH:mm:ss.sss" 提取日期部分
    return timestamp.split(' ')[0]!;
  }

  /**
   * 检查并切换日志文件（如果日期变化）
   * 返回 Promise，确保旧流关闭完成后再继续
   */
  private async _checkRotate(): Promise<void> {
    const today = this._getCurrentDate();

    // 如果日期没有变化，直接返回
    if (this._currentDate === today) {
      return;
    }

    // 如果正在 rotate，等待完成
    if (this._isRotating) {
      // 简单的自旋等待，最多等待 1 秒
      const startTime = Date.now();
      while (this._isRotating && Date.now() - startTime < 1000) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      // 等待完成后重新检查日期
      if (this._currentDate === today) {
        return;
      }
      // 如果超时或仍在 rotating，再次检查 rotating 标志
      if (this._isRotating) {
        console.error(
          `[DateRotatingStream] rotate 超时 (${this._logSubDir})，强制继续`
        );
        // 重置标志，允许继续（但需要再次检查日期，避免重复 rotate）
        this._isRotating = false;
      }
      // 再次检查日期和 rotating 标志（防止竞态）
      if (this._currentDate === today || this._isRotating) {
        return;
      }
    }

    // 设置 rotating 标志（使用 CAS 思想）
    const previousRotating = this._isRotating;
    this._isRotating = true;
    if (previousRotating) {
      // 竞态：另一个调用已经先设置了标志，回退
      return;
    }

    try {
      // 关闭旧文件流
      if (this._fileStream) {
        const oldStream = this._fileStream;
        this._fileStream = null;

        await new Promise<void>((resolve) => {
          oldStream.once('finish', () => resolve());
          oldStream.once('error', (err) => {
            // 始终记录错误，不仅在 DEBUG 模式
            console.error('[DateRotatingStream] 关闭旧流错误:', err);
            resolve(); // 即使出错也继续
          });
          oldStream.end();
        });
      }

      // 更新日期并打开新文件流
      this._currentDate = today;
      const logFile = path.join(this._logDir, `${this._currentDate}.log`);
      this._fileStream = fs.createWriteStream(logFile, {
        flags: 'a',
        encoding: 'utf8',
      });

      this._fileStream.on('error', (err) => {
        console.error(
          `[DateRotatingStream] 文件流错误 (${this._logSubDir}):`,
          err
        );
      });
    } finally {
      // 确保 rotating 标志被释放
      this._isRotating = false;
    }
  }

  /**
   * 实现 Writable._write 方法
   */
  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    // 使用立即执行函数处理异步操作
    (async () => {
      try {
        await this._checkRotate();

        if (this._fileStream?.writable) {
          // 保存当前流的引用，防止在等待 drain 时流被替换
          const currentStream = this._fileStream;
          // 文件流的 write 方法可能是同步或异步的
          // 如果返回 false，表示需要等待 drain 事件
          const canContinue = currentStream.write(chunk, encoding);
          if (canContinue) {
            callback();
          } else {
            // 添加超时保护，防止 drain 事件永远不触发导致阻塞
            const DRAIN_TIMEOUT = 5000;
            let resolved = false;

            const onDrain = (): void => {
              if (resolved) return;
              resolved = true;
              clearTimeout(timeoutId);
              callback();
            };

            const timeoutId = setTimeout(() => {
              if (resolved) return;
              resolved = true;
              currentStream.removeListener('drain', onDrain);
              if (IS_DEBUG) {
                console.error(
                  `[DateRotatingStream] drain 超时 (${this._logSubDir})`
                );
              }
              callback(); // 超时后仍调用 callback 避免阻塞
            }, DRAIN_TIMEOUT);

            currentStream.once('drain', onDrain);
          }
        } else {
          // 如果文件流不可用，记录错误但不阻塞
          if (IS_DEBUG) {
            console.error(
              `[DateRotatingStream] 文件流不可用 (${this._logSubDir})`
            );
          }
          callback();
        }
      } catch (err) {
        // 记录错误但不阻塞日志系统
        console.error(
          `[DateRotatingStream] 写入失败 (${this._logSubDir}):`,
          err
        );
        callback();
      }
    })();
  }

  /**
   * 同步关闭文件流
   */
  closeSync(): void {
    if (this._fileStream) {
      try {
        // 同步结束流（不等待）
        this._fileStream.end();
        this._fileStream = null;
      } catch (err) {
        // 忽略错误
      }
    }
  }

  /**
   * 异步关闭文件流，返回 Promise
   */
  async closeAsync(): Promise<void> {
    if (this._fileStream) {
      const stream = this._fileStream;
      this._fileStream = null;

      return new Promise((resolve) => {
        stream.once('finish', () => resolve());
        stream.once('error', () => resolve()); // 即使出错也继续
        stream.end();
      });
    }
    return Promise.resolve();
  }
}

/**
 * 移除 ANSI 颜色代码
 */
function stripAnsiCodes(str: string): string {
  if (typeof str !== 'string') return str;
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * 自定义格式化函数（用于文件输出）
 */
function formatForFile(obj: LogObject): string {
  const level = obj.level;
  const timestamp = toBeijingTimeLog(new Date(obj.time));

  // 将数字 level 转换为文本
  const levelMap: Record<number, string> = {
    20: 'DEBUG',
    30: 'INFO',
    40: 'WARN',
    50: 'ERROR',
  };
  const levelStr = `[${(levelMap[level] || 'INFO').padEnd(5)}]`;

  let line = `${levelStr} ${timestamp} ${stripAnsiCodes(String(obj.msg))}`;

  // 处理额外数据
  if (obj.extra !== undefined && obj.extra !== null) {
    if (typeof obj.extra === 'object') {
      try {
        line += ` ${JSON.stringify(obj.extra)}`;
      } catch {
        line += ` ${String(obj.extra)}`;
      }
    } else {
      line += ` ${stripAnsiCodes(String(obj.extra))}`;
    }
  }

  return line + '\n';
}

/**
 * 自定义格式化函数（用于控制台输出，带颜色）
 */
function formatForConsole(obj: LogObject): string {
  const level = obj.level;
  const timestamp = toBeijingTimeLog(new Date(obj.time));

  // 将数字 level 转换为文本和颜色
  const levelConfig: Record<number, { name: string; color: string }> = {
    20: { name: 'DEBUG', color: colors.gray },
    30: { name: 'INFO', color: '' },
    40: { name: 'WARN', color: colors.yellow },
    50: { name: 'ERROR', color: colors.red },
  };

  const config = levelConfig[level] || { name: 'INFO', color: '' };
  const levelStr = `[${config.name.padEnd(5)}]`;
  const color = config.color;
  const reset = color ? colors.reset : '';

  let line = `${color}${levelStr} ${timestamp} ${obj.msg}${reset}`;

  // 处理额外数据
  if (obj.extra !== undefined && obj.extra !== null) {
    if (typeof obj.extra === 'object') {
      try {
        line += ` ${JSON.stringify(obj.extra)}`;
      } catch {
        line += ` ${String(obj.extra)}`;
      }
    } else {
      line += ` ${obj.extra}`;
    }
  }

  return line + '\n';
}

// 创建文件流实例
const systemFileStream = new DateRotatingStream('system');
const debugFileStream = IS_DEBUG ? new DateRotatingStream('debug') : null;

// drain 超时时间常量
const CONSOLE_DRAIN_TIMEOUT = 3000;

/**
 * 带超时保护的写入辅助函数
 */
function writeWithDrainTimeout(
  stream: NodeJS.WriteStream,
  data: string,
  timeout: number,
  callback: () => void
): void {
  const canContinue = stream.write(data);
  if (canContinue) {
    callback();
  } else {
    let resolved = false;

    const onDrain = (): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      callback();
    };

    const timeoutId = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      stream.removeListener('drain', onDrain);
      callback(); // 超时后仍调用 callback 避免阻塞
    }, timeout);

    stream.once('drain', onDrain);
  }
}

// 创建控制台流（使用自定义格式）
const consoleStream = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    try {
      const obj: LogObject = JSON.parse(chunk.toString());
      const formatted = formatForConsole(obj);

      // 根据日志级别选择输出流
      // ERROR (>=50) 和 WARN (>=40) 输出到 stderr，其他输出到 stdout
      if (obj.level >= LOG_LEVELS.WARN) {
        writeWithDrainTimeout(
          process.stderr,
          formatted,
          CONSOLE_DRAIN_TIMEOUT,
          callback
        );
      } else {
        writeWithDrainTimeout(
          process.stdout,
          formatted,
          CONSOLE_DRAIN_TIMEOUT,
          callback
        );
      }
    } catch (err) {
      // 解析或格式化失败时，至少输出原始内容
      try {
        process.stderr.write(`[Logger Error] ${(err as Error).message}\n`);
      } catch {
        // 如果连 stderr 都失败，只能忽略
      }
      callback();
    }
  },
});

// 创建文件流（使用自定义格式）
const fileStream = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    // 使用立即执行函数处理异步操作
    (async () => {
      let obj: LogObject;
      try {
        obj = JSON.parse(chunk.toString());
      } catch (err) {
        try {
          console.error('[FileStream] JSON解析失败:', err);
        } catch {
          // 忽略
        }
        callback();
        return;
      }

      try {
        const formatted = formatForFile(obj);

        // 等待所有写入操作完成
        const writePromises: Promise<void>[] = [];

        // 写入系统日志
        writePromises.push(
          new Promise<void>((resolve) => {
            systemFileStream.write(formatted, (err) => {
              // 始终记录错误，不仅在 DEBUG 模式
              if (err) {
                console.error('[FileStream] 系统日志写入失败:', err);
              }
              resolve();
            });
          })
        );

        // 如果是 DEBUG 日志，同时写入 debug 日志
        if (obj.level === LOG_LEVELS.DEBUG && debugFileStream) {
          writePromises.push(
            new Promise<void>((resolve) => {
              debugFileStream.write(formatted, (err) => {
                // 始终记录错误，不仅在 DEBUG 模式
                if (err) {
                  console.error('[FileStream] Debug日志写入失败:', err);
                }
                resolve();
              });
            })
          );
        }

        // 等待所有写入完成
        await Promise.all(writePromises);
        callback();
      } catch (err) {
        // 格式化或写入失败时记录错误
        try {
          console.error('[FileStream] 处理日志失败:', err);
        } catch {
          // 忽略
        }
        callback();
      }
    })().catch((err) => {
      // 捕获 IIFE 中未处理的异常
      try {
        console.error('[FileStream] 未捕获的异常:', err);
      } catch {
        // 忽略
      }
      callback();
    });
  },
});

// 创建 pino 多流实例
const streams = [
  {
    level: IS_DEBUG ? 'debug' : 'info',
    stream: consoleStream,
  },
  {
    level: IS_DEBUG ? 'debug' : 'info',
    stream: fileStream,
  },
];

const pinoLogger = pino(
  {
    level: IS_DEBUG ? 'debug' : 'info',
    customLevels: {
      debug: LOG_LEVELS.DEBUG,
      info: LOG_LEVELS.INFO,
      warn: LOG_LEVELS.WARN,
      error: LOG_LEVELS.ERROR,
    },
    useOnlyCustomLevels: true,
  },
  pino.multistream(streams)
);

/**
 * Logger 接口定义
 */
export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

/**
 * 导出的 logger 对象，保持与原有 API 兼容
 */
export const logger: Logger = {
  debug(msg: string, extra?: unknown): void {
    if (IS_DEBUG) {
      if (extra == null) {
        pinoLogger.debug(msg);
      } else {
        pinoLogger.debug({ extra }, msg);
      }
    }
  },

  info(msg: string, extra?: unknown): void {
    if (extra == null) {
      pinoLogger.info(msg);
    } else {
      pinoLogger.info({ extra }, msg);
    }
  },

  warn(msg: string, extra?: unknown): void {
    if (extra == null) {
      pinoLogger.warn(msg);
    } else {
      pinoLogger.warn({ extra }, msg);
    }
  },

  error(msg: string, extra?: unknown): void {
    if (extra == null) {
      pinoLogger.error(msg);
    } else {
      pinoLogger.error({ extra }, msg);
    }
  },
};

// 同步清理的状态标志
let isSyncCleaningUp = false;

/**
 * 同步清理函数（用于进程退出）
 * 注意：此函数会在信号处理和异常处理中被调用
 */
export function cleanupSync(): void {
  if (isSyncCleaningUp) {
    return;
  }
  isSyncCleaningUp = true;

  try {
    // pino 的 flush() 是同步的
    pinoLogger.flush();

    // 同步关闭所有文件流
    systemFileStream.closeSync();
    if (debugFileStream) {
      debugFileStream.closeSync();
    }
  } catch (err) {
    // 清理过程中的错误不应该阻止退出
    try {
      console.error('[Logger] 同步清理过程出错:', err);
    } catch {
      // 忽略
    }
  }
}

// beforeExit 事件处理（使用同步清理）
process.on('beforeExit', () => {
  cleanupSync();
});

// SIGINT 处理（Ctrl+C）
process.on('SIGINT', () => {
  cleanupSync();
  process.exit(0);
});

// SIGTERM 处理
process.on('SIGTERM', () => {
  cleanupSync();
  process.exit(0);
});

// 未捕获的异常处理
process.on('uncaughtException', (err: Error) => {
  try {
    logger.error('未捕获的异常', err);
  } catch {
    try {
      console.error('未捕获的异常:', err);
    } catch {
      // 忽略
    }
  }
  cleanupSync();
  process.exit(1);
});

// 未处理的 Promise 拒绝
process.on('unhandledRejection', (reason: unknown) => {
  try {
    logger.error('未处理的 Promise 拒绝', reason);
  } catch {
    try {
      console.error('未处理的 Promise 拒绝:', reason);
    } catch {
      // 忽略
    }
  }
});
