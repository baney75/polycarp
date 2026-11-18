# Proves live.ps1 refuses a desktop that isn't disposable: off a runner and without -Disposable it exits 2 with
# "live.ps1: refused" before any setup, and a window already open (Notepad) is left alone.
# Run from spaces/ on a Windows runner: platforms/windows/tests/ci/refuses.ps1 -Bin target/release -Out <dir>
param([Parameter(Mandatory)][string]$Bin, [Parameter(Mandatory)][string]$Out)
# Start-Process keeps the child's stderr out of this shell: PowerShell 5.1 turns a native stderr line into an
# error record, and Actions fails the step on it.
$n = Start-Process notepad -PassThru; Start-Sleep 2
$saved = $env:GITHUB_ACTIONS; $env:GITHUB_ACTIONS = ''
$err = Join-Path $env:RUNNER_TEMP 'refused.err'
$p = Start-Process powershell -ArgumentList '-NoProfile', '-File', "$PSScriptRoot/live.ps1", '-Bin', $Bin, '-Out', $Out -NoNewWindow -Wait -PassThru -RedirectStandardError $err
$env:GITHUB_ACTIONS = $saved
$o = Get-Content $err -Raw; Write-Host $o
$alive = -not $n.HasExited
Stop-Process -Id $n.Id -Force -ErrorAction SilentlyContinue
if ($p.ExitCode -ne 2 -or -not $alive -or $o -notmatch 'live.ps1: refused') { Write-Host "exit $($p.ExitCode), notepad alive $alive"; exit 1 }
exit 0
