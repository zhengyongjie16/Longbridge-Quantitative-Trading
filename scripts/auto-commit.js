#!/usr/bin/env node

/**
 * 自动提交代码更新脚本
 * 每天自动提交一次代码更改
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// 获取当前日期
const today = new Date().toISOString().split('T')[0];
const commitMessage = `每日自动提交: ${today}`;

try {
  // 检查是否有未提交的更改
  const status = execSync('git status --porcelain', {
    cwd: projectRoot,
    encoding: 'utf-8',
    stdio: 'pipe'
  });

  if (!status.trim()) {
    console.log(`[${new Date().toLocaleString('zh-CN')}] 没有需要提交的更改`);
    process.exit(0);
  }

  console.log(`[${new Date().toLocaleString('zh-CN')}] 发现未提交的更改，开始自动提交...`);

  // 添加所有更改
  execSync('git add -A', {
    cwd: projectRoot,
    stdio: 'inherit'
  });

  // 提交更改
  execSync(`git commit -m "${commitMessage}"`, {
    cwd: projectRoot,
    stdio: 'inherit'
  });

  console.log(`[${new Date().toLocaleString('zh-CN')}] 自动提交成功: ${commitMessage}`);
} catch (error) {
  // 如果git仓库未初始化，尝试初始化
  if (error.message.includes('not a git repository')) {
    console.log(`[${new Date().toLocaleString('zh-CN')}] Git仓库未初始化，正在初始化...`);
    try {
      execSync('git init', {
        cwd: projectRoot,
        stdio: 'inherit'
      });
      
      // 设置默认分支为main
      try {
        execSync('git branch -M main', {
          cwd: projectRoot,
          stdio: 'pipe'
        });
      } catch (e) {
        // 忽略分支重命名错误
      }

      // 添加所有文件
      execSync('git add -A', {
        cwd: projectRoot,
        stdio: 'inherit'
      });

      // 首次提交
      execSync(`git commit -m "初始提交: ${today}"`, {
        cwd: projectRoot,
        stdio: 'inherit'
      });

      console.log(`[${new Date().toLocaleString('zh-CN')}] Git仓库初始化成功并完成首次提交`);
    } catch (initError) {
      console.error(`[${new Date().toLocaleString('zh-CN')}] Git仓库初始化失败:`, initError.message);
      process.exit(1);
    }
  } else {
    console.error(`[${new Date().toLocaleString('zh-CN')}] 自动提交失败:`, error.message);
    process.exit(1);
  }
}

