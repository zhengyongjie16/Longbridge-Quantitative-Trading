@echo off
chcp 65001 >nul
title LongBridge 自动化交易系统

echo [检查] 启动初步检查...

REM 检查 Node.js 是否安装
node -v >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js
    pause
    exit /b 1
)

REM 检查 .env.local 文件是否存在
if not exist ".env.local" (
    echo [警告] 未找到 .env.local 文件，请先配置环境变量
    echo 请复制 .env.example 为 .env.local 并填写配置
    pause
    exit /b 1
)

REM 启动程序
echo [启动] 正在启动交易系统...
echo.
npm start

REM 程序退出后暂停
echo.
echo 程序已退出
pause