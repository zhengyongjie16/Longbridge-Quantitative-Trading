# 设置 Git filter 的脚本（Windows PowerShell）
# 使用方法: .\scripts\setup-git-filter.ps1

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir

# 转换为绝对路径
$ProjectRoot = (Resolve-Path $ProjectRoot).Path

$CleanScriptSonar = Join-Path $ProjectRoot "scripts\git-filter-clean-env.js"
$SmudgeScriptSonar = Join-Path $ProjectRoot "scripts\git-filter-smudge-env.js"
$CleanScriptLocal = Join-Path $ProjectRoot "scripts\git-filter-clean-env-local.js"
$SmudgeScriptLocal = Join-Path $ProjectRoot "scripts\git-filter-smudge-env-local.js"

# 确保路径使用反斜杠（Windows 路径格式）
$CleanScriptSonar = $CleanScriptSonar -replace '/', '\'
$SmudgeScriptSonar = $SmudgeScriptSonar -replace '/', '\'
$CleanScriptLocal = $CleanScriptLocal -replace '/', '\'
$SmudgeScriptLocal = $SmudgeScriptLocal -replace '/', '\'

Write-Host "项目根目录: $ProjectRoot" -ForegroundColor Cyan
Write-Host ""

# 配置 Git filter for .env.sonar（使用双引号转义）
git config filter.clean-env-sonar.clean "node \"$CleanScriptSonar\""
git config filter.clean-env-sonar.smudge "node \"$SmudgeScriptSonar\""

# 配置 Git filter for .env.local
git config filter.clean-env-local.clean "node \"$CleanScriptLocal\""
git config filter.clean-env-local.smudge "node \"$SmudgeScriptLocal\""

Write-Host "✅ Git filter 配置完成！" -ForegroundColor Green
Write-Host ""
Write-Host "清理脚本 (.env.sonar): $CleanScriptSonar"
Write-Host "恢复脚本 (.env.sonar): $SmudgeScriptSonar"
Write-Host "清理脚本 (.env.local): $CleanScriptLocal"
Write-Host "恢复脚本 (.env.local): $SmudgeScriptLocal"
Write-Host ""
Write-Host "验证配置:"
git config --get filter.clean-env-sonar.clean
git config --get filter.clean-env-sonar.smudge
git config --get filter.clean-env-local.clean
git config --get filter.clean-env-local.smudge
