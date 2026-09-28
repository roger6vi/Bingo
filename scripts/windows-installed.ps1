# Locate the per-user Bingo installation from its uninstall registry entry (Windows workflow, #41).
# Default: assert exactly one installation at -Version and print Bingo.exe's path.
# -Uninstall: run its silent uninstaller and wait until the entry and executable are gone.
param([string]$Version, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'

function Get-BingoEntry {
  @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'Bingo*' })
}

$entries = Get-BingoEntry
if ($entries.Count -ne 1) { throw "expected one Bingo installation, found $($entries.Count)" }
$entry = $entries[0]
$exe = Join-Path $entry.InstallLocation 'Bingo.exe'
if (-not (Test-Path $exe)) { throw "missing $exe; found: $(Get-ChildItem $entry.InstallLocation -Name)" }

if (-not $Uninstall) {
  if ($entry.DisplayVersion -ne $Version) { throw "installed $($entry.DisplayVersion), expected $Version" }
  Write-Host "Bingo $Version installed at $exe"
  return $exe
}

$command = if ($entry.QuietUninstallString) { $entry.QuietUninstallString } else { "$($entry.UninstallString) /S" }
Write-Host "Uninstalling: $command"
Start-Process -Wait cmd.exe -ArgumentList "/s /c `"$command`""
# The NSIS uninstaller relaunches itself from %TEMP%, so wait for its effects rather than its process.
for ($i = 0; $i -lt 60 -and ((Get-BingoEntry).Count -gt 0 -or (Test-Path $exe)); $i++) { Start-Sleep 1 }
if ((Get-BingoEntry).Count -gt 0 -or (Test-Path $exe)) { throw 'Bingo is still installed after uninstall' }
Write-Host 'Bingo uninstalled'
