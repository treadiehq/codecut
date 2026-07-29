<#
.SYNOPSIS
  Download Codecut for Windows and install it on PATH.

.DESCRIPTION
  Run directly from the web:

    irm https://raw.githubusercontent.com/treadiehq/codecut/main/scripts/install.ps1 | iex

  Environment overrides:
    CODECUT_VERSION   release tag to install, e.g. v0.1.0 (default: latest)
    CODECUT_BIN_DIR   installation directory (default: %LOCALAPPDATA%\codecut\bin)
    CODECUT_REPO      owner/repo to download from (default: treadiehq/codecut)
#>

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Say($message) { Write-Host "-> $message" -ForegroundColor DarkGray }
function Ok($message) { Write-Host "OK $message" -ForegroundColor Green }
function Die($message) { Write-Host "x $message" -ForegroundColor Red; exit 1 }
function Get-CodecutVersion($path) {
  try {
    $output = & $path --version 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return ($output | Out-String).Trim()
  } catch {
    return $null
  }
}

$repo = if ($env:CODECUT_REPO) { $env:CODECUT_REPO } else { 'treadiehq/codecut' }
$version = if ($env:CODECUT_VERSION) { $env:CODECUT_VERSION } else { 'latest' }
$binDir = if ($env:CODECUT_BIN_DIR) {
  $env:CODECUT_BIN_DIR
} else {
  Join-Path $env:LOCALAPPDATA 'codecut\bin'
}

if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
  Say 'ARM64 detected; installing the x64 binary through Windows emulation.'
}

$asset = 'codecut-windows-x64.exe'
$url = if ($version -eq 'latest') {
  "https://github.com/$repo/releases/latest/download/$asset"
} else {
  "https://github.com/$repo/releases/download/$version/$asset"
}

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$dest = Join-Path $binDir 'codecut.exe'
$old = "$dest.old"
if (Test-Path $old) {
  try { Remove-Item $old -Force -ErrorAction Stop } catch {}
}

Say "Downloading $asset ($version)..."
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("codecut-" + [guid]::NewGuid().ToString('N') + '.exe')
try {
  Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
} catch {
  Die "Could not download $url`nCheck available releases: https://github.com/$repo/releases"
}

$downloaded = Get-CodecutVersion $tmp
if (-not $downloaded) {
  try { Remove-Item $tmp -Force -ErrorAction Stop } catch {}
  Die "The downloaded binary failed to run; the existing install was left untouched."
}

function Restore-Old {
  if (Test-Path $old) {
    try { Move-Item -Path $old -Destination $dest -Force -ErrorAction Stop } catch {}
  }
}

if (Test-Path $dest) {
  try {
    Move-Item -Path $dest -Destination $old -Force -ErrorAction Stop
  } catch {
    try { Remove-Item $tmp -Force -ErrorAction Stop } catch {}
    Die "Could not back up the existing binary at $dest."
  }
}
try {
  Move-Item -Path $tmp -Destination $dest -Force -ErrorAction Stop
} catch {
  Restore-Old
  Die "Could not install Codecut at $dest."
}

$installed = Get-CodecutVersion $dest
if (-not $installed) {
  Restore-Old
  Die "The installed binary failed to run at $dest."
}
if (Test-Path $old) {
  try { Remove-Item $old -Force -ErrorAction Stop } catch {}
}
Ok "Installed Codecut $installed at $dest"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$onPath = $userPath -and (($userPath -split ';') -contains $binDir)
if (-not $onPath) {
  $newPath = if ([string]::IsNullOrEmpty($userPath)) { $binDir } else { "$userPath;$binDir" }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  $env:Path = "$env:Path;$binDir"
  Say "Added $binDir to your user PATH. New terminals will use it automatically."
}

Write-Host ''
Ok 'Codecut is installed. Set it up in a project with:'
Write-Host '    codecut setup --agent claude' -ForegroundColor White
