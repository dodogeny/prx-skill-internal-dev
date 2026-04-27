# stop.ps1 — stop prevoyant-server (Windows)

$ErrorActionPreference = 'SilentlyContinue'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Split-Path -Parent $scriptDir
$pidFile   = Join-Path $serverDir '.server.pid'

if (-not (Test-Path $pidFile)) {
    Write-Host "[prevoyant-server] Not running (no PID file found)"
    exit 0
}

$savedPid = (Get-Content $pidFile).Trim()

$proc = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
if ($proc) {
    Stop-Process -Id $savedPid -Force -ErrorAction SilentlyContinue

    # Wait up to 5 s for clean shutdown
    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        if (-not (Get-Process -Id $savedPid -ErrorAction SilentlyContinue)) { break }
    }

    if (Get-Process -Id $savedPid -ErrorAction SilentlyContinue) {
        Write-Host "[prevoyant-server] Force-killed (PID $savedPid)"
    } else {
        Write-Host "[prevoyant-server] Stopped (PID $savedPid)"
    }
} else {
    Write-Host "[prevoyant-server] Not running (stale PID $savedPid)"
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
