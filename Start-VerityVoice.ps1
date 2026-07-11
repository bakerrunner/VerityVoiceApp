$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $ProjectRoot

$env:HOST = "0.0.0.0"
$env:PORT = "8789"
$Port = [int]$env:PORT
$CertFile = Join-Path $ProjectRoot "certs\server.crt"
$KeyFile = Join-Path $ProjectRoot "certs\server.key"
$Scheme = "http"

if ((Test-Path -LiteralPath $CertFile) -and (Test-Path -LiteralPath $KeyFile)) {
    $env:SSL_CERT_FILE = $CertFile
    $env:SSL_KEY_FILE = $KeyFile
    $Scheme = "https"
} else {
    Remove-Item Env:\SSL_CERT_FILE -ErrorAction SilentlyContinue
    Remove-Item Env:\SSL_KEY_FILE -ErrorAction SilentlyContinue
}

$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listeners) {
    $processIds = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
    Write-Host ""
    Write-Host "VerityVoice is already running on port $Port. Restarting..." -ForegroundColor Yellow
    foreach ($processId in $processIds) {
        try {
            $process = Get-Process -Id $processId -ErrorAction Stop
            Write-Host "Stopping process $($process.ProcessName) ($processId)..." -ForegroundColor Yellow
            Stop-Process -Id $processId -Force -ErrorAction Stop
        } catch {
            Write-Host "Could not stop process ${processId}: $($_.Exception.Message)" -ForegroundColor Red
            throw
        }
    }
    Start-Sleep -Seconds 1
}

Write-Host ""
Write-Host "Starting VerityVoice..." -ForegroundColor Green
Write-Host "Server PC URL: ${Scheme}://127.0.0.1:$Port" -ForegroundColor Cyan
Write-Host "LAN/WireGuard URL: ${Scheme}://YOUR-PC-IP:$Port" -ForegroundColor Cyan
Write-Host "Press Ctrl+C in this window to stop VerityVoice." -ForegroundColor Yellow
Write-Host ""

python server.py
