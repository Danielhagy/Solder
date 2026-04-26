# Solder - Low-Code Integration Platform
# PowerShell Startup Script for Windows

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host ""
Write-Host "╔═══════════════════════════════════════════════════════════╗" -ForegroundColor Blue
Write-Host "║           SOLDER - Low-Code Integration Platform          ║" -ForegroundColor Blue
Write-Host "╚═══════════════════════════════════════════════════════════╝" -ForegroundColor Blue
Write-Host ""

# Function to test if a port is open
function Test-Port {
    param($Hostname, $Port, $Timeout = 1000)
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $result = $client.BeginConnect($Hostname, $Port, $null, $null)
        $wait = $result.AsyncWaitHandle.WaitOne($Timeout, $false)
        if ($wait) {
            $client.EndConnect($result)
            $client.Close()
            return $true
        }
        $client.Close()
        return $false
    } catch {
        return $false
    }
}

# Function to wait for service
function Wait-ForService {
    param($Hostname, $Port, $ServiceName, $MaxAttempts = 30)

    Write-Host "Waiting for $ServiceName to be ready..." -ForegroundColor Yellow
    $attempt = 1
    while (-not (Test-Port -Hostname $Hostname -Port $Port)) {
        if ($attempt -ge $MaxAttempts) {
            Write-Host "$ServiceName failed to start after $MaxAttempts attempts" -ForegroundColor Red
            return $false
        }
        Write-Host -NoNewline "."
        Start-Sleep -Seconds 2
        $attempt++
    }
    Write-Host ""
    Write-Host "$ServiceName is ready!" -ForegroundColor Green
    return $true
}

# Check prerequisites
Write-Host "[1/6] Checking prerequisites..." -ForegroundColor Blue

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "Error: Docker is not installed" -ForegroundColor Red
    exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Error: Node.js is not installed" -ForegroundColor Red
    exit 1
}

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host "Error: Python is not installed" -ForegroundColor Red
    exit 1
}

Write-Host "All prerequisites found!" -ForegroundColor Green

# Start Docker services
Write-Host ""
Write-Host "[2/6] Starting Docker services (PostgreSQL + Temporal)..." -ForegroundColor Blue
docker-compose up -d

# Wait for services
Wait-ForService -Hostname "localhost" -Port 5432 -ServiceName "PostgreSQL"
Wait-ForService -Hostname "localhost" -Port 7233 -ServiceName "Temporal"

# Setup backend
Write-Host ""
Write-Host "[3/6] Setting up backend..." -ForegroundColor Blue
Set-Location "$ScriptDir\backend"

# Install Python dependencies
if (Get-Command poetry -ErrorAction SilentlyContinue) {
    Write-Host "Using Poetry for dependency management..."
    poetry install --no-interaction
} else {
    Write-Host "Poetry not found, using pip..."
    pip install fastapi uvicorn sqlalchemy asyncpg alembic pydantic pydantic-settings httpx playwright pyyaml temporalio anthropic python-multipart
}

# Create .env if needed
if (-not (Test-Path ".env")) {
    Write-Host "Creating .env file..."
    @"
DATABASE_URL=postgresql+asyncpg://solder:solder_secret@localhost:5432/solder
TEMPORAL_HOST=localhost:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=solder-tasks
ANTHROPIC_API_KEY=
CORS_ORIGINS=["http://localhost:5173", "http://localhost:3000"]
DEBUG=true
"@ | Out-File -FilePath ".env" -Encoding UTF8
}

# Setup frontend
Write-Host ""
Write-Host "[4/6] Setting up frontend..." -ForegroundColor Blue
Set-Location "$ScriptDir\frontend"
npm install

# Start backend
Write-Host ""
Write-Host "[5/6] Starting backend server..." -ForegroundColor Blue
Set-Location "$ScriptDir\backend"

$backendJob = Start-Job -ScriptBlock {
    param($dir)
    Set-Location $dir
    if (Get-Command poetry -ErrorAction SilentlyContinue) {
        poetry run uvicorn app.main:app --reload --port 8000
    } else {
        python -m uvicorn app.main:app --reload --port 8000
    }
} -ArgumentList "$ScriptDir\backend"

Write-Host "Backend started as job: $($backendJob.Id)"
Start-Sleep -Seconds 3
Wait-ForService -Hostname "localhost" -Port 8000 -ServiceName "Backend API"

# Start frontend
Write-Host ""
Write-Host "[6/6] Starting frontend server..." -ForegroundColor Blue
Set-Location "$ScriptDir\frontend"

$frontendJob = Start-Job -ScriptBlock {
    param($dir)
    Set-Location $dir
    npm run dev
} -ArgumentList "$ScriptDir\frontend"

Write-Host "Frontend started as job: $($frontendJob.Id)"
Start-Sleep -Seconds 5

Write-Host ""
Write-Host "╔═══════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║                    SOLDER IS RUNNING!                     ║" -ForegroundColor Green
Write-Host "╠═══════════════════════════════════════════════════════════╣" -ForegroundColor Green
Write-Host "║                                                           ║" -ForegroundColor Green
Write-Host "║  Frontend:     http://localhost:5173                      ║" -ForegroundColor Green
Write-Host "║  Backend API:  http://localhost:8000/docs                 ║" -ForegroundColor Green
Write-Host "║  Temporal UI:  http://localhost:8080                      ║" -ForegroundColor Green
Write-Host "║                                                           ║" -ForegroundColor Green
Write-Host "╠═══════════════════════════════════════════════════════════╣" -ForegroundColor Green
Write-Host "║  Press Ctrl+C to stop, then run: .\stop.ps1               ║" -ForegroundColor Green
Write-Host "╚═══════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""

# Keep script running and show logs
Write-Host "Showing logs (Ctrl+C to stop)..." -ForegroundColor Yellow
Write-Host ""

try {
    while ($true) {
        Receive-Job -Job $backendJob -ErrorAction SilentlyContinue
        Receive-Job -Job $frontendJob -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }
} finally {
    Write-Host ""
    Write-Host "Stopping services..." -ForegroundColor Yellow
    Stop-Job -Job $backendJob -ErrorAction SilentlyContinue
    Stop-Job -Job $frontendJob -ErrorAction SilentlyContinue
    Remove-Job -Job $backendJob -ErrorAction SilentlyContinue
    Remove-Job -Job $frontendJob -ErrorAction SilentlyContinue
    Set-Location $ScriptDir
    docker-compose down
    Write-Host "All services stopped." -ForegroundColor Green
}
