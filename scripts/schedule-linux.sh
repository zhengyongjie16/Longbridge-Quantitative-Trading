#!/bin/bash

# Linux/Mac cron 定时任务设置脚本
# 用于设置每天自动提交代码的定时任务

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AUTO_COMMIT_SCRIPT="$SCRIPT_DIR/auto-commit.js"

# 检查crontab中是否已存在该任务
CRON_JOB="0 2 * * * cd $PROJECT_ROOT && node $AUTO_COMMIT_SCRIPT >> $PROJECT_ROOT/logs/auto-commit.log 2>&1"

if crontab -l 2>/dev/null | grep -q "auto-commit.js"; then
    echo "定时任务已存在，正在更新..."
    # 删除旧任务
    crontab -l 2>/dev/null | grep -v "auto-commit.js" | crontab -
fi

# 添加新任务（每天凌晨2点执行）
(crontab -l 2>/dev/null; echo "$CRON_JOB") | crontab -

echo "✅ 定时任务设置成功！"
echo "执行时间: 每天凌晨2:00"
echo ""
echo "可以使用以下命令管理任务："
echo "  查看任务: crontab -l"
echo "  编辑任务: crontab -e"
echo "  删除任务: crontab -l | grep -v 'auto-commit.js' | crontab -"
echo ""
echo "日志文件: $PROJECT_ROOT/logs/auto-commit.log"

