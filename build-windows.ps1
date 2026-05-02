param(
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

function Require-Cmd($Name, $InstallHint) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "Missing $Name. $InstallHint"
  }
  return $cmd.Source
}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$CliDir = Join-Path $Root "cli"
$AppDir = Join-Path $Root "app"
$TauriDir = Join-Path $AppDir "src-tauri"
$BackendOut = Join-Path $CliDir "dist\etcli"
$TauriBackend = Join-Path $TauriDir "etcli"

Write-Host "== Murmur Windows release build =="
Write-Host "Repo: $Root"

$Python = Require-Cmd "python" "Install Python 3.11+ from https://www.python.org/downloads/ and enable Add to PATH."
$Node = Require-Cmd "node" "Install Node.js 18+ from https://nodejs.org/."
$Npm = Require-Cmd "npm" "Install Node.js 18+ from https://nodejs.org/."
$Cargo = Require-Cmd "cargo" "Install Rust from https://rustup.rs/."

if (-not $SkipInstall) {
  Write-Host "[1/5] Installing Python backend dependencies..."
  Push-Location $Root
  & $Python -m pip install -r requirements.txt pyinstaller
  Pop-Location

  Write-Host "[2/5] Installing frontend dependencies..."
  Push-Location $AppDir
  & $Npm install
  Pop-Location
} else {
  Write-Host "[1/5] Skipping dependency install."
  Write-Host "[2/5] Skipping npm install."
}

Write-Host "[3/5] Building PyInstaller backend..."
Push-Location $CliDir
& $Python -m PyInstaller etcli.spec --clean -y
Pop-Location

if (-not (Test-Path (Join-Path $BackendOut "etcli.exe"))) {
  throw "PyInstaller did not produce $BackendOut\etcli.exe"
}

Write-Host "[4/5] Copying backend into Tauri resources..."
if (Test-Path $TauriBackend) {
  $resolved = (Resolve-Path $TauriBackend).Path
  $expectedPrefix = (Resolve-Path $TauriDir).Path
  if (-not $resolved.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to delete unexpected path: $resolved"
  }
  Remove-Item -LiteralPath $TauriBackend -Recurse -Force
}
Copy-Item -LiteralPath $BackendOut -Destination $TauriBackend -Recurse

Write-Host "[5/5] Building Tauri installers..."
Push-Location $AppDir
& $Npm run tauri:build
Pop-Location

$BundleDir = Join-Path $TauriDir "target\release\bundle"
Write-Host ""
Write-Host "Done. Installers are under:"
Write-Host "  $BundleDir"
