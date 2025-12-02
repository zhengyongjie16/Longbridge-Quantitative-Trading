# Windows 任务计划程序脚本
# 用于设置每天自动提交代码的定时任务

$taskName = "LongBridgeAutoCommit"
$scriptPath = Join-Path $PSScriptRoot ".." "node_modules\.bin\auto-commit.cmd"
$projectPath = Join-Path $PSScriptRoot ".."

# 检查任务是否已存在
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

if ($existingTask) {
    Write-Host "任务已存在，正在删除旧任务..."
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

Write-Host "正在创建定时任务..."

# 创建动作：每天运行一次
$action = New-ScheduledTaskAction -Execute "node.exe" -Argument "scripts/auto-commit.js" -WorkingDirectory $projectPath

# 创建触发器：每天凌晨2点执行
$trigger = New-ScheduledTaskTrigger -Daily -At "02:00"

# 创建设置
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

# 注册任务
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "每天自动提交代码更新" | Out-Null

Write-Host "✅ 定时任务创建成功！"
Write-Host "任务名称: $taskName"
Write-Host "执行时间: 每天凌晨2:00"
Write-Host ""
Write-Host "可以使用以下命令管理任务："
Write-Host "  查看任务: Get-ScheduledTask -TaskName $taskName"
Write-Host "  删除任务: Unregister-ScheduledTask -TaskName $taskName -Confirm:`$false"
Write-Host "  立即运行: Start-ScheduledTask -TaskName $taskName"

