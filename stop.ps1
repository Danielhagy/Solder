# Solder - Stop Script for Windows

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host "Stopping Solder services..." -ForegroundColor Yellow

# Stop any running jobs
Get-Job | Where-Object { $_.State -eq 'Running' } | Stop-Job
Get-Job | Remove-Job -Force

# Stop Docker services
docker-compose down

Write-Host "All services stopped." -ForegroundColor Green
