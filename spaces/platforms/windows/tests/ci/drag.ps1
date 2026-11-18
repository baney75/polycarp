# Win+drag organizing of BaneySpaces for Windows, live on a GitHub Actions Windows runner's own desktop (like live.ps1).
# Three kinds of window, one at a time: a Win32 window (WinForms), File Explorer (its bars are WinUI XAML islands) and a
# WebView2 host (the page is another process's child window). Each gets 50 Win+drags typed with SendInput (marked as a
# person's, the daemon's test ops on), cycling through 15 cases: two moves, a resize from each corner, a snap to each
# of 4 edges and 4 corners, and a move cancelled with Escape. The window is put back at the same frame before each.
# A drag passes when, within 1 s of the release, the frame DWM shows is within 2 px of the expected one on every side,
# and the snap preview showed just before the release exactly when a snap was due, at the snap's frame (2 px).
# Fails unless 50 of 50 pass for each window.
# Needs: a release build with the test-ops feature (baneyspaces.exe), and nuget.org for the pinned WebView2 package.
# Usage (Windows PowerShell 5.1): drag.ps1 -Bin <target\release> -Out <evidence dir> [-Disposable]
# It kills BaneySpaces and deletes its recovery record (state.json), so it runs only on a desktop nobody needs: a CI
# runner (GITHUB_ACTIONS=true), or by hand with -Disposable.
param([Parameter(Mandatory = $true)][string]$Bin, [Parameter(Mandatory = $true)][string]$Out, [switch]$Disposable)
if ($env:GITHUB_ACTIONS -ne 'true' -and -not $Disposable) {
  [Console]::Error.WriteLine('drag.ps1: refused. It kills BaneySpaces and deletes its recovery record. Run it only on a disposable desktop (a VM), with -Disposable.')
  exit 2
}
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType Directory -Force $Out | Out-Null
Add-Type -Path @((Join-Path $here 'Desk.cs'), (Join-Path $here 'Bench.cs'), (Join-Path $here 'Drag.cs')) -ReferencedAssemblies System.Drawing
$forms = @('System.Drawing', 'System.Windows.Forms')
$plain = Join-Path $Out 'plain.exe'
Add-Type -Path (Join-Path $here 'Plain.cs') -OutputAssembly $plain -OutputType WindowsApplication -ReferencedAssemblies $forms
$log = Join-Path $Out 'drag.log'; Set-Content $log ''
$dlog = Join-Path $Out 'daemon.log'
$bs = Join-Path $Bin 'baneyspaces.exe'
$state = Join-Path $env:LOCALAPPDATA 'BaneySpaces'
$script:pass = 0; $script:fail = 0

function say($m) { Write-Host $m; Add-Content $log $m }
function check([bool]$c, $m, $why = '') { if ($c) { $script:pass++; say "  ok:   $m" } else { $script:fail++; say "  FAIL: $m$(if ($why) { " ($why)" })" } }
function bsc { $o = (& $bs @args 2>&1 | Out-String).Trim(); Add-Content $log "`$ baneyspaces $args  ->  $($o.Substring(0, [Math]::Min(200, $o.Length)))"; $o }
function near($a, $b) { if ($null -eq $a -or $null -eq $b) { return $false }; for ($i = 0; $i -lt 4; $i++) { if ([Math]::Abs($a[$i] - $b[$i]) -gt 2) { return $false } }; $true }
function who($w) { $r = [Desk]::Read($w); if (-not $r) { "w-$w (gone)" } else { "w-$w pid $($r.Pid) ($((Get-Process -Id $r.Pid -ErrorAction SilentlyContinue).ProcessName)) class '$($r.Class)' title '$($r.Title)'" } }
function procOf($w) { $r = [Desk]::Read($w); if ($r) { (Get-Process -Id $r.Pid -ErrorAction SilentlyContinue).ProcessName } }
# Each drag whose press point another window covered, by that window's process: the harness repairs only what it counts.
$script:covers = @()
function txt($r) { if ($null -eq $r) { 'none' } else { $r -join ',' } }
function half($a, $b) { $a + [int][Math]::Floor(($b - $a) / 2) }

# The WebView2 host, built against Microsoft.Web.WebView2 1.0.4129.50 (2026-07-27), checked by its SHA-256.
$web = Join-Path $Out 'web'; New-Item -ItemType Directory -Force $web | Out-Null
$pkg = Join-Path $Out 'webview2.zip'
Invoke-WebRequest -UseBasicParsing 'https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.4129.50' -OutFile $pkg
$sha = (Get-FileHash $pkg -Algorithm SHA256).Hash
if ($sha -ne 'D3934F482D484B89FB4825DF720C710664E1143A1E90F7B3A60794EF33F473D2') { say "RESULT: FAIL (the WebView2 package's SHA-256 is $sha)"; exit 1 }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($pkg)
foreach ($e in $zip.Entries) {
  if ($e.FullName -in 'lib/net462/Microsoft.Web.WebView2.Core.dll', 'lib/net462/Microsoft.Web.WebView2.WinForms.dll', 'runtimes/win-x64/native/WebView2Loader.dll') {
    [IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path $web $e.Name), $true)
  }
}
$zip.Dispose()
$webExe = Join-Path $web 'web.exe'
Add-Type -Path (Join-Path $here 'Web.cs') -OutputAssembly $webExe -OutputType WindowsApplication -ReferencedAssemblies ($forms + @((Join-Path $web 'Microsoft.Web.WebView2.Core.dll'), (Join-Path $web 'Microsoft.Web.WebView2.WinForms.dll')))

say "== runner: $([Environment]::OSVersion.VersionString), displays $([Desk]::Displays()), work area $(txt ([Drag]::Work()))"
taskkill /F /IM baneyspaces.exe 2>&1 | Out-Null
Remove-Item -Force (Join-Path $state 'state.json'), (Join-Path $state 'actions.jsonl'), (Join-Path $state 'settings.json') -ErrorAction SilentlyContinue
$env:BANEYSPACES_TEST_OPS = '1'; say "daemon: $(bsc daemon --background --trace --log $dlog)"; Remove-Item Env:BANEYSPACES_TEST_OPS
Start-Sleep 1

$W = [Drag]::Work(); $mx = half $W[0] $W[2]; $my = half $W[1] $W[3]; $r = $W[2] - 1; $b = $W[3] - 1
# Each case: where the press lands (a share of the frame), where the pointer goes (an offset, or a point when 'to' is
# set), the button, Escape, and the expected frame from the start frame f and the pointer's move d.
$cases = @(
  @{ n = 'move'; at = 0.5, 0.5; by = 90, 60 },
  @{ n = 'move back'; at = 0.5, 0.5; by = -90, -60 },
  @{ n = 'resize bottom-right'; at = 0.75, 0.75; by = 60, 40; right = $true; edges = 2, 3 },
  @{ n = 'resize top-left'; at = 0.25, 0.25; by = 40, 30; right = $true; edges = 0, 1 },
  @{ n = 'resize top-right'; at = 0.75, 0.25; by = 50, -40; right = $true; edges = 2, 1 },
  @{ n = 'resize bottom-left'; at = 0.25, 0.75; by = -30, 30; right = $true; edges = 0, 3 },
  @{ n = 'snap left'; to = $W[0], $my; snap = $W[0], $W[1], $mx, $W[3] },
  @{ n = 'snap right'; to = $r, $my; snap = $mx, $W[1], $W[2], $W[3] },
  @{ n = 'snap top (fill)'; to = $mx, $W[1]; snap = $W },
  @{ n = 'snap bottom'; to = $mx, $b; snap = $W[0], $my, $W[2], $W[3] },
  @{ n = 'snap top-left'; to = $W[0], $W[1]; snap = $W[0], $W[1], $mx, $my },
  @{ n = 'snap top-right'; to = $r, $W[1]; snap = $mx, $W[1], $W[2], $my },
  @{ n = 'snap bottom-left'; to = $W[0], $b; snap = $W[0], $my, $mx, $W[3] },
  @{ n = 'snap bottom-right'; to = $r, $b; snap = $mx, $my, $W[2], $W[3] },
  @{ n = 'move, then Escape'; at = 0.5, 0.5; by = 150, 100; esc = $true }
)

function drags($name, $h) {
  say "== $name (w-$h): 50 Win+drags"
  $ok = 0; $settle = @()
  for ($i = 0; $i -lt 50; $i++) {
    $c = $cases[$i % $cases.Count]
    # The press must land on the window under test. Something else on top there (a Start or Search flyout an earlier
    # script's bare Win tap opened) would take the press, and the drag would miss through no fault of the daemon's.
    # Counted, named, closed with Escape, and checked again; still covered, the drag runs anyway and fails as it would.
    # The daemon's own window there (a ghost or drag preview left behind) is a BaneySpaces bug: that drag fails at
    # once, with no Escape and no retry.
    $covered = $false; $own = $false
    for ($k = 0; $k -lt 4; $k++) {
      [Drag]::Place($h, 250, 160, 520, 400); Start-Sleep -Milliseconds 120
      $f = [Drag]::Frame($h)
      $x0 = $f[0] + [int](($f[2] - $f[0]) * $(if ($c.at) { $c.at[0] } else { 0.5 }))
      $y0 = $f[1] + [int](($f[3] - $f[1]) * $(if ($c.at) { $c.at[1] } else { 0.5 }))
      $cover = [Drag]::Under($x0, $y0)
      if ($cover -eq $h) { break }
      $pn = procOf $cover
      if (-not $covered) { $covered = $true; $script:covers += $(if ($pn) { $pn } else { "w-$cover" }) }
      if ($pn -eq 'baneyspaces') { $own = $true; say "  drag $i ($($c.n)): FAIL: $(who $cover), the daemon's own window, is over the window at $x0,$y0 (no Escape)"; break }
      if ($k -eq 3) { break }
      say "  drag $i ($($c.n)): $(who $cover) is over the window at $x0,$y0; Escape"
      [Drag]::Escape(); Start-Sleep -Milliseconds 300
    }
    if ($own) { Add-Content $log "  drag $i ($($c.n)): FAIL"; continue }
    $to = if ($c.to) { $c.to } else { @(($x0 + $c.by[0]), ($y0 + $c.by[1])) }
    $pv = $null; [long]$under = 0
    $p = [Drag]::Run($x0, $y0, $to[0], $to[1], [bool]$c.right, [bool]$c.esc, [ref]$pv, [ref]$under)
    $dx = $p[2] - $p[0]; $dy = $p[3] - $p[1]
    $want = if ($c.snap) { @($c.snap) } elseif ($c.esc) { $f } elseif ($c.edges) {
      $e = @($f[0], $f[1], $f[2], $f[3]); foreach ($k in $c.edges) { $e[$k] += $(if ($k % 2 -eq 0) { $dx } else { $dy }) }; $e
    } else { @(($f[0] + $dx), ($f[1] + $dy), ($f[2] + $dx), ($f[3] + $dy)) }
    $sw = [Diagnostics.Stopwatch]::StartNew(); $got = [Drag]::Frame($h)
    while (-not (near $got $want) -and $sw.ElapsedMilliseconds -lt 1000) { Start-Sleep -Milliseconds 10; $got = [Drag]::Frame($h) }
    $pvOk = if ($c.snap) { near $pv $want } else { $null -eq $pv }
    $fine = (near $got $want) -and $pvOk
    if ($fine) { $ok++; $settle += $sw.ElapsedMilliseconds } else {
      [Desk]::Shot((Join-Path $Out ('{0}-{1:D2}.png' -f ($name -replace '\W', ''), $i)))
      say "  drag $i ($($c.n)): frame $(txt $got), want $(txt $want); preview $(txt $pv); pointer $(txt $p); pressed on $(if ($under -eq $h) { 'the window' } else { who $under })"
    }
    Add-Content $log "  drag $i ($($c.n)): $(if ($fine) { "ok in $($sw.ElapsedMilliseconds) ms" } else { 'FAIL' })"
  }
  $slow = if ($settle.Count) { ($settle | Measure-Object -Maximum).Maximum } else { -1 }
  check ($ok -eq 50) "$name`: $ok of 50 Win+drags ended within 2 px of the expected frame, preview right (slowest settle $slow ms)"
}

$pp = Start-Process $plain -PassThru; Start-Sleep 2
$h = @([Desk]::Windows($false) | ? { $_.Pid -eq $pp.Id -and $_.Title -eq 'drag plain' })[0].Hwnd
if ($h) { drags 'Win32 (WinForms)' $h; [Drag]::Close($h) } else { check $false 'the Win32 window opened' }
Start-Sleep 1

$before = @([Desk]::Windows($false) | ? { $_.Class -eq 'CabinetWClass' } | % { $_.Hwnd })
Start-Process explorer.exe -ArgumentList $env:SystemRoot; Start-Sleep 3
$h = @([Desk]::Windows($false) | ? { $_.Class -eq 'CabinetWClass' -and $before -notcontains $_.Hwnd })[0].Hwnd
if ($h) { drags 'File Explorer (WinUI bars)' $h; [Drag]::Close($h) } else { check $false 'a File Explorer window opened' }
Start-Sleep 1

$wp = Start-Process $webExe -ArgumentList (Join-Path $Out 'web-data') -PassThru
$h = $null
for ($k = 0; $k -lt 30 -and -not $h; $k++) { Start-Sleep 1; $h = @([Desk]::Windows($false) | ? { $_.Pid -eq $wp.Id -and $_.Title -eq 'drag web' })[0].Hwnd }
if ($h) {
  [Drag]::Place($h, 250, 160, 520, 400)
  $drew = 0; for ($k = 0; $k -lt 30 -and $drew -lt 10000; $k++) { Start-Sleep 1; $drew = [Bench]::Count([int[]]@(0x0559F1), $null)[0] }
  check ($drew -ge 10000) "the WebView2 page drew ($drew px of its color)"
  drags 'WebView2' $h; [Drag]::Close($h)
} else { check $false 'the WebView2 window opened' }

$lines = @(Get-Content $dlog -ErrorAction SilentlyContinue | ? { $_ -match 'drag: ' })
say "daemon's drag lines: $($lines.Count) (first: $(if ($lines.Count) { $lines[0] }))"
taskkill /F /IM baneyspaces.exe 2>&1 | Out-Null
if ($env:GITHUB_STEP_SUMMARY) { Add-Content $env:GITHUB_STEP_SUMMARY "### Windows Win+drag`n`n$script:pass passed, $script:fail failed" }
# Shell covers are only counted for now: with #557 on main there should be none, and a later change fails on any.
$cv = "covers=$($script:covers.Count)$(if ($script:covers.Count) { " ($($script:covers -join ', '))" })"
if ($script:fail) { say "RESULT: FAIL ($script:fail failed, $script:pass passed) $cv"; exit 1 }
say "RESULT: PASS ($script:pass checks) $cv"
