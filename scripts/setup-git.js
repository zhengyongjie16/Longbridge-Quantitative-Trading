#!/usr/bin/env node

/**
 * Git仓库初始化脚本
 * 初始化git仓库并进行首次提交
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

try {
  // 检查是否已经是git仓库
  try {
    execSync('git rev-parse --git-dir', {
      cwd: projectRoot,
      stdio: 'pipe'
    });
    console.log('Git仓库已存在');
  } catch (e) {
    // 不是git仓库，进行初始化
    console.log('正在初始化Git仓库...');
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

    console.log('Git仓库初始化成功');
  }

  // 添加所有文件
  console.log('正在添加文件...');
  execSync('git add -A', {
    cwd: projectRoot,
    stdio: 'inherit'
  });

  // 检查是否有未提交的更改
  try {
    const status = execSync('git status --porcelain', {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: 'pipe'
    });

    if (status.trim()) {
      const today = new Date().toISOString().split('T')[0];
      execSync(`git commit -m "初始提交: ${today}"`, {
        cwd: projectRoot,
        stdio: 'inherit'
      });
      console.log('首次提交完成');
    } else {
      console.log('没有需要提交的更改');
    }
  } catch (e) {
    console.log('首次提交完成');
  }

  console.log('\n✅ Git仓库设置完成！');
  console.log('\n提示：');
  console.log('1. 运行 npm run auto-commit 可以手动执行自动提交');
  console.log('2. 可以设置定时任务每天自动运行 npm run auto-commit');
  console.log('3. Windows可以使用任务计划程序，Linux/Mac可以使用cron');
} catch (error) {
  console.error('Git仓库设置失败:', error.message);
  process.exit(1);
}

