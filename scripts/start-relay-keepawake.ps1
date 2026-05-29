param(
    [string]$ServerUrl = "wss://agent-hub-backend-wk48.onrender.com",
    [string]$RelayCode = "",
    [bool]$StopExisting = $true,
    [switch]$Foreground,
    [switch]$SkipPowerConfig
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$backendDir = Join-Path $repoRoot "backend"
$nodeExe = "node"
$npmExe = "npm.cmd"

function Invoke-PowerCfgSafe {
    param([string[]]$ArgsToPass)
    try {
        & powercfg @ArgsToPass | Out-Null
        return $true
    } catch {
        Write-Warning "powercfg $($ArgsToPass -join ' ') failed: $($_.Exception.Message)"
        return $false
    }
}

if (-not $SkipPowerConfig) {
    # Keep the machine awake for this relay workflow. Without this, closing the lid
    # can suspend Windows and the local Codex/OpenCode processes stop responding.
    $powerSettings = @(
        @("SUB_BUTTONS", "LIDACTION", "0"),
        @("4f971e89-eebd-4455-a8de-9e59040e7347", "5ca83367-6e45-459f-a27b-476b1d01c936", "0"),
        @("SUB_SLEEP", "STANDBYIDLE", "0"),
        @("SUB_SLEEP", "HIBERNATEIDLE", "0")
    )

    foreach ($setting in $powerSettings) {
        Invoke-PowerCfgSafe -ArgsToPass @("/setacvalueindex", "SCHEME_CURRENT", $setting[0], $setting[1], $setting[2]) | Out-Null
        Invoke-PowerCfgSafe -ArgsToPass @("/setdcvalueindex", "SCHEME_CURRENT", $setting[0], $setting[1], $setting[2]) | Out-Null
    }
    Invoke-PowerCfgSafe -ArgsToPass @("/setactive", "SCHEME_CURRENT") | Out-Null
}

if ($StopExisting) {
    Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -eq "node.exe" -and (
                $_.CommandLine -match "(^|[\\\/\s])relay\.js(\s|$)" -or
                $_.CommandLine -match "(^|[\\\/\s])dist[\\\/]relay\.js(\s|$)"
            )
        } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}

$env:SERVER_URL = $ServerUrl
if ($RelayCode.Trim().Length -gt 0) {
    $env:AGENTHUB_RELAY_CODE = $RelayCode.Trim()
}

if ($Foreground) {
    Push-Location $backendDir
    try {
        & $npmExe run build
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        & $nodeExe dist\relay.js
    } finally {
        Pop-Location
    }
    exit $LASTEXITCODE
}

$logPath = Join-Path $env:TEMP "agenthub-render-relay-live.log"
$errPath = Join-Path $env:TEMP "agenthub-render-relay-live.err.log"
Push-Location $backendDir
try {
    & $npmExe run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}
$process = Start-Process -FilePath $nodeExe -ArgumentList "dist\relay.js" -WorkingDirectory $backendDir `
    -RedirectStandardOutput $logPath -RedirectStandardError $errPath -WindowStyle Hidden -PassThru

Write-Host "Agent Hub relay started."
Write-Host "PID: $($process.Id)"
Write-Host "Server: $ServerUrl"
Write-Host "Stdout: $logPath"
Write-Host "Stderr: $errPath"
