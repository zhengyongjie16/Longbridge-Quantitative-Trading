/**
 * 测试运行时全局初始化模块
 *
 * 功能/职责：
 * - 在所有测试文件加载前设置统一的测试运行时环境变量
 * - 将日志根目录固定到 tests/logs，避免污染正式运行日志目录
 * - 禁用 logger 的进程级全局钩子，避免测试进程副作用影响断言与退出行为
 */
import fs from 'node:fs';
import path from 'node:path';

const testLogRootDir = path.join(process.cwd(), 'tests', 'logs');

process.env['APP_RUNTIME_PROFILE'] = 'test';
process.env['APP_LOG_ROOT_DIR'] = testLogRootDir;
process.env['APP_ENABLE_PROCESS_HOOKS'] = 'false';

process.env.NODE_ENV ??= 'test';

if (!fs.existsSync(testLogRootDir)) {
  fs.mkdirSync(testLogRootDir, { recursive: true });
}
