#!/bin/bash
# 移除 Git filter 配置的脚本（Linux/macOS/Git Bash）
# 使用方法: bash scripts/remove-git-filter.sh

echo "正在移除 Git filter 配置..."

# 移除 .env.sonar 的 filter 配置
git config --unset filter.clean-env-sonar.clean 2>/dev/null
git config --unset filter.clean-env-sonar.smudge 2>/dev/null

# 移除 .env.local 的 filter 配置
git config --unset filter.clean-env-local.clean 2>/dev/null
git config --unset filter.clean-env-local.smudge 2>/dev/null

echo "✅ Git filter 配置已移除！"
echo ""
echo "验证配置（应该没有任何输出）:"
git config --get filter.clean-env-sonar.clean 2>/dev/null || echo "  ✓ .env.sonar clean filter 已移除"
git config --get filter.clean-env-sonar.smudge 2>/dev/null || echo "  ✓ .env.sonar smudge filter 已移除"
git config --get filter.clean-env-local.clean 2>/dev/null || echo "  ✓ .env.local clean filter 已移除"
git config --get filter.clean-env-local.smudge 2>/dev/null || echo "  ✓ .env.local smudge filter 已移除"
echo ""
echo "注意：如果文件被标记为 assume-unchanged，请手动取消："
echo "  git update-index --no-assume-unchanged .env.sonar"
echo "  git update-index --no-assume-unchanged .env.local"
