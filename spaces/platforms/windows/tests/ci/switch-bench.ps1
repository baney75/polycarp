# The switch-speed bench of BaneySpaces for Windows, on a GitHub Actions Windows runner's own desktop (like live.ps1):
# 30 solid-color windows from a process of their own, a 6x5 grid, spread 4,4,4,3,3,3,3,3,3 over workspaces 1 to 9, then
# 200 Win+n switches typed with SendInput (marked as a person's, the daemon's test ops on). Each switch is timed from
# just before the keys go in until DWM reads every window of the new workspace uncloaked and every other one cloaked,
# then the screen is shot and must hold no pixel of another workspace's color. Last, a hidden window is uncloaked from
# outside 20 times, each timed until it is cloaked again.
# Fails when: switch p90 >= 100 ms, max >= 250 ms, any switch not settled in 2 s, any wrong pixel, uncloak p90 >= 100 ms,
# or switch p90 over spec/speed.json windowsSwitch.p90Ms times regressionLimit (with floorMs of slack, for runner noise).
# Needs: a release build with the test-ops feature (baneyspaces.exe). Prints PASS or FAIL; exits 1 on any FAIL.
# Usage (Windows PowerShell 5.1): switch-bench.ps1 -Bin <target\release> -Out <evidence dir> [-Speed <spec\speed.json>] [-Disposable]
# It kills BaneySpaces and deletes its recovery record (state.json), so it runs only on a desktop nobody needs: a CI
# runner (GITHUB_ACTIONS=true), or by hand with -Disposable. Anywhere else it refuses (exit 2) before it touches anything.
param([Parameter(Mandatory = $true)][string]$Bin, [Parameter(Mandatory = $true)][string]$Out, [string]$Speed = '', [switch]$Disposable)
if ($env:GITHUB_ACTIONS -ne 'true' -and -not $Disposable) {
  [Console]::Error.WriteLine('switch-bench.ps1: refused. It kills BaneySpaces and deletes its recovery record. Run it only on a disposable desktop (a VM), with -Disposable.')
  exit 2
}
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType Directory -Force $Out | Out-Null
Add-Type -Path @((Join-Path $here 'Desk.cs'), (Join-Path $here 'Bench.cs')) -ReferencedAssemblies System.Drawing
$swatch = Join-Path $Out 'swatch.exe'
Add-Type -Path (Join-Path $here 'Swatch.cs') -OutputAssembly $swatch -OutputType WindowsApplication -ReferencedAssemblies System.Drawing, System.Windows.Forms
$log = Join-Path $Out 'bench.log'; Set-Content $log ''
$dlog = Join-Path $Out 'daemon.log'
$bs = Join-Path $Bin 'baneyspaces.exe'
$state = Join-Path $env:LOCALAPPDATA 'BaneySpaces'
$script:pass = 0; $script:fail = 0

function say($m) { Write-Host $m; Add-Content $log $m }
function check([bool]$c, $m, $why = '') { if ($c) { $script:pass++; say "  ok:   $m" } else { $script:fail++; say "  FAIL: $m$(if ($why) { " ($why)" })" } }
function bsc { $o = (& $bs @args 2>&1 | Out-String).Trim(); Add-Content $log "`$ baneyspaces $args  ->  $($o.Substring(0, [Math]::Min(200, $o.Length)))"; $o }
function pct($xs, $p) { $s = @($xs | Sort-Object); if ($s.Count -eq 0) { return -1 }; $s[[Math]::Min($s.Count - 1, [int][Math]::Ceiling($p * $s.Count) - 1)] }
function ms($x) { [Math]::Round($x, 1) }

# One color per workspace, none of them a UI color. 0xRRGGBB.
$colors = @(0xC91153, 0x11A3C9, 0xE98D09, 0x6117BB, 0x29C73D, 0xFBD325, 0x055971, 0xB5479D, 0x8B6B1D)
$split = @(4, 4, 4, 3, 3, 3, 3, 3, 3)
$wsOf = @(); for ($n = 1; $n -le 9; $n++) { for ($k = 0; $k -lt $split[$n - 1]; $k++) { $wsOf += $n } }
function others($n) { [int[]]@(for ($m = 1; $m -le 9; $m++) { if ($m -ne $n) { $colors[$m - 1] } }) }

say "== runner: $([Environment]::OSVersion.VersionString), session $((Get-Process -Id $PID).SessionId), displays $([Desk]::Displays()), cpus $([Environment]::ProcessorCount)"

say '== 0. clean start'
taskkill /F /IM baneyspaces.exe 2>&1 | Out-Null
Get-Process swatch -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item -Force (Join-Path $state 'state.json'), (Join-Path $state 'actions.jsonl'), (Join-Path $state 'settings.json') -ErrorAction SilentlyContinue
$base = [Bench]::Count([int[]]$colors, (Join-Path $Out '00-baseline.png'))
check (($base | Measure-Object -Sum).Sum -eq 0) 'no swatch color is on screen before the swatches open' ($base -join ',')
$env:BANEYSPACES_TEST_OPS = '1'; say "daemon: $(bsc daemon --background --trace --log $dlog)"; Remove-Item Env:BANEYSPACES_TEST_OPS

say '== 1. 30 swatch windows, workspaces 4,4,4,3,3,3,3,3,3'
$cargs = @(for ($i = 0; $i -lt 30; $i++) { $c = $colors[$wsOf[$i] - 1]; "$(($c -shr 16) -band 255),$(($c -shr 8) -band 255),$($c -band 255)" })
$proc = Start-Process $swatch -ArgumentList $cargs -PassThru; Start-Sleep 4
$sw = @([Desk]::Windows($false) | ? { $_.Pid -eq $proc.Id -and $_.Title -match '^swatch \d\d$' } | Sort-Object Title)
check ($sw.Count -eq 30) "30 swatch windows are open ($($sw.Count))"
if ($sw.Count -ne 30) { say 'RESULT: FAIL (no swatches)'; exit 1 }
$tracked = (bsc state | ConvertFrom-Json).data.windows
check (@($sw | ? { $tracked.("w-$($_.Hwnd)") }).Count -eq 30) 'the daemon tracks all 30'
for ($i = 0; $i -lt 30; $i++) { if ($wsOf[$i] -ne 1) { [void](bsc move $wsOf[$i] --stay --window "w-$($sw[$i].Hwnd)") } }
Start-Sleep 1
$on = @{}; for ($n = 1; $n -le 9; $n++) { $on[$n] = [long[]]@(for ($i = 0; $i -lt 30; $i++) { if ($wsOf[$i] -eq $n) { $sw[$i].Hwnd } }) }
$off = @{}; for ($n = 1; $n -le 9; $n++) { $off[$n] = [long[]]@(for ($i = 0; $i -lt 30; $i++) { if ($wsOf[$i] -ne $n) { $sw[$i].Hwnd } }) }
check (@($on[1] | ? { [Bench]::Cloaked($_) -ne 0 }).Count -eq 0 -and @($off[1] | ? { [Bench]::Cloaked($_) -eq 0 }).Count -eq 0) 'workspace 1 shows its 4 and the other 26 are cloaked'
$c0 = [Bench]::Count((others 1), (Join-Path $Out '01-moved.png'))
check (($c0 | Measure-Object -Sum).Sum -eq 0) 'no other workspace''s color is on screen' ($c0 -join ',')

say '== 2. 200 switches with Win+n'
# Five untimed switches first (the first show of a window loads the shell's view of it), then 200 timed. Each target
# differs from the one before (steps of 4 mod 9), so every switch shows 3 or 4 windows and hides 3 or 4.
$cur = 1; $times = @(); $late = 0; $wrong = 0; $shots = 0
for ($i = -5; $i -lt 200; $i++) {
  $n = (($cur - 1 + 4) % 9) + 1
  $t = [Bench]::Switch([uint16](0x30 + $n), $on[$n], $off[$n], 2000)
  $cur = $n
  if ($i -lt 0) { Start-Sleep -Milliseconds 300; continue }
  if ($t -lt 0) { $late++; say "  switch $i to $n not settled in 2 s"; Start-Sleep 2; continue }
  $times += $t
  Start-Sleep -Milliseconds 60
  $path = if ($i -lt 9 -or ($wrong -gt 0 -and $shots -lt 5)) { Join-Path $Out ('switch-{0:D3}-to-{1}.png' -f $i, $n) } else { $null }
  $cs = [Bench]::Count([int[]]$colors, $path)
  $bad = 0; for ($m = 1; $m -le 9; $m++) { if ($m -ne $n) { $bad += $cs[$m - 1] } }
  if ($bad -gt 0 -or $cs[$n - 1] -eq 0) {
    $wrong++; $shots++
    $p = Join-Path $Out ('wrong-{0:D3}-to-{1}.png' -f $i, $n); [void][Bench]::Count([int[]]$colors, $p)
    say "  switch $i to $n in $(ms $t) ms: own color $($cs[$n - 1]) px, other colors $bad px ($($cs -join ','))"
  }
  Add-Content $log ("  switch {0} to {1}: {2} ms" -f $i, $n, (ms $t))
  Start-Sleep -Milliseconds 100
}
$p50 = pct $times 0.5; $p90 = pct $times 0.9; $max = ($times | Measure-Object -Maximum).Maximum
say "switch: n=$($times.Count) p50=$(ms $p50) p90=$(ms $p90) max=$(ms $max) ms, not settled $late"
check ($late -eq 0) 'every switch settled within 2 s' "$late did not"
check ($p90 -lt 100) "switch p90 under 100 ms ($(ms $p90) ms)"
check ($max -lt 250) "switch max under 250 ms ($(ms $max) ms)"
check ($wrong -eq 0) "after each of 200 switches the screen shows the new workspace's color and no other ($wrong wrong)"
$inner = @(Get-Content $dlog -ErrorAction SilentlyContinue | % { if ($_ -match 'done (\d+) ms after the key went down') { [int]$Matches[1] } })
if ($inner.Count) { say "daemon's own count (key down to chord done, 16 ms ticks): n=$($inner.Count) p50=$(pct $inner 0.5) p90=$(pct $inner 0.9) max=$(($inner | Measure-Object -Maximum).Maximum) ms" }

say '== 3. an outside uncloak of a hidden window, 20 times'
$victim = $off[$cur][0]
$exp = @(); $how = @()
for ($k = 0; $k -lt 20; $k++) {
  # Uneven gaps, so a daemon that only looks on a timer is caught at every phase of it.
  Start-Sleep -Milliseconds (150 + ($k * 53) % 400)
  $why = ''; $e = [Bench]::Exposed($victim, 2000, [ref]$why)
  if ($e -lt 0) { $e = 2000 }
  $exp += $e; $how += $why
  Add-Content $log ("  uncloak {0}: cloaked again after {1} ms ({2})" -f $k, (ms $e), $why)
}
$ep90 = pct $exp 0.9
say "uncloak: n=20 p50=$(ms (pct $exp 0.5)) p90=$(ms $ep90) max=$(ms ($exp | Measure-Object -Maximum).Maximum) ms"
check (@($how | ? { $_ -notmatch '^setcloak 0x0' }).Count -eq 0) 'every outside uncloak took (setcloak 0x0)' (($how | Select-Object -Unique) -join '; ')
check ($ep90 -lt 100) "a window uncloaked from outside is cloaked again: p90 under 100 ms ($(ms $ep90) ms)"

say '== 4. the ratchet: spec/speed.json windowsSwitch'
$spec = if ($Speed -and (Test-Path $Speed)) { (Get-Content $Speed -Raw | ConvertFrom-Json).windowsSwitch } else { $null }
if ($spec -and $spec.p90Ms) {
  $limit = [Math]::Max($spec.p90Ms * $spec.regressionLimit, $spec.p90Ms + $spec.floorMs)
  check ($p90 -le $limit) "switch p90 $(ms $p90) ms is within the recorded $($spec.p90Ms) ms x $($spec.regressionLimit) (or +$($spec.floorMs) ms): limit $(ms $limit) ms"
} else { say '  no windowsSwitch.p90Ms recorded: nothing to hold to' }

taskkill /F /IM baneyspaces.exe 2>&1 | Out-Null
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
@{ switch = @{ n = $times.Count; p50Ms = ms $p50; p90Ms = ms $p90; maxMs = ms $max; notSettled = $late; wrongScreens = $wrong }
   uncloak = @{ n = 20; p90Ms = ms $ep90 }; times = @($times | % { ms $_ }); uncloakTimes = @($exp | % { ms $_ }) } |
  ConvertTo-Json -Depth 4 | Set-Content (Join-Path $Out 'bench.json')
$res = if ($script:fail -eq 0) { 'PASS' } else { 'FAIL' }
say ''; say "RESULT: $res  passed=$($script:pass) failed=$($script:fail)   switch p90 $(ms $p90) ms, max $(ms $max) ms, uncloak p90 $(ms $ep90) ms"
if ($env:GITHUB_STEP_SUMMARY) {
  Add-Content $env:GITHUB_STEP_SUMMARY "### Windows switch bench: $res, switch p90 $(ms $p90) ms, max $(ms $max) ms, uncloak p90 $(ms $ep90) ms`n"
  Get-Content $log | ? { $_ -match '^  FAIL:' } | % { Add-Content $env:GITHUB_STEP_SUMMARY "- $($_.Trim())" }
}
if ($script:fail -ne 0) { exit 1 } else { exit 0 }
