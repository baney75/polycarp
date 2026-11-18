# The keymap of BaneySpaces for Windows, live on a GitHub Actions Windows runner's own desktop (like live.ps1). Two
# swatch windows side by side, keys typed with SendInput (marked as a person's, the daemon's test ops on), every result
# read back from the window manager (foreground window, GetWindowRect) or `state`, never from the key's own answer.
#   1. The default keys: Win+Alt+Left focuses the window to the left, Win+Alt+Shift+Right swaps two windows,
#      Win+Ctrl+Alt+Right makes the front window 40 px wider.
#   2. config.toml rebinds Win+1 and adds Win+Alt+J: the daemon reloads it within 1 s and both keys do the new thing.
#   3. A bad config.toml names the path and the reason in state's keys.error, and the keys in force stay.
# Not here (the runner cannot show them): a second display (`window display` is checked to refuse with one), and an
# elevated window in front (the runner's own session is elevated, so nothing is above the daemon).
# Needs: a release build with the test-ops feature (baneyspaces.exe). Prints PASS or FAIL; exits 1 on any FAIL.
# Usage (Windows PowerShell 5.1): keymap.ps1 -Bin <target\release> -Out <evidence dir> [-Disposable]
# It kills BaneySpaces and deletes its recovery record (state.json), so it runs only on a desktop nobody needs: a CI
# runner (GITHUB_ACTIONS=true), or by hand with -Disposable.
param([Parameter(Mandatory = $true)][string]$Bin, [Parameter(Mandatory = $true)][string]$Out, [switch]$Disposable)
if ($env:GITHUB_ACTIONS -ne 'true' -and -not $Disposable) {
  [Console]::Error.WriteLine('keymap.ps1: refused. It kills BaneySpaces and deletes its recovery record. Run it only on a disposable desktop (a VM), with -Disposable.')
  exit 2
}
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType Directory -Force $Out | Out-Null
Add-Type -Path (Join-Path $here 'Desk.cs') -ReferencedAssemblies System.Drawing
$swatch = Join-Path $Out 'swatch.exe'
Add-Type -Path (Join-Path $here 'Swatch.cs') -OutputAssembly $swatch -OutputType WindowsApplication -ReferencedAssemblies System.Drawing, System.Windows.Forms
$log = Join-Path $Out 'keymap.log'; Set-Content $log ''
$dlog = Join-Path $Out 'daemon.log'
$bs = Join-Path $Bin 'baneyspaces.exe'
$state = Join-Path $env:LOCALAPPDATA 'BaneySpaces'
$cfg = Join-Path $Out 'config'; New-Item -ItemType Directory -Force $cfg | Out-Null
$toml = Join-Path $cfg 'config.toml'
$script:pass = 0; $script:fail = 0

function say($m) { Write-Host $m; Add-Content $log $m }
function check([bool]$c, $m, $why = '') { if ($c) { $script:pass++; say "  ok:   $m" } else { $script:fail++; say "  FAIL: $m$(if ($why) { " ($why)" })" } }
function bsc { $o = (& $bs @args 2>&1 | Out-String).Trim(); Add-Content $log "`$ baneyspaces $args  ->  $($o.Substring(0, [Math]::Min(300, $o.Length)))"; $o }
function st { bsc state | ConvertFrom-Json }
function current { @((st).data.monitors.PSObject.Properties | % { $_.Value.current })[0] }
# Polls cond every 20 ms for up to ms; returns the milliseconds it took, or -1.
function waitfor([int]$ms, [scriptblock]$cond) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $ms) { if (& $cond) { return $sw.ElapsedMilliseconds }; Start-Sleep -Milliseconds 20 }
  -1
}
function press([uint16[]]$vks) { [void][Desk]::Keys($vks, $true) }
# Windows refuses SetForegroundWindow to a process that hasn't had the last input (the foreground lock), so a refused
# call is retried after an Alt tap typed with SendInput. A window that still won't come to the front is said as a
# harness failure, naming the one in front, so a key check after it is never read as the daemon's fault.
function front($h) {
  for ($i = 0; $i -lt 3; $i++) {
    [void][Desk]::Front($h)
    if ((waitfor 500 { [Desk]::Foreground() -eq $h }) -ge 0) { return }
    press @($ALT)
  }
  # Read the front window itself: one that isn't visible is in no window list, and a lookup there said nothing.
  $f = [Desk]::Foreground(); $w = [Desk]::Read($f)
  $name = if ($w) { (Get-Process -Id $w.Pid -ErrorAction SilentlyContinue).ProcessName } else { '' }
  check $false "the harness brings $h to the front before the key" "front is $f ($(if ($w) { "$name, visible $([Desk]::Visible($f)), owner $(owner $f), $w" } else { 'no window' }))"
}
function owner($h) {
  $o = [Desk]::Owner($h); if ($o -eq 0) { return 'none' }
  $w = [Desk]::Read($o); if (-not $w) { return "$o (gone)" }
  "$o ($((Get-Process -Id $w.Pid -ErrorAction SilentlyContinue).ProcessName), $w)"
}
function frame($h) { $w = [Desk]::Read($h); "$($w.L),$($w.T),$($w.R),$($w.B)" }
$WIN = 0x5B; $SHIFT = 0x10; $CTRL = 0x11; $ALT = 0x12; $LEFT = 0x25; $RIGHT = 0x27; $J = 0x4A

say "== runner: $([Environment]::OSVersion.VersionString), displays $([Desk]::Displays())"
taskkill /F /IM baneyspaces.exe 2>&1 | Out-Null
Get-Process swatch -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item -Force (Join-Path $state 'state.json'), (Join-Path $state 'actions.jsonl'), (Join-Path $state 'settings.json') -ErrorAction SilentlyContinue
$env:BANEYSPACES_CONFIG_DIR = $cfg
$env:BANEYSPACES_TEST_OPS = '1'; say "daemon: $(bsc daemon --background --trace --log $dlog)"; Remove-Item Env:BANEYSPACES_TEST_OPS
$proc = Start-Process $swatch -ArgumentList '201,17,83', '17,163,201' -PassThru; Start-Sleep 3
$sw = @([Desk]::Windows($false) | ? { $_.Pid -eq $proc.Id -and $_.Title -match '^swatch \d\d$' } | Sort-Object Title)
check ($sw.Count -eq 2) "two swatch windows are open ($($sw.Count))"
if ($sw.Count -ne 2) { say 'RESULT: FAIL (no swatches)'; exit 1 }
$a = $sw[0].Hwnd; $b = $sw[1].Hwnd
[void](waitfor 3000 { $k = (st).data.keys; $k -and $k.loads -ge 1 })
$k = (st).data.keys
check ($k.loads -eq 1 -and -not $k.error) "with no config.toml the defaults are in force (loads $($k.loads), error '$($k.error)')"
check ($k.config -eq $toml) "state names the file it reads ($($k.config))"

say '== 1. the default keys'
front $b
press @($WIN, $ALT, $LEFT)
$t = waitfor 1000 { [Desk]::Foreground() -eq $a }
check ($t -ge 0) "Win+Alt+Left brings the window to the left to the front ($t ms)" "front is $([Desk]::Foreground()), want $a"

$fa = frame $a; $fb = frame $b
front $a
press @($WIN, $ALT, $SHIFT, $RIGHT)
$t = waitfor 1000 { (frame $a) -eq $fb -and (frame $b) -eq $fa }
check ($t -ge 0) "Win+Alt+Shift+Right swaps the front window with the one to its right ($t ms)" "a $(frame $a) b $(frame $b), want a $fb b $fa"

# The swap put a where b was, so the window to a's left is now b, and a is still in front.
front $a
$w0 = [Desk]::Read($a)
press @($WIN, $CTRL, $ALT, $RIGHT)
$t = waitfor 1000 { $w = [Desk]::Read($a); ($w.R - $w.L) -eq ($w0.R - $w0.L + 40) -and $w.L -eq $w0.L -and $w.T -eq $w0.T }
check ($t -ge 0) "Win+Ctrl+Alt+Right makes the front window 40 px wider, its corner kept ($t ms)" "was $($w0.L),$($w0.T),$($w0.R),$($w0.B) now $(frame $a)"

$d = bsc window display next | ConvertFrom-Json
check ($d.ok -and $d.data.changed -eq $false) "with one display, window display moves nothing and says why ($($d.data.note))"

say '== 2. config.toml, reloaded'
[void](bsc switch 1)
$before = (st).data.keys.loads
$sw2 = [Diagnostics.Stopwatch]::StartNew()
Set-Content $toml "[keys.bindings]`r`n`"mod+alt+j`" = `"switch 2`"`r`n`"mod+1`" = `"switch 3`"`r`n" -Encoding ASCII
$t = waitfor 3000 { (st).data.keys.loads -gt $before }
$reload = $sw2.ElapsedMilliseconds
check ($t -ge 0 -and $reload -lt 1000) "the daemon took the new config.toml within 1 s ($reload ms, from the write to state showing it)"
$said = @(Get-Content $dlog -ErrorAction SilentlyContinue | ? { $_ -match 'keys: \d+ bindings from config.toml, (\d+) ms after the change' } | % { [int]$Matches[1] })
if ($said.Count) { say "  daemon's own count: $($said[-1]) ms from the change to the keys in force" }
check (-not (st).data.keys.error) 'the new file has no error'
press @($WIN, $ALT, $J)
check ((waitfor 1000 { (current) -eq 2 }) -ge 0) 'Win+Alt+J, bound by the file, goes to workspace 2' "current $(current)"
press @($WIN, 0x31)
check ((waitfor 1000 { (current) -eq 3 }) -ge 0) 'Win+1, rebound by the file, goes to workspace 3' "current $(current)"

say '== 3. a bad config.toml'
$before = (st).data.keys.loads
Set-Content $toml "[keys.bindings]`r`n`"mod+alt+j`" = `"warp 9`"`r`n" -Encoding ASCII
$t = waitfor 3000 { $e = (st).data.keys.error; $e -and $e -match 'keys\.bindings\."mod\+alt\+j"' }
$e = (st).data.keys.error
check ($t -ge 0 -and $t -lt 1000) "state names the bad binding's path within 1 s ($t ms): $e"
check ((st).data.keys.loads -eq $before) 'the bad file is not counted as a load'
press @($WIN, $ALT, $J)
check ((waitfor 1000 { (current) -eq 2 }) -ge 0) 'Win+Alt+J still does what the last good file said' "current $(current)"
press @($WIN, 0x31)
check ((waitfor 1000 { (current) -eq 3 }) -ge 0) 'Win+1 still does what the last good file said' "current $(current)"

taskkill /F /IM baneyspaces.exe 2>&1 | Out-Null
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Remove-Item Env:BANEYSPACES_CONFIG_DIR
if ($env:GITHUB_STEP_SUMMARY) { Add-Content $env:GITHUB_STEP_SUMMARY "### Windows keymap`n`n$script:pass passed, $script:fail failed; reload $reload ms" }
if ($script:fail) { say "RESULT: FAIL ($script:fail failed, $script:pass passed)"; exit 1 }
say "RESULT: PASS ($script:pass checks)"
