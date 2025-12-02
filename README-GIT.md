# Git 仓库管理说明

本项目已配置本地 Git 仓库，支持每日自动提交代码更新。

## 快速开始

### 1. 初始化 Git 仓库

首次使用时，运行以下命令初始化 Git 仓库：

```bash
npm run setup-git
```

这将：
- 初始化 Git 仓库（如果尚未初始化）
- 创建 `.gitignore` 文件
- 进行首次提交

### 2. 手动提交代码

可以随时手动执行自动提交：

```bash
npm run auto-commit
```

## 自动提交配置

### Windows 系统

使用 PowerShell 以管理员身份运行：

```powershell
# 进入项目目录
cd D:\code\LongBrigeAutomationProgram

# 运行设置脚本
powershell -ExecutionPolicy Bypass -File scripts/schedule-windows.ps1
```

这将创建一个 Windows 任务计划程序任务，每天凌晨 2:00 自动执行代码提交。

**手动管理任务：**
```powershell
# 查看任务
Get-ScheduledTask -TaskName LongBridgeAutoCommit

# 立即运行任务
Start-ScheduledTask -TaskName LongBridgeAutoCommit

# 删除任务
Unregister-ScheduledTask -TaskName LongBridgeAutoCommit -Confirm:$false
```

### Linux/Mac 系统

```bash
# 给脚本添加执行权限
chmod +x scripts/schedule-linux.sh

# 运行设置脚本
./scripts/schedule-linux.sh
```

这将添加一个 cron 任务，每天凌晨 2:00 自动执行代码提交。

**手动管理任务：**
```bash
# 查看所有定时任务
crontab -l

# 编辑定时任务
crontab -e

# 删除自动提交任务
crontab -l | grep -v 'auto-commit.js' | crontab -
```

## 自动提交行为

- **提交时间**: 每天凌晨 2:00（可自定义）
- **提交消息**: `每日自动提交: YYYY-MM-DD`
- **提交内容**: 所有未提交的代码更改
- **智能检测**: 如果没有更改，不会创建空提交

## 日志

自动提交的日志会保存在：
- Windows: 任务计划程序日志
- Linux/Mac: `logs/auto-commit.log`

## 注意事项

1. **首次使用**: 需要先运行 `npm run setup-git` 初始化仓库
2. **敏感信息**: `.env` 文件已添加到 `.gitignore`，不会被提交
3. **日志文件**: `logs/` 目录已添加到 `.gitignore`
4. **node_modules**: 依赖包不会被提交

## 自定义配置

### 修改提交时间

**Windows**: 编辑 `scripts/schedule-windows.ps1`，修改 `-At "02:00"` 部分

**Linux/Mac**: 编辑 `scripts/schedule-linux.sh`，修改 cron 表达式 `0 2 * * *`（格式：分钟 小时 日 月 星期）

### 修改提交消息格式

编辑 `scripts/auto-commit.js`，修改 `commitMessage` 变量

## 故障排除

### Git 仓库未初始化

如果遇到 "not a git repository" 错误，运行：
```bash
npm run setup-git
```

### 权限问题

**Windows**: 确保以管理员身份运行 PowerShell

**Linux/Mac**: 确保脚本有执行权限：
```bash
chmod +x scripts/schedule-linux.sh
chmod +x scripts/auto-commit.js
```

### 查看自动提交日志

**Windows**: 在任务计划程序中查看任务历史

**Linux/Mac**: 查看日志文件：
```bash
tail -f logs/auto-commit.log
```

