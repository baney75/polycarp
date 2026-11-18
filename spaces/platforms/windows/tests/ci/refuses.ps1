# Proves the three suites that wreck a desktop refuse one that isn't disposable. Off a runner and without -Disposable,
# live.ps1, switch-bench.ps1 and keymap.ps1 each exit 2 with "<name>: refused" before any setup: a window already open (Notepad)
# is left alone and the recovery record (state.json) is not deleted.
# It writes a stand-in state.json to see that, so it runs only on a runner (GITHUB_ACTIONS=true) or with -Disposable,
# refuses (exit 2) anywhere else, and puts back whatever state.json held before, whatever happens.
# Run from spaces/ on a Windows runner: platforms/windows/tests/ci/refuses.ps1 -Bin target/release -Out <dir>
param([Parameter(Mandatory)][string]$Bin, [Parameter(Mandatory)][string]$Out, [switch]$Disposable)
if ($env:GITHUB_ACTIONS -ne 'true' -and -not $Disposable) {
  [Console]::Error.WriteLine('refuses.ps1: refused. It overwrites the recovery record for a moment. Run it only on a disposable desktop (a VM), with -Disposable.')
  exit 2
}
$state = Join-Path $env:LOCALAPPDATA 'BaneySpaces'; New-Item -ItemType Directory -Force $state | Out-Null
$record = Join-Path $state 'state.json'
$had = Test-Path $record; $before = if ($had) { [IO.File]::ReadAllBytes($record) } else { $null }
$bad = 0
try {
  foreach ($name in 'live.ps1', 'switch-bench.ps1', 'keymap.ps1') {
    $mark = "refuses.ps1 sentinel $([guid]::NewGuid())"; Set-Content $record $mark
    $n = Start-Process notepad -PassThru; Start-Sleep 2
    # Start-Process keeps the child's stderr out of this shell: PowerShell 5.1 turns a native stderr line into an
    # error record, and Actions fails the step on it.
    $saved = $env:GITHUB_ACTIONS; $env:GITHUB_ACTIONS = ''
    $err = Join-Path ([IO.Path]::GetTempPath()) "refused-$name.err"
    $p = Start-Process powershell -ArgumentList '-NoProfile', '-File', "$PSScriptRoot/$name", '-Bin', $Bin, '-Out', (Join-Path $Out $name) -NoNewWindow -Wait -PassThru -RedirectStandardError $err
    $env:GITHUB_ACTIONS = $saved
    $o = Get-Content $err -Raw; Write-Host "$name -> exit $($p.ExitCode): $o"
    $alive = -not $n.HasExited
    Stop-Process -Id $n.Id -Force -ErrorAction SilentlyContinue
    $kept = (Test-Path $record) -and ((Get-Content $record -Raw).Trim() -eq $mark)
    if ($p.ExitCode -ne 2 -or -not $alive -or -not $kept -or $o -notmatch "$([regex]::Escape($name)): refused") {
      Write-Host "FAIL: $name exit $($p.ExitCode), notepad alive $alive, state.json kept $kept"; $bad++
    }
  }
} finally {
  if ($had) { [IO.File]::WriteAllBytes($record, $before) } else { Remove-Item -Force $record -ErrorAction SilentlyContinue }
}
exit [int]($bad -gt 0)
