# 移除 Git filter 配置的脚本（Windows PowerShell）
# 使用方法: .\scripts\remove-git-filter.ps1

Write-Host "正在移除 Git filter 配置..." -ForegroundColor Cyan

# 移除 .env.sonar 的 filter 配置
git config --unset filter.clean-env-sonar.clean 2>$null
git config --unset filter.clean-env-sonar.smudge 2>$null

# 移除 .env.local 的 filter 配置
git config --unset filter.clean-env-local.clean 2>$null
git config --unset filter.clean-env-local.smudge 2>$null

Write-Host "✅ Git filter 配置已移除！" -ForegroundColor Green
Write-Host ""
Write-Host "验证配置（应该没有任何输出）:" -ForegroundColor Yellow
$sonarClean = git config --get filter.clean-env-sonar.clean 2>$null
$sonarSmudge = git config --get filter.clean-env-sonar.smudge 2>$null
$localClean = git config --get filter.clean-env-local.clean 2>$null
$localSmudge = git config --get filter.clean-env-local.smudge 2>$null

if (-not $sonarClean) { Write-Host "  ✓ .env.sonar clean filter 已移除" -ForegroundColor Green }
if (-not $sonarSmudge) { Write-Host "  ✓ .env.sonar smudge filter 已移除" -ForegroundColor Green }
if (-not $localClean) { Write-Host "  ✓ .env.local clean filter 已移除" -ForegroundColor Green }
if (-not $localSmudge) { Write-Host "  ✓ .env.local smudge filter 已移除" -ForegroundColor Green }

Write-Host ""
Write-Host "注意：如果文件被标记为 assume-unchanged，请手动取消：" -ForegroundColor Yellow
Write-Host "  git update-index --no-assume-unchanged .env.sonar"
Write-Host "  git update-index --no-assume-unchanged .env.local"
