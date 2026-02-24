import pino from 'pino';
import { toHongKongTimeLog } from '../helpers/index.js';
import { IS_DEBUG, LOGGING, LOG_LEVELS, LOG_COLORS } from '../../constants/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { inspect } from 'node:util';
import type { LogObject, Logger } from './types.js';

/**
 * 保留目录下仅扩展名匹配且为文件的最新若干条，删除更早的。
 * 在写入当日文件前调用：若即将写入的文件已存在（覆盖/追加），保留数 = maxFiles；
 * 若即将新建文件，保留数 = max(0, maxFiles - 1)，写入后总数 ≤ maxFiles。
 * 仅依赖 fs/path，不依赖 logger，避免循环依赖。
 *
 * @param logDir 日志目录
 * @param maxFiles 最多保留文件数（含即将写入的当日文件）
 * @param extension 扩展名（不含点），如 'log'、'json'
 * @param currentFileName 即将写入的文件名（如 '2026-02-13.log'）。若传入且在目录中已存在，则按"覆盖"语义保留 maxFiles 个；否则按"新建"语义保留 maxFiles - 1 个
 * @returns 无返回值
 */
export function retainLatestLogFiles(
  logDir: string,
  maxFiles: number,
  extension: string,
  currentFileName?: string,
): void {
  if (maxFiles < 1) {
    return;
  }
  if (!fs.existsSync(logDir)) {
    return;
  }

  const extSuffix = '.' + extension;
  const names = fs.readdirSync(logDir);
  const files: string[] = [];

  for (const name of names) {
    if (!name.endsWith(extSuffix)) {
      continue;
    }
    const fullPath = path.join(logDir, name);
    try {
      if (fs.statSync(fullPath).isFile()) {
        files.push(name);
      }
    } catch {
      // 无法 stat 的项跳过
    }
  }

  files.sort((a, b) => a.localeCompare(b, 'en'));
  const n = files.length;
  const isOverwriting = typeof currentFileName === 'string' && files.includes(currentFileName);
  const toRetain = isOverwriting ? maxFiles : Math.max(0, maxFiles - 1);
  const toDelete = Math.max(0, n - toRetain);

  for (let i = 0; i < toDelete; i++) {
    const file = files[i];
    if (file === undefined) {
      continue;
    }
    const fullPath = path.join(logDir, file);
    try {
      fs.unlinkSync(fullPath);
    } catch (err) {
      console.error(`[logRetention] 删除旧日志失败: ${fullPath}`, err);
    }
  }
}

/**
 * 格式化额外数据为字符串
 * @param extra 待格式化的数据
 * @returns 格式化后的字符串表示
 */
function formatExtra(extra: unknown): string {
  return inspect(extra, { depth: 5, maxArrayLength: 100 });
}

/**
 * 按日期分割的文件流（用于 pino 传输）
 * 例外：继承 Node.js Writable，与 Stream API 集成，无法改为工厂函数。
 */
class DateRotatingStream extends Writable {
  private readonly _logSubDir: string;
  private readonly _logDir: string;
  private _currentDate: string | null = null;
  private _fileStream: fs.WriteStream | null = null;
  private _rotatePromise: Promise<void> | null = null; // Promise队列，确保串行执行

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
   * 获取当前香港时间日期字符串 (YYYY-MM-DD)
   */
  private _getCurrentDate(): string {
    const timestamp = toHongKongTimeLog(new Date());
    // 从 "YYYY-MM-DD HH:mm:ss.sss" 提取日期部分
    const datePart = timestamp.split(' ').at(0);
    return datePart ?? '';
  }

  /**
   * 检查并切换日志文件（如果日期变化）
   * 使用 Promise 队列确保串行执行，避免并发问题
   * @returns Promise，确保旧流关闭完成后再继续
   */
  private async _checkRotate(): Promise<void> {
    const today = this._getCurrentDate();

    // 如果日期没有变化，直接返回
    if (this._currentDate === today) {
      return;
    }

    // 如果已有 rotate 正在进行，加入队列等待
    if (this._rotatePromise) {
      await this._rotatePromise;
      // 等待完成后重新检查日期（可能已被其他调用处理）
      if (this._currentDate === today) {
        return;
      }
    }

    // 创建新的 rotate Promise 并加入队列
    this._rotatePromise = this._doRotate(today);

    try {
      await this._rotatePromise;
    } finally {
      // 清空队列标志
      this._rotatePromise = null;
    }
  }

  /**
   * 执行实际的日志轮转操作
   * @param newDate 新日期字符串
   */
  private async _doRotate(newDate: string): Promise<void> {
    try {
      // 关闭旧文件流
      if (this._fileStream) {
        const oldStream = this._fileStream;
        this._fileStream = null;

        await new Promise<void>((resolve) => {
          oldStream.once('finish', () => { resolve(); });
          oldStream.once('error', (err) => {
            console.error('[DateRotatingStream] 关闭旧流错误:', err);
            resolve(); // 即使出错也继续
          });
          oldStream.end();
        });
      }

      // 更新日期并打开新文件流
      this._currentDate = newDate;
      const currentLogFileName = `${this._currentDate}.log`;
      retainLatestLogFiles(this._logDir, LOGGING.MAX_RETAINED_LOG_FILES, 'log', currentLogFileName);
      const logFile = path.join(this._logDir, currentLogFileName);
      this._fileStream = fs.createWriteStream(logFile, {
        flags: 'a',
        encoding: 'utf8',
      });

      this._fileStream.on('error', (err) => {
        console.error(`[DateRotatingStream] 文件流错误 (${this._logSubDir}):`, err);
      });
    } catch (err) {
      console.error(`[DateRotatingStream] 日志轮转失败 (${this._logSubDir}):`, err);
    }
  }

  /**
   * 实现 Writable._write 方法
   */
  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    // 使用立即执行函数处理异步操作
    void (async () => {
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
            const { onDrain } = createDrainHandler(
              currentStream,
              LOGGING.DRAIN_TIMEOUT_MS,
              callback,
              () => {
                if (IS_DEBUG) {
                  console.error(`[DateRotatingStream] drain 超时 (${this._logSubDir})`);
                }
              },
            );

            currentStream.once('drain', onDrain);
          }
        } else {
          // 如果文件流不可用，记录错误但不阻塞
          if (IS_DEBUG) {
            console.error(`[DateRotatingStream] 文件流不可用 (${this._logSubDir})`);
          }
          callback();
        }
      } catch (err) {
        // 记录错误但不阻塞日志系统
        console.error(`[DateRotatingStream] 写入失败 (${this._logSubDir}):`, err);
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
      } catch {
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
        stream.once('finish', () => { resolve(); });
        stream.once('error', () => { resolve(); }); // 即使出错也继续
        stream.end();
      });
    }
  }
}

/**
 * ANSI 转义字符（ESC，ASCII 27）
 * 使用 String.fromCodePoint 避免在正则表达式中直接使用控制字符
 */
const ANSI_ESC = String.fromCodePoint(27);

/**
 * ANSI 颜色代码正则表达式
 * 匹配格式：ESC[数字;数字;...m
 * 使用 String.raw 避免转义反斜杠，使用字符串拼接避免在正则表达式中直接使用控制字符
 */
const ANSI_CODE_REGEX = new RegExp(ANSI_ESC + String.raw`\[[0-9;]*m`, 'g');

/**
 * 移除字符串中的 ANSI 颜色/转义代码，用于文件日志输出时得到纯文本。
 *
 * @param str 可能包含 ANSI 代码的字符串
 * @returns 移除转义序列后的字符串
 */
function stripAnsiCodes(str: string): string {
  if (typeof str !== 'string') return str;
  return str.replaceAll(ANSI_CODE_REGEX, '');
}

function isLogObject(value: unknown): value is LogObject {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['level'] === 'number' &&
    typeof candidate['time'] === 'number' &&
    typeof candidate['msg'] === 'string'
  );
}

/**
 * 自定义格式化函数，将日志对象转换为文件输出格式
 * 移除 ANSI 颜色代码，输出纯文本格式
 * @param obj 日志对象
 * @returns 格式化后的日志行字符串
 */
function formatForFile(obj: LogObject): string {
  const level = obj.level;
  const timestamp = toHongKongTimeLog(new Date(obj.time));

  // 将数字 level 转换为文本
  const levelMap: Record<number, string> = {
    20: 'DEBUG',
    30: 'INFO',
    40: 'WARN',
    50: 'ERROR',
  };
  const levelStr = `[${levelMap[level] ?? 'INFO'}]`;

  let line = `${levelStr} ${timestamp} ${stripAnsiCodes(obj.msg)}`;

  // 处理额外数据
  if (obj.extra !== undefined && obj.extra !== null) {
    if (typeof obj.extra === 'object') {
      try {
        line += ` ${JSON.stringify(obj.extra)}`;
      } catch {
        line += ` ${stripAnsiCodes(formatExtra(obj.extra))}`;
      }
    } else {
      line += ` ${stripAnsiCodes(formatExtra(obj.extra))}`;
    }
  }

  return line + '\n';
}

/**
 * 自定义格式化函数，将日志对象转换为控制台输出格式
 * 带颜色高亮，根据日志级别选择不同颜色
 * @param obj 日志对象
 * @returns 格式化后的日志行字符串
 */
function formatForConsole(obj: LogObject): string {
  const level = obj.level;
  const timestamp = toHongKongTimeLog(new Date(obj.time));

  // 将数字 level 转换为文本和颜色
  const levelConfig: Record<number, { name: string; color: string }> = {
    20: { name: 'DEBUG', color: LOG_COLORS.gray },
    30: { name: 'INFO', color: '' },
    40: { name: 'WARN', color: LOG_COLORS.yellow },
    50: { name: 'ERROR', color: LOG_COLORS.red },
  };

  const config = levelConfig[level] ?? { name: 'INFO', color: '' };
  const levelStr = `[${config.name}]`;
  const color = config.color;
  const reset = color ? LOG_COLORS.reset : '';

  let line = `${color}${levelStr} ${timestamp} ${obj.msg}${reset}`;

  // 处理额外数据
  if (obj.extra !== undefined && obj.extra !== null) {
    if (typeof obj.extra === 'object') {
      try {
        line += ` ${JSON.stringify(obj.extra)}`;
      } catch {
        line += ` ${formatExtra(obj.extra)}`;
      }
    } else {
      line += ` ${formatExtra(obj.extra)}`;
    }
  }

  return line + '\n';
}

// 创建文件流实例
const systemFileStream = new DateRotatingStream('system');
const debugFileStream = IS_DEBUG ? new DateRotatingStream('debug') : null;

/**
 * 创建带超时保护的 drain 事件处理器
 * 防止 drain 事件永远不触发导致日志系统阻塞，超时后仍调用 callback 继续处理
 * @param stream 文件流或进程流
 * @param timeout 超时时间（毫秒）
 * @param callback 完成回调函数
 * @param onTimeout 超时时的回调函数
 * @returns 包含 drain 事件处理器和超时 ID 的对象
 */
function createDrainHandler(
  stream: NodeJS.WriteStream | fs.WriteStream,
  timeout: number,
  callback: () => void,
  onTimeout?: () => void,
): { onDrain: () => void; timeoutId: NodeJS.Timeout } {
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
    onTimeout?.();
    callback(); // 超时后仍调用 callback 避免阻塞
  }, timeout);

  return { onDrain, timeoutId };
}

/**
 * 带超时保护的写入辅助函数
 * 防止 drain 事件永久不触发导致日志系统阻塞
 * @param stream 进程流（stdout/stderr）
 * @param data 待写入数据
 * @param timeout 超时时间（毫秒）
 * @param callback 完成回调函数
 * @returns 无返回值
 */
function writeWithDrainTimeout(
  stream: NodeJS.WriteStream,
  data: string,
  timeout: number,
  callback: () => void,
): void {
  const canContinue = stream.write(data);
  if (canContinue) {
    callback();
  } else {
    const { onDrain } = createDrainHandler(stream, timeout, callback);
    stream.once('drain', onDrain);
  }
}

// 创建控制台流（使用自定义格式）
const consoleStream = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    try {
      const parsed: unknown = JSON.parse(chunk.toString());
      if (!isLogObject(parsed)) {
        callback();
        return;
      }
      const obj = parsed;
      const formatted = formatForConsole(obj);

      // 根据日志级别选择输出流
      // ERROR (>=50) 和 WARN (>=40) 输出到 stderr，其他输出到 stdout
      if (obj.level >= LOG_LEVELS.WARN) {
        writeWithDrainTimeout(
          process.stderr,
          formatted,
          LOGGING.CONSOLE_DRAIN_TIMEOUT_MS,
          callback,
        );
      } else {
        writeWithDrainTimeout(
          process.stdout,
          formatted,
          LOGGING.CONSOLE_DRAIN_TIMEOUT_MS,
          callback,
        );
      }
    } catch (err) {
      // 解析或格式化失败时，至少输出原始内容
      try {
        const errorMessage = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[Logger Error] ${errorMessage}\n`);
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
        const parsed: unknown = JSON.parse(chunk.toString());
        if (!isLogObject(parsed)) {
          callback();
          return;
        }
        obj = parsed;
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
          }),
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
            }),
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
    })().catch((err: unknown) => {
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
  pino.multistream(streams),
);

/**
 * 导出的 logger 对象，保持与原有 API 兼容。
 * 输出同时写入控制台与按日期轮转的日志文件；DEBUG 级别仅在 DEBUG=true 时输出。
 */
export const logger: Logger = {
  /**
   * 输出调试级别日志，仅当 DEBUG=true 时生效。
   * @param msg - 日志消息
   * @param extra - 可选附加数据（对象或原始值）
   * @returns 无返回值
   */
  debug(msg: string, extra?: unknown): void {
    if (IS_DEBUG) {
      if (extra === null || extra === undefined) {
        pinoLogger.debug(msg);
      } else {
        pinoLogger.debug({ extra }, msg);
      }
    }
  },

  /**
   * 输出信息级别日志。
   * @param msg - 日志消息
   * @param extra - 可选附加数据（对象或原始值）
   * @returns 无返回值
   */
  info(msg: string, extra?: unknown): void {
    if (extra === null || extra === undefined) {
      pinoLogger.info(msg);
    } else {
      pinoLogger.info({ extra }, msg);
    }
  },

  /**
   * 输出警告级别日志（同时输出到 stderr）。
   * @param msg - 日志消息
   * @param extra - 可选附加数据（对象或原始值）
   * @returns 无返回值
   */
  warn(msg: string, extra?: unknown): void {
    if (extra === null || extra === undefined) {
      pinoLogger.warn(msg);
    } else {
      pinoLogger.warn({ extra }, msg);
    }
  },

  /**
   * 输出错误级别日志（同时输出到 stderr）。
   * @param msg - 日志消息
   * @param extra - 可选附加数据（对象或原始值）
   * @returns 无返回值
   */
  error(msg: string, extra?: unknown): void {
    if (extra === null || extra === undefined) {
      pinoLogger.error(msg);
    } else {
      pinoLogger.error({ extra }, msg);
    }
  },
};

// 同步清理的状态标志
let isSyncCleaningUp = false;

/**
 * 同步清理函数：进程退出时刷新日志缓冲并关闭文件流，防止日志丢失；在 beforeExit/exit/uncaughtException/unhandledRejection 中调用。使用状态标志避免重复执行。
 *
 * @returns 无返回值
 */
function cleanupSync(): void {
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

// exit 事件处理（覆盖 process.exit() 场景）
// 注意：process.exit() 不会触发 beforeExit，但会触发 exit
process.on('exit', () => {
  cleanupSync();
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
