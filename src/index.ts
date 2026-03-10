/**
 * LongBridge 港股自动化量化交易系统 - 薄入口模块
 *
 * 职责：
 * - 初始化 dotenv 环境变量
 * - 调用 app 顶层组装入口
 * - 在最外层统一处理启动异常输出
 */
import dotenv from 'dotenv';
import { runApp } from './app/runApp.js';

dotenv.config({ path: '.env.local' });

try {
  await runApp({ env: process.env });
} catch (err: unknown) {
  if (err instanceof Error) {
    if (err.name === 'ConfigValidationError') {
      console.error('程序启动失败：配置验证未通过');
      process.exit(1);
    }

    if (err.name === 'AppStartupAbortError') {
      process.exit(1);
    }
  }

  console.error('程序异常退出', err);
  process.exit(1);
}
