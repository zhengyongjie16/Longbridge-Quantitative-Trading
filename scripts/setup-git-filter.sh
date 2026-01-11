#!/bin/bash
# 设置 Git filter 的脚本（Linux/macOS/Git Bash）
# 使用方法: bash scripts/setup-git-filter.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CLEAN_SCRIPT_SONAR="$PROJECT_ROOT/scripts/git-filter-clean-env.js"
SMUDGE_SCRIPT_SONAR="$PROJECT_ROOT/scripts/git-filter-smudge-env.js"
CLEAN_SCRIPT_LOCAL="$PROJECT_ROOT/scripts/git-filter-clean-env-local.js"
SMUDGE_SCRIPT_LOCAL="$PROJECT_ROOT/scripts/git-filter-smudge-env-local.js"

# 配置 Git filter for .env.sonar
git config filter.clean-env-sonar.clean "node \"$CLEAN_SCRIPT_SONAR\""
git config filter.clean-env-sonar.smudge "node \"$SMUDGE_SCRIPT_SONAR\""

# 配置 Git filter for .env.local
git config filter.clean-env-local.clean "node \"$CLEAN_SCRIPT_LOCAL\""
git config filter.clean-env-local.smudge "node \"$SMUDGE_SCRIPT_LOCAL\""

echo "✅ Git filter 配置完成！"
echo ""
echo "清理脚本 (.env.sonar): $CLEAN_SCRIPT_SONAR"
echo "恢复脚本 (.env.sonar): $SMUDGE_SCRIPT_SONAR"
echo "清理脚本 (.env.local): $CLEAN_SCRIPT_LOCAL"
echo "恢复脚本 (.env.local): $SMUDGE_SCRIPT_LOCAL"
echo ""
echo "验证配置:"
git config --get filter.clean-env-sonar.clean
git config --get filter.clean-env-sonar.smudge
git config --get filter.clean-env-local.clean
git config --get filter.clean-env-local.smudge
