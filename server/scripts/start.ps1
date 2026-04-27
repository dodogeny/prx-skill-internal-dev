# start.ps1 — start prevoyant-server in the background (Windows)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Split-Path -Parent $scriptDir
$pidFile   = Join-Path $serverDir '.server.pid'
$logFile   = Join-Path $serverDir 'prevoyant-server.log'
$port      = if ($env:WEBHOOK_PORT) { $env:WEBHOOK_PORT } else { '3000' }

# ── Already running? ──────────────────────────────────────────────────────────
if (Test-Path $pidFile) {
    $existingPid = (Get-Content $pidFile).Trim()
    try {
        $proc = Get-Process -Id $existingPid -ErrorAction Stop
        Write-Host "[prevoyant-server] Already running (PID $existingPid)"
        Write-Host "[prevoyant-server] Dashboard : http://localhost:${port}/dashboard"
        Write-Host "[prevoyant-server] Log       : $logFile"
        exit 0
    } catch {
        Write-Host "[prevoyant-server] Removing stale PID file (PID $existingPid was not running)"
        Remove-Item $pidFile -Force
    }
}

# ── Dependencies ──────────────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $serverDir 'node_modules'))) {
    Write-Host "[prevoyant-server] node_modules not found — running npm install..."
    Push-Location $serverDir
    npm install --silent
    Pop-Location
    Write-Host "[prevoyant-server] Dependencies installed."
}

# ── Start ─────────────────────────────────────────────────────────────────────
$proc = Start-Process -FilePath 'node' `
    -ArgumentList 'index.js' `
    -WorkingDirectory $serverDir `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError  $logFile `
    -NoNewWindow `
    -PassThru

$proc.Id | Out-File -FilePath $pidFile -Encoding ascii -NoNewline

# Give the process a moment to either bind the port or crash
Start-Sleep -Seconds 2

if (-not (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) {
    Write-Host "[prevoyant-server] Failed to start — check $logFile"
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    Get-Content $logFile -Tail 20
    exit 1
}

Write-Host "[prevoyant-server] Started     (PID $($proc.Id))"
Write-Host "[prevoyant-server] Dashboard : http://localhost:${port}/dashboard"
Write-Host "[prevoyant-server] Health    : http://localhost:${port}/health"
Write-Host "[prevoyant-server] Log       : $logFile"
