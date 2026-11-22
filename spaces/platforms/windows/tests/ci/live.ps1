# The live test of BaneySpaces for Windows, run inside a GitHub Actions Windows runner: the real daemon on the
# runner's own interactive desktop (session 1+, WinSta0\Default, explorer.exe and DWM running), real windows, the
# real keyboard hook. It ports tests/live.sh, which drove the win11-bs VM over ssh; README.md "CI live suite" lists
# what the runner cannot run and why. Reads back Win32 state after every step and saves screenshots.
# Needs: a release build with the test-ops feature (baneyspaces.exe, bs-testapp.exe) and the engine installed in
# %LOCALAPPDATA%\BaneySpaces\engine (build-engine.ps1 -Install). Prints PASS or FAIL with counts; exits 1 on any FAIL.
# Usage (Windows PowerShell 5.1): live.ps1 -Bin <target\release> -Out <evidence dir> [-Disposable]
# It kills BaneySpaces, deletes its recovery record (state.json, what puts hidden windows back) and force-closes every
# Notepad, so it runs only on a desktop nobody needs: a CI runner (GITHUB_ACTIONS=true), or by hand with -Disposable.
param([Parameter(Mandatory = $true)][string]$Bin, [Parameter(Mandatory = $true)][string]$Out, [switch]$Disposable)
if ($env:GITHUB_ACTIONS -ne 'true' -and -not $Disposable) {
  [Console]::Error.WriteLine('live.ps1: refused. It kills BaneySpaces, deletes its recovery record and closes every Notepad. Run it only on a disposable desktop (a VM), with -Disposable.')
  exit 2
}
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -Path (Join-Path $here 'Desk.cs') -ReferencedAssemblies System.Drawing
New-Item -ItemType Directory -Force $Out | Out-Null
$log = Join-Path $Out 'live.log'; Set-Content $log ''
$dlog = Join-Path $Out 'daemon.log'
$bs = Join-Path $Bin 'baneyspaces.exe'; $testapp = Join-Path $Bin 'bs-testapp.exe'
$state = Join-Path $env:LOCALAPPDATA 'BaneySpaces'
$script:pass = 0; $script:fail = 0; $script:skips = @()

function say($m) { Write-Host $m; Add-Content $log $m }
function ok($m) { $script:pass++; say "  ok:   $m" }
function bad($m) { $script:fail++; say "  FAIL: $m" }
function check([bool]$c, $m, $why = '') { if ($c) { ok $m } else { bad "$m$(if ($why) { " ($why)" })" } }
function skip($m) { $script:skips += $m; say "  skip: $m" }
function shot($n) { try { [Desk]::Shot((Join-Path $Out "$n.png")) } catch { say "  (no shot $n`: $_)" } }
function bsc { $o = (& $bs @args 2>&1 | Out-String).Trim(); Add-Content $log "`$ baneyspaces $args  ->  $($o.Substring(0, [Math]::Min(300, $o.Length)))"; $o }
function j($text) { try { $text | ConvertFrom-Json } catch { $null } }
function win($h) { [Desk]::Read([long]$h) }
function cloaked($h) { $w = win $h; if ($w) { $w.Cloaked } else { -1 } }
function wins([switch]$All) { $r = [Desk]::Windows([bool]$All); $r | % { Add-Content $log "    $_" }; $r }
# The app windows a person sees right now, by class: Notepad, CabinetWClass (Explorer), BaneySpacesTestApp.
function seen { (wins | ? { $_.Seen } | % { $_.Class }) -join ' ' }
function hw($w) { "w-$($w.Hwnd)" }
function keys([int[]]$vk, [switch]$Unmarked) { [void][Desk]::Keys([uint16[]]$vk, -not $Unmarked); Start-Sleep -Milliseconds 1500 }
$WIN = 0x5B; $SHIFT = 0x10; $CTRL = 0x11; $F4 = 0x73; $D = 0x44; $GRAVE = 0xC0
function daemon_start([switch]$Test) {
  if ($Test) { $env:BANEYSPACES_TEST_OPS = '1' } else { Remove-Item Env:BANEYSPACES_TEST_OPS -ErrorAction SilentlyContinue }
  # Read the CLI's output to the end, as a script does, with a deadline: a daemon that inherited the CLI's output
  # handle keeps the stream open for as long as it runs, and the first CI run hung here for 42 minutes.
  $psi = New-Object Diagnostics.ProcessStartInfo $bs, "daemon --background --trace --log `"$dlog`""
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $p = [Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
  $closed = $out.Wait(20000) -and $err.Wait(5000)
  Remove-Item Env:BANEYSPACES_TEST_OPS -ErrorAction SilentlyContinue
  $o = if ($closed) { "$($out.Result)$($err.Result)".Trim() } else { '(its output was still open after 20 s)' }
  Add-Content $log "`$ baneyspaces daemon --background  ->  $o"
  check $closed 'daemon --background returns and closes its output (the daemon holds none of the caller''s handles)' $o
  say "daemon start$(if ($Test) { ' (test ops)' }): $o"
}
function daemon_stop { [void](bsc stop); for ($i = 0; $i -lt 40 -and (Get-Process baneyspaces -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 250 } }
function hidden_entry($st, $h) { @($st.data.hidden | ? { $_.hwnd -eq [long]$h })[0] }
function acl_deny { icacls $state /deny "$($env:USERNAME):(OI)(CI)(WD,AD)" | Out-Null }
function acl_allow { icacls $state /remove:d "$($env:USERNAME)" | Out-Null }
function find_ref($node, $role, $name) {
  if ($node.role -eq $role -and (-not $name -or $node.name -eq $name)) { return $node.ref_id }
  foreach ($c in @($node.children)) { if ($c) { $r = find_ref $c $role $name; if ($r) { return $r } } }
}

say "== runner: $([Environment]::OSVersion.VersionString), session $((Get-Process -Id $PID).SessionId), displays $([Desk]::Displays()), user $env:USERNAME"

say '== 0. clean start'
taskkill /F /IM baneyspaces.exe 2>&1 | Out-Null
Get-Process notepad, bs-testapp -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item -Recurse -Force (Join-Path $state 'state.json'), (Join-Path $state 'actions.jsonl'), (Join-Path $state 'settings.json') -ErrorAction SilentlyContinue
daemon_start -Test
$doc = j (bsc doctor)
check ($doc.data.healthy -eq $true) 'doctor is healthy with the daemon up (daemon, engine, state directory)' (bsc doctor)

say '== 1. open Notepad, Explorer and two test app windows'
Start-Process notepad; Start-Sleep 2
Start-Process explorer.exe -ArgumentList 'C:\Windows'; Start-Sleep 3
Start-Process $testapp; Start-Sleep 2; Start-Process $testapp; Start-Sleep 3
$all = wins; shot '01-opened'
$np = @($all | ? { $_.Class -eq 'Notepad' })[0]; $ex = @($all | ? { $_.Class -eq 'CabinetWClass' })[0]
$ta = @($all | ? { $_.Class -eq 'BaneySpacesTestApp' })
say "notepad $(hw $np)  explorer $(hw $ex)  test apps $(($ta | % { hw $_ }) -join ' ')"
check ($np -and $np.Seen) 'Notepad shows'; check ($ex -and $ex.Seen) 'Explorer shows'; check ($ta.Count -eq 2 -and ($ta | ? { $_.Seen }).Count -eq 2) 'both test app windows show'
Start-Sleep 1
$st = j (bsc state)
check ($st.data.windows.(hw $np).home -eq '1' -or "$($st.data.windows.(hw $np).home)" -match '1') 'the daemon tracks Notepad on workspace 1' ($st.data.windows | ConvertTo-Json -Compress -Depth 4)
$npRect = "$($np.L),$($np.T),$($np.R),$($np.B)"

say '== 2. move Notepad to workspace 2 and a test app to 3 (--stay)'
[void](bsc move 2 --stay --window (hw $np)); [void](bsc move 3 --stay --window (hw $ta[0])); Start-Sleep 1
$s = seen; shot '02-moved'
check ($s -notmatch 'Notepad') 'Notepad is hidden on workspace 1' $s
check ((win $ta[0].Hwnd).Seen -eq $false) 'test app A is hidden on workspace 1'
check ($s -match 'CabinetWClass') 'Explorer stays on workspace 1' $s
$n = win $np.Hwnd
check ($n.Cloaked -eq 2) 'Notepad is hidden by the shell cloak (DWM cloaked = 2), not parked or SW_HIDE' $n
check ("$($n.L),$($n.T),$($n.R),$($n.B)" -eq $npRect) "a cloaked window keeps its frame ($npRect)" $n

say '== 3. switch 1 -> 2 -> 3 -> 1 with the CLI'
[void](bsc switch 2); Start-Sleep 1; $s = seen; shot '03-switch-2'
check ($s -match 'Notepad') 'workspace 2 shows Notepad' $s; check ($s -notmatch 'CabinetWClass') 'workspace 2 hides Explorer' $s
check ((win $ta[0].Hwnd).Seen -eq $false) 'workspace 2 hides test app A'
check ([Desk]::Foreground() -eq $np.Hwnd) 'the shown workspace''s window takes the front (Notepad)' "front is w-$([Desk]::Foreground())"
[void](bsc switch 3); Start-Sleep 1; $s = seen; shot '03-switch-3'
check ((win $ta[0].Hwnd).Seen) 'workspace 3 shows test app A'; check ($s -notmatch 'Notepad') 'workspace 3 hides Notepad' $s
[void](bsc switch 1); Start-Sleep 1; $s = seen; shot '03-switch-1'
check ($s -match 'CabinetWClass') 'workspace 1 shows Explorer' $s; check ($s -notmatch 'Notepad') 'workspace 1 hides Notepad' $s
check ((win $ta[0].Hwnd).Seen -eq $false) 'workspace 1 hides test app A'
$fg = win ([Desk]::Foreground())
check (-not $fg -or $fg.Cloaked -eq 0) 'focus never rests on a hidden window' $fg

say '== 4. the real keyboard hook: Win+2, Win+3, Win+1, Win+Shift+2, Win+` (SendInput, marked as typed)'
keys $WIN, 0x32; $s = seen; shot '04-win-2'
check ($s -match 'Notepad') 'Win+2 shows workspace 2 (Notepad)' $s; check ($s -notmatch 'CabinetWClass') 'Win+2 hid Explorer' $s
$fg = win ([Desk]::Foreground())
check ($fg -and $fg.Class -ne 'Windows.UI.Core.CoreWindow' -and $fg.Class -notmatch 'Start') 'releasing Win after the chord did not open Start (the masking key worked)' $fg
keys $WIN, 0x33; check ((win $ta[0].Hwnd).Seen) 'Win+3 shows workspace 3 (test app A)'
keys $WIN, 0x31; $s = seen; shot '04-win-1'
check ($s -match 'CabinetWClass') 'Win+1 is back on workspace 1' $s; check ((win $ta[0].Hwnd).Seen -eq $false) 'Win+1 hid test app A'
$cur = (j (bsc state)).data.monitors.PSObject.Properties | % { $_.Value.current }
# Unmarked Win+7: the daemon must ignore it (it would switch to 7); the shell has no seventh taskbar button to open.
keys $WIN, 0x37 -Unmarked
$cur2 = (j (bsc state)).data.monitors.PSObject.Properties | % { $_.Value.current }
check ("$cur" -eq "$cur2" -and (win $ta[0].Hwnd).Seen -eq $false) 'an injected Win+7 without the mark is ignored (only typed keys switch)' "$cur -> $cur2"
[void](bsc switch 1); Start-Sleep 1
[void][Desk]::Front($ta[1].Hwnd); Start-Sleep 1
$before = @((j (bsc state)).data.windows.PSObject.Properties | ? { "$($_.Value.home)" -match '2' }).Count
keys $WIN, $SHIFT, 0x32
$st = j (bsc state)
$after = @($st.data.windows.PSObject.Properties | ? { "$($_.Value.home)" -match '2' }).Count
check ($after -gt $before) "Win+Shift+2 sent the front window to workspace 2 ($before -> $after windows there)"
check ((win $ta[1].Hwnd).Seen) 'and followed it there (test app B shows)'
[void](bsc switch 1); Start-Sleep 1
keys $WIN, $GRAVE; $a1 = (j (bsc agent status)).data.shown
keys $WIN, $GRAVE; $a2 = (j (bsc agent status)).data.shown
check ($a1 -eq $true -and $a2 -eq $false) 'Win+` shows the agent workspace, and again hides it' "$a1 then $a2"

say '== 5. taskkill /F the daemon while windows are hidden, then start it again'
check ((cloaked $np.Hwnd) -eq 2) 'before the kill Notepad is cloaked'
taskkill /F /IM baneyspaces.exe 2>&1 | Out-Null; Start-Sleep 1; shot '05-killed'
check ((cloaked $np.Hwnd) -eq 2) 'after the kill the windows are still cloaked (nothing ran to put them back)'
daemon_start -Test; Start-Sleep 2; $s = seen; shot '06-restarted'
check ($s -match 'Notepad') 'restart: Notepad is back' $s; check ((win $ta[0].Hwnd).Seen) 'restart: test app A is back'; check ($s -match 'CabinetWClass') 'restart: Explorer is there' $s
check (@(wins | ? { $_.Cloaked -eq 2 }).Count -eq 0) 'nothing is left cloaked after the restart'
[void](bsc switch 1)

say '== 5b. things that go wrong while windows are hidden'
$ut = $ta[0].Hwnd
[void](bsc move 2 --stay --window "w-$ut"); Start-Sleep 1
check ((cloaked $ut) -eq 2) 'a window of yours is cloaked on workspace 2'
[void][Desk]::SetTitle($ut, ''); Start-Sleep 2; [void](bsc switch 2); Start-Sleep 1
check ((cloaked $ut) -eq 0) 'its title became empty while hidden: switching to 2 still shows it'
[void][Desk]::SetTitle($ut, 'BaneySpaces test app'); Start-Sleep 2
[void](bsc move 2 --stay --window "w-$ut"); [void](bsc switch 1); Start-Sleep 1
check ((cloaked $ut) -eq 2) 'with its title back it is hidden on workspace 2 again'
say "    $([Desk]::Uncloak($ut))"; Start-Sleep 2
check ((cloaked $ut) -eq 2) 'an outside uncloak was undone within two polls'
$o = & $bs daemon --log (Join-Path $Out 'second.log') 2>&1; $code = $LASTEXITCODE
check ($code -eq 1) "a second daemon exits (1) without starting" "exit $code"
check ((cloaked $ut) -eq 2) 'and the first daemon''s hidden window is still hidden'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $replies = @()
foreach ($line in @('"x"', '[1]', '5', '{"op":"ping"}')) {
  $p = New-Object IO.Pipes.NamedPipeClientStream('.', "baneyspaces-$sid", 'InOut'); $p.Connect(3000)
  $w = New-Object IO.StreamWriter($p); $w.AutoFlush = $true; $r = New-Object IO.StreamReader($p)
  $w.WriteLine($line); $replies += $r.ReadLine(); $p.Dispose()
}
Add-Content $log ($replies -join "`n")
check (@($replies | ? { $_ -match 'invalid_args' }).Count -eq 3 -and ($replies[3] -match 'pong')) '"x", [1] and 5 are refused (invalid_args) and a ping after them is answered' ($replies -join ' ')
check ((cloaked $ut) -eq 2) 'the daemon kept the window hidden through it'
acl_deny
$o = bsc switch 2
check ($o -match 'nothing was hidden' -and $o -match '"retry":"safe"') 'with state.json unwritable, switch 2 is refused (nothing was hidden, retry safe)' $o
check ((seen) -match 'CabinetWClass') 'and your windows are still showing'
acl_allow
check ((bsc switch 2) -match '"ok":true') 'once the record can be saved, the same switch works'
Start-Sleep 1; check ((seen) -notmatch 'CabinetWClass') 'before sign-out: workspace 1 (Explorer) is hidden'
say "    $([Desk]::EndSession($false))"; Start-Sleep 2
check ((seen) -match 'CabinetWClass') 'WM_QUERYENDSESSION put the windows back'
say "    $([Desk]::EndSession($true))"; Start-Sleep 3
check ((seen) -notmatch 'CabinetWClass') 'a cancelled sign-out: the next poll hides workspace 1 again'
[void](bsc switch 1); Start-Sleep 1
[void](bsc move 2 --stay --window "w-$ut"); Start-Sleep 1
Stop-Process -Name explorer -Force; Start-Sleep 9
if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe; Start-Sleep 6 }
check ((cloaked $ut) -eq 2) 'explorer.exe restarted: the hidden window is still hidden'
[void](bsc switch 2); Start-Sleep 2
check ((cloaked $ut) -eq 0) 'and it shows again when its workspace is shown'
acl_deny
$o = bsc agent move "w-$ut"
check ($o -match 'nothing was hidden') 'agent move of your window is refused when the record cannot be saved' $o
check ((cloaked $ut) -eq 0) 'and your window is still showing (not ghosted unrecorded)'
acl_allow
check ((bsc agent move "w-$ut") -match '"ok":true') 'agent move works once it can be recorded'
Start-Sleep 1; $e = hidden_entry (j (bsc state)) $ut
check ($e.how -eq 'cloak' -and $e.agent -eq $false) 'it is recorded as yours (cloak, agent false), not as an agent''s ghost' ($e | ConvertTo-Json -Compress)
[void](bsc agent bring "w-$ut"); Start-Sleep 1
check ((cloaked $ut) -eq 0) 'agent bring puts it back'
[void](bsc move 2 --stay --window "w-$ut"); [void](bsc switch 1); Start-Sleep 1
taskkill /F /IM baneyspaces.exe 2>&1 | Out-Null; Start-Sleep 1
$f = Join-Path $state 'state.json'; ((Get-Content $f -Raw) -replace '"class":\s*"BaneySpacesTestApp"', '"class": "SomeOtherClass"') | Set-Content $f
daemon_start -Test; Start-Sleep 2
check ((cloaked $ut) -eq 2) 'a recorded window whose class no longer matches was left alone (still cloaked, not touched)'
check ((Get-Content $dlog | Select-String 'left alone' | Measure-Object).Count -gt 0) 'and it was logged'
say "    $([Desk]::Uncloak($ut))"
$ids = { $d = (j (bsc state)).data.windows; ($d.PSObject.Properties | % { "$($_.Name)=$($_.Value.home)" } | Sort-Object) -join ' ' }
# The window just uncloaked by hand is new to the daemon until its next poll adopts it; wait for that, or the
# snapshot below misses a window the later ones have.
$until = (Get-Date).AddSeconds(5); while ((& $ids) -notmatch "w-$ut=" -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 250 }
$s0 = & $ids
keys $WIN, $CTRL, $D; Start-Sleep 2; $s1 = & $ids; shot '07-virtual-desktop'
check ($s0 -eq $s1) 'on a second virtual desktop every window is still tracked, on the same workspace' "$s0 / $s1"
keys $WIN, $CTRL, $F4; Start-Sleep 2; $s2 = & $ids
check ($s0 -eq $s2) 'and after closing it they are all back, with the same workspaces' "$s0 / $s2"
[void](bsc switch 1)
Get-Process bs-testapp -ErrorAction SilentlyContinue | Stop-Process -Force

say '== 6. production refuses every agent launch (a daemon without test ops)'
daemon_stop; daemon_start
foreach ($app in 'notepad', 'explorer', $testapp) {
  $o = bsc agent open $app
  check ($o -match '"code":"needs_sandbox"') "agent open $(Split-Path -Leaf $app) is refused (needs_sandbox) before anything starts" $o
}
Start-Sleep 1; check (-not ((seen) -match 'BaneySpacesTestApp')) 'no test window appeared'
check ((bsc agent run '--' cmd) -match '"code":"needs_sandbox"') 'agent run is refused too'

say '== 6b. the agent flow with the test app (a test daemon), your Notepad open'
daemon_stop; daemon_start -Test; [void](bsc switch 2); Start-Sleep 1
[Desk]::WatchStart($false)
$o = bsc agent open $testapp
Start-Sleep 6; $wr = [Desk]::WatchStop(); $wr | % { Add-Content $log "    $_" }
check ($o -match '"ok":true') 'agent open bs-testapp' $o
$aw = if ($o -match '"window":"(w-\d+)"') { $Matches[1] } else { '' }
check (($wr -join "`n") -notmatch 'NEW none' -and ($wr -join "`n") -match 'visible_polls=0' -and ($wr -join "`n") -notmatch 'visible_polls=[1-9]') "the agent window was never visible while it opened ($($wr[0]))" ($wr -join ' | ')
shot '08-agent-open'
$sn = bsc agent snapshot --window $aw -i; $snj = j $sn
$ref = if ($snj) { find_ref $snj.data.result.tree 'textfield' $null }
check ([bool]$ref) "agent snapshot found a text field ($ref)" $sn.Substring(0, [Math]::Min(300, $sn.Length))
check ($sn -match '"screen_changed":false') 'snapshot changed nothing you can see'
$t = bsc agent type $ref 'hello from the agent'
check ($t -match '"verified":true') 'agent type landed and the engine read it back (verified)' $t
check ($t -match '"screen_changed":false') 'typing changed nothing you can see'
$btn = if ($snj) { find_ref $snj.data.result.tree 'button' 'Open dialog' }
check ([bool]$btn) "the snapshot has the test app's Open dialog button ($btn)"
[Desk]::WatchStart($true)
$c = bsc agent click $btn
Start-Sleep 5; $wr = [Desk]::WatchStop(); $wr | % { Add-Content $log "    $_" }
check ($c -match '"ok":true') 'agent click on Open dialog' $c
$dl = @($wr | ? { $_ -match 'Test dialog' })[0]
$vp = if ($dl -match 'visible_polls=(\d+)') { [int]$Matches[1] } else { -1 }; $exms = if ($dl -match 'exposed_ms=(\d+)') { [int]$Matches[1] } else { 99 }
# The watch polls tens of thousands of times a second, so the poll count says little; the time between the first
# and last poll that saw it does. Under 33 ms is at most two frames at 60 Hz (the first run measured 6 ms).
check ($vp -ge 0 -and $exms -le 33) "the dialog the app opened was ghosted at once: exposed $exms ms (visible in $vp of $($wr[0]) polls)" ($wr -join ' | ')
$as = j (bsc agent status)
check (@($as.data.windows).Count -eq 2) 'the dialog is an agent window (agent status lists both)'
$dw = @($as.data.windows | ? { $_.window -ne $aw })[0].window
$ds = j (bsc agent snapshot --window $dw -i); $okb = if ($ds) { find_ref $ds.data.result.tree 'button' 'OK' }
check ($okb -and ((bsc agent click $okb) -match '"ok":true')) 'the agent dismissed the dialog through its own window (OK)'
Start-Sleep 2; check (@((j (bsc agent status)).data.windows).Count -eq 1) 'the dialog is gone from the agent workspace'
$awh = [long]($aw -replace 'w-', ''); shot '09-agent-typed'
check (-not (win $awh).Seen) 'the agent''s window is still invisible after typing' (win $awh)
check (-not ((win $np.Hwnd).Title -match '^\*')) 'your Notepad still says Untitled (not modified)' (win $np.Hwnd).Title
check ((bsc agent log --since 300) -match '"verb":"type"') 'the action log recorded the type (no content)'
[void](bsc agent-workspace show); Start-Sleep 1; $w = win $awh
check ($w.Alpha -eq 255 -and $w.Seen) 'agent-workspace show: the agent''s window is opaque and showing' $w
[void](bsc agent-workspace hide); Start-Sleep 1
check ((win $awh).Alpha -eq 0) 'agent-workspace hide: a ghost again' (win $awh)
$before = (Get-Content $dlog | Select-String 'is not hidden any more' | Measure-Object).Count
$pp = bsc agent open $testapp --refuse-ghost
check ($pp -match '"ok":true') 'agent open of a window that refuses the ghost' $pp
$pw = if ($pp -match '"window":"w-(\d+)"') { $Matches[1] } else { '0' }; $ppid = if ($pp -match '"pid":(\d+)') { $Matches[1] } else { '0' }
Start-Sleep 4; $e = hidden_entry (j (bsc state)) $pw
check ($e.how -eq 'park' -and $e.agent -eq $true) 'it is parked and recorded as parked (agent)' ($e | ConvertTo-Json -Compress)
Start-Sleep 3; $after = (Get-Content $dlog | Select-String 'is not hidden any more' | Measure-Object).Count
check ($before -eq $after) "and it is not re-hidden over and over ($before -> $after)"
check (-not (win $pw).Seen) 'it is not on your screen' (win $pw)
[void](bsc agent-workspace show); Start-Sleep 1; [void](bsc agent-workspace hide); Start-Sleep 1
check ((hidden_entry (j (bsc state)) $pw).how -eq 'park') 'show then hide leaves it parked and recorded'
Stop-Process -Id $ppid -Force -ErrorAction SilentlyContinue

say '== 6c. a window on a hidden workspace that its app hides and shows again stays hidden'
# The daemon hides your other workspaces with the shell's own cloak, and the shell decides a window's cloak again when
# the window is shown (it places it on a virtual desktop). A tray app restoring its window on workspace 3 while you are
# on 2 must not draw it on 2, even for the moment between the shell's decision and the daemon's next look.
$rp = Start-Process $testapp -PassThru; Start-Sleep 2
$rw = @(wins | ? { $_.Pid -eq $rp.Id -and $_.Seen })[0]
$cur = "$((j (bsc state)).data.monitors.PSObject.Properties | % { $_.Value.current })"
[void](bsc move 3 --stay --window (hw $rw)); Start-Sleep 1
check ($rw -and (win $rw.Hwnd).Cloaked -ne 0) 'a test app window sent to workspace 3 is cloaked' (win $rw.Hwnd)
[void][Desk]::AppShow($rw.Hwnd, $false); Start-Sleep 1
check (-not (win $rw.Hwnd).Seen) 'its app hid it (SW_HIDE)' (win $rw.Hwnd)
$exp = @()
foreach ($i in 1..5) {
  [Desk]::WatchStart($false)
  [void][Desk]::AppShow($rw.Hwnd, $true); Start-Sleep 3
  $wr = [Desk]::WatchStop(); $wr | % { Add-Content $log "    $_" }
  $ln = @($wr | ? { $_ -match "NEW w-$($rw.Hwnd) " })[0]
  $exp += if ($ln -match 'visible_polls=(\d+) exposed_ms=(\d+)') { "$($Matches[1])/$($Matches[2])ms" } elseif ($ln) { '?' } else { 'not shown' }
  if ($i -lt 5) { [void][Desk]::AppShow($rw.Hwnd, $false); Start-Sleep 1 }
}
check (-not ($exp | ? { $_ -notmatch '^0/' })) "in 5 shows by its app it was never seen on your workspace (visible polls/exposed: $($exp -join ', '))" ($exp -join ', ')
$now = "$((j (bsc state)).data.monitors.PSObject.Properties | % { $_.Value.current })"
check ($now -eq $cur) "you stayed on workspace $cur" "now $now"
check ("$((j (bsc state)).data.windows.(hw $rw).home)" -match '3') 'it is still on workspace 3' ((j (bsc state)).data.windows.(hw $rw) | ConvertTo-Json -Compress)
Stop-Process -Id $rp.Id -Force -ErrorAction SilentlyContinue

say '== 7. deny by default, settings, and agent peers'
check ((bsc get) -match '"dock.enabled":true') 'settings default: dock true'
check ((bsc set dock.enabled false) -match '"ok":true' -and (bsc get dock.enabled) -match 'false') 'set/get round-trips dock.enabled'
check ((bsc set appearance.theme neon) -match 'invalid_args') 'a bad theme is invalid_args'
[void](bsc set dock.enabled true)
$peer = Join-Path $Out 'peer.txt'; $pc = Join-Path $Out 'peer.cmd'
Set-Content $pc "@echo off`r`n`"$bs`" set dock.enabled false > `"$peer`" 2>&1`r`n`"$bs`" switch 2 >> `"$peer`" 2>&1"
[void](bsc agent open cmd.exe /c $pc); Start-Sleep 3
$pt = Get-Content $peer -Raw -ErrorAction SilentlyContinue; Add-Content $log "peer: $pt"
check (([regex]::Matches("$pt", 'not_in_scope')).Count -eq 1 -and "$pt" -match '"dock.enabled":false') 'from an agent''s own process: switch is refused (not_in_scope), set dock.enabled is accepted' $pt
check ((bsc get dock.enabled) -match 'false') 'the agent''s set took effect (agents may customize appearance)'
check ((bsc agent log --since 300) -match '"verb":"set"') 'the set was logged with its caller'
[void](bsc set dock.enabled true)

say '== 8. plug and unplug a display (R-M2, R-M3)'
if ([Desk]::Displays() -lt 2) { skip "section 8: the runner has $([Desk]::Displays()) display and no way to add one without installing a display driver (untested live)" }

say '== 9. the top bar (spec/bar.md): an AppBar on each display, and a maximized window stops below it'
function bars { @([Desk]::Bars()) }
function wa { "$([Desk]::WorkArea() -join ',')" }
# Waits up to 4 s for the bars to be up ($On) or gone, with the work area changed or whole again.
function bar_wait([switch]$On) {
  for ($i = 0; $i -lt 40; $i++) {
    $n = (bars).Count
    if ($On -and $n -ge [Desk]::Displays() -and (wa) -ne $wa0) { break }
    if (-not $On -and $n -eq 0 -and (wa) -eq $wa0) { break }
    Start-Sleep -Milliseconds 100
  }
  Start-Sleep -Milliseconds 300
}
function bar_state { (j (bsc state)).data }
function current_on($st, $mon) { "$(@($st.monitors.PSObject.Properties | ? { $_.Name -eq $mon })[0].Value.current)" }
$wa0 = wa
say "work area with the bar off: $wa0"
check ((bsc get bar.enabled) -match '"bar.enabled":false') 'bar.enabled is off by default' (bsc get bar.enabled)
check ((bars).Count -eq 0) 'no bar window while it is off' ((bars) -join '; ')
$o = bsc set bar.enabled true
check ($o -match '"ok":true') 'baneyspaces set bar.enabled true' $o
bar_wait -On; shot '09-bar-on'
$b = bars; $b | % { say "    bar $_" }
$sb = (bar_state).bar; Add-Content $log "    state.bar $($sb | ConvertTo-Json -Compress -Depth 6)"
check ($b.Count -eq [Desk]::Displays()) "a bar window on each display ($($b.Count) of $([Desk]::Displays()))"
$p = [Desk]::Primary()
$pb = @($b | ? { $_.L -eq $p[0] -and $_.T -eq $p[1] })[0]
$dpi = if ($pb) { [Desk]::Dpi($pb.Hwnd) } else { 96 }
$want = [int][Math]::Floor((26 * $dpi + 48) / 96)
check ($pb -and $pb.R -eq $p[2] -and ($pb.B - $pb.T) -eq $want) "the primary display's bar spans its top edge, $want px tall at $dpi dpi" "$pb; display $($p -join ',')"
check ($pb -and [Desk]::Topmost($pb.Hwnd) -and $pb.Cloaked -eq 0 -and $pb.Pid -eq (Get-Process baneyspaces).Id) 'it is a topmost window of the daemon, not cloaked' $pb
$a = [Desk]::WorkArea()
say "work area with the bar on: $(wa); bar bottom $($pb.B)"
check ($pb -and $a[1] -eq $pb.B -and $a[0] -eq $wa0.Split(',')[0] -and $a[2] -eq $wa0.Split(',')[2] -and $a[3] -eq $wa0.Split(',')[3]) "the work area starts at the bar's bottom and is otherwise as it was ($(wa), was $wa0)"
$sbar = @($sb.bars | ? { $_.hwnd -eq $pb.Hwnd })[0]
check ($sb.enabled -eq $true -and $sbar -and "$($sbar.rect -join ',')" -eq "$($pb.L),$($pb.T),$($pb.R),$($pb.B)") "state.bar reports the AppBar rect the window has ($($sbar.rect -join ','))" ($sb | ConvertTo-Json -Compress -Depth 6)
check ($sb.font -eq 'Cascadia Mono' -or $sb.font -eq 'Consolas') "it draws in a monospace font ($($sb.font), theme $($sb.theme), clock '$($sb.clock)')"
check ("$($sb.clock)" -match '^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) \d{1,2}:\d\d$') "the clock reads as day and time ('$($sb.clock)')"

$mp = Start-Process $testapp -PassThru; Start-Sleep 2
$mw = @(wins | ? { $_.Pid -eq $mp.Id -and $_.Seen })[0]
[void][Desk]::Maximize($mw.Hwnd); Start-Sleep 1; shot '09-bar-maximized'
$f = if ($mw) { [Desk]::Frame($mw.Hwnd) } else { @(0, 0, 0, 0) }
say "maximized w-$($mw.Hwnd): frame $($f -join ','), window $(win $mw.Hwnd), bar bottom $($pb.B)"
check ($mw -and [Desk]::Zoomed($mw.Hwnd) -and $f[1] -eq $pb.B) "a maximized window's top is at the bar's bottom (frame top $($f[1]), bar bottom $($pb.B))" (win $mw.Hwnd)
check ($mw -and ([Desk]::Foreground() -ne $pb.Hwnd)) 'the bar never takes the front' "front is w-$([Desk]::Foreground())"

# A click on a number goes there, the way Win+n does. The test window goes to workspace 4 so the bar shows a 4.
$st = bar_state; $here = current_on $st $sbar.monitor
[void](bsc move 4 --stay --window (hw $mw)); Start-Sleep 1
$cell = @((bar_state).bar.bars | ? { $_.hwnd -eq $pb.Hwnd } | % { $_.cells } | ? { $_.n -eq 4 })[0]
check ($cell) "the bar shows workspace 4 once a window is on it (cells $(((bar_state).bar.bars | ? { $_.hwnd -eq $pb.Hwnd } | % { $_.cells } | % { $_.n }) -join ' '))"
if ($cell) {
  [void][Desk]::Click($pb.L + $cell.x + [int]($cell.w / 2), $pb.T + [int](($pb.B - $pb.T) / 2)); Start-Sleep 1; shot '09-bar-clicked-4'
  $now = current_on (bar_state) $sbar.monitor
  check ($now -eq '4' -and (win $mw.Hwnd).Seen) "a click on 4 switched to workspace 4 and shows its window (was $here, now $now)" (win $mw.Hwnd)
  # The rule (bar::workspaces): the ones with your windows, and the one shown. A workspace you left empty drops out.
  $st = bar_state
  $occ = @($st.windows.PSObject.Properties | % { $_.Value } | ? { -not $_.agent_owned -and "$($_.home)" -match '^[1-9]$' } | % { [int]"$($_.home)" })
  $want = (@($occ) + 4 | Sort-Object -Unique) -join ' '
  $cells = @($st.bar.bars | ? { $_.hwnd -eq $pb.Hwnd } | % { $_.cells })
  check ((($cells | % { $_.n }) -join ' ') -eq $want) "the bar shows the workspaces with your windows and the one shown: $(($cells | % { $_.n }) -join ' ') (want $want)"
  $back = @($cells | ? { $_.n -ne 4 })[0]
  if ($back) {
    [void][Desk]::Click($pb.L + $back.x + [int]($back.w / 2), $pb.T + [int](($pb.B - $pb.T) / 2)); Start-Sleep 1
    check ((current_on (bar_state) $sbar.monitor) -eq "$($back.n)" -and -not (win $mw.Hwnd).Seen) "a click on $($back.n) went there and hid workspace 4" (win $mw.Hwnd)
  } else { bad 'the bar shows a workspace other than 4 to go back to' }
  [void](bsc switch $here)
}
skip 'the bar hiding under a full-screen app (ABN_FULLSCREENAPP): the runner has no full-screen app to raise reliably (untested live)'

$o = bsc set bar.enabled false
check ($o -match '"ok":true') 'baneyspaces set bar.enabled false' $o
bar_wait; shot '09-bar-off'
check ((bars).Count -eq 0) 'turned off, no bar window is left' ((bars) -join '; ')
check ((wa) -eq $wa0) "turned off, the work area is whole again ($(wa), was $wa0)"
Stop-Process -Id $mp.Id -Force -ErrorAction SilentlyContinue

# On, then `baneyspaces stop`: the daemon takes the bar down on its way out.
[void](bsc set bar.enabled true); bar_wait -On
check ((bars).Count -ge 1) 'on again before the daemon stops' (wa)
daemon_stop; Start-Sleep -Milliseconds 500
check ((bars).Count -eq 0 -and (wa) -eq $wa0) "baneyspaces stop takes the bar down and the work area is whole ($(wa), was $wa0)"

# Kept across a restart, and what a daemon killed outright leaves (no cleanup can run): logged, not checked.
daemon_start -Test; bar_wait -On
check ((bars).Count -ge 1 -and (wa) -ne $wa0) "bar.enabled true is kept across a restart ($(wa))"
taskkill /F /IM baneyspaces.exe 2>&1 | Out-Null; Start-Sleep 3
say "after taskkill /F: work area $(wa) (whole is $wa0), bar windows $((bars).Count)"

daemon_stop; shot '10-end'
Get-Process notepad, bs-testapp -ErrorAction SilentlyContinue | Stop-Process -Force
$res = if ($script:fail -eq 0) { 'PASS' } else { 'FAIL' }
say ''; say "RESULT: $res  passed=$($script:pass) failed=$($script:fail) skipped=$($script:skips.Count)   (log: $log)"
if ($env:GITHUB_STEP_SUMMARY) {
  Add-Content $env:GITHUB_STEP_SUMMARY "### Windows live suite: $res, $($script:pass) passed, $($script:fail) failed`n"
  Get-Content $log | ? { $_ -match '^  (FAIL|skip):' } | % { Add-Content $env:GITHUB_STEP_SUMMARY "- $($_.Trim())" }
}
if ($script:fail -ne 0) { exit 1 } else { exit 0 }
