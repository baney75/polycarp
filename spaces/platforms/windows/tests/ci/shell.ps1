# The Windows shell (the top bar and the launcher) on a GitHub Actions Windows runner's own desktop: the real daemon,
# the real bar, real theme changes through the `polycarp` command, and the launcher opened by its real key. Saves full-screen and bar-only screenshots, reads back the work
# area and a maximized window's frame, and prints PASS or FAIL with counts; exits 1 on any FAIL.
# Usage (Windows PowerShell 5.1, which has System.Drawing):
#   shell.ps1 -Bin <dir with baneyspaces.exe> -Cli <polycarp.exe> -Themes <repo>\themes -Out <evidence dir>
param(
    [Parameter(Mandatory = $true)][string]$Bin,
    [Parameter(Mandatory = $true)][string]$Cli,
    [Parameter(Mandatory = $true)][string]$Themes,
    [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path $Out).Path
# Absolute, so a background job (which starts in another folder) finds the binary too.
$Bin = (Resolve-Path $Bin).Path
$log = Join-Path $Out 'shell-test.log'; Set-Content $log ''
$slog = Join-Path $Out 'shell.log'; Remove-Item $slog -ErrorAction SilentlyContinue
$dlog = Join-Path $Out 'daemon.log'
$bs = Join-Path $Bin 'baneyspaces.exe'
# A throwaway config folder: never the runner's real one.
$env:POLYCARP_CONFIG_DIR = Join-Path $env:RUNNER_TEMP 'polycarp-config'
Remove-Item -Recurse -Force $env:POLYCARP_CONFIG_DIR -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:POLYCARP_CONFIG_DIR | Out-Null
$script:pass = 0; $script:fail = 0
$results = [ordered]@{}

Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Desk {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern bool SystemParametersInfoW(uint a, uint b, ref RECT r, uint c);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint f, int x, int y, uint d, UIntPtr e);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    // Presses the keys in order and lets them go in reverse, as a hand does a chord.
    public static void Chord(params byte[] keys) {
        foreach (var k in keys) keybd_event(k, 0, 0, UIntPtr.Zero);
        for (int i = keys.Length - 1; i >= 0; i--) keybd_event(keys[i], 0, 2, UIntPtr.Zero);
    }
    public static int WorkTop() { var r = new RECT(); SystemParametersInfoW(0x30, 0, ref r, 0); return r.Top; }
    // The window's visible frame (DWM's extended frame bounds), not its rect, which includes invisible borders.
    public static int[] Frame(IntPtr h) { RECT r; DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))); return new int[] { r.Left, r.Top, r.Right, r.Bottom }; }
    public static void Maximize(IntPtr h) { SetForegroundWindow(h); ShowWindow(h, 3); }
    public static void Click(int x, int y) { SetCursorPos(x, y); mouse_event(2, 0, 0, 0, UIntPtr.Zero); mouse_event(4, 0, 0, 0, UIntPtr.Zero); }
    public static void Shot(string path, int height) {
        var b = System.Windows.Forms.Screen.PrimaryScreen.Bounds;
        int h = height > 0 ? Math.Min(height, b.Height) : b.Height;
        using (var bmp = new System.Drawing.Bitmap(b.Width, h))
        using (var g = System.Drawing.Graphics.FromImage(bmp)) {
            g.CopyFromScreen(b.X, b.Y, 0, 0, new System.Drawing.Size(b.Width, h));
            bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
        }
    }
}
'@

function say($m) { Write-Host $m; Add-Content $log $m }
function ok($m) { $script:pass++; say "  ok:   $m" }
function bad($m) { $script:fail++; say "  FAIL: $m" }
function check([bool]$c, $m, $why = '') { if ($c) { ok $m } else { bad "$m$(if ($why) { " ($why)" })" } }
function lines { if (Test-Path $slog) { @(Get-Content $slog) } else { @() } }
# Waits for a new shell log line matching $pattern after line $from; returns it or $null.
function wait_line($pattern, [int]$from = 0, [int]$ms = 8000) {
    $end = [DateTime]::UtcNow.AddMilliseconds($ms)
    while ([DateTime]::UtcNow -lt $end) {
        $l = @(lines); for ($i = $from; $i -lt $l.Count; $i++) { if ($l[$i] -match $pattern) { return $l[$i] } }
        Start-Sleep -Milliseconds 50
    }
    $null
}
function shot($name) { try { [Desk]::Shot((Join-Path $Out "$name.png"), 0); [Desk]::Shot((Join-Path $Out "bar-$name.png"), $script:barPx * 3) } catch { say "  (no shot $name`: $_)" } }
function bsx { $o = (& $bs @args 2>&1 | Out-String).Trim(); Add-Content $log "`$ baneyspaces $args  ->  $o"; $o }
function theme { $o = (& $Cli theme @args 2>&1 | Out-String).Trim(); Add-Content $log "`$ polycarp theme $args  ->  $($o.Substring(0, [Math]::Min(300, $o.Length)))"; $o }
function shell_proc { Get-Process baneyspaces -ErrorAction SilentlyContinue | Where-Object { $_.Id -eq $script:shellPid } }

say "== runner: $([Environment]::OSVersion.VersionString), screen $([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Size)"
$workBefore = [Desk]::WorkTop()

say '== 1. the daemon, then the bar with the built-in theme'
[void](theme set polycarp)
# Started the way a script starts it, reading its output through a pipe: it must come back. It hung forever
# while the daemon it starts inherited that pipe.
$job = Start-Job -ScriptBlock { param($b, $l) (& $b daemon --background --log $l 2>&1 | Out-String).Trim() } -ArgumentList $bs, $dlog
$started = Wait-Job $job -Timeout 20
check ($null -ne $started) 'daemon --background returns while its output is read through a pipe'
if ($started) { say "daemon: $(Receive-Job $job 2>&1)" } else { say 'daemon: no answer in 20 s'; Stop-Job $job }
Remove-Job $job -Force
$p = Start-Process -FilePath $bs -ArgumentList @('shell', '--log', $slog) -PassThru -WindowStyle Hidden
$script:shellPid = $p.Id
$ready = wait_line 'ready pid=' 0 15000
check ($null -ne $ready) 'the shell starts' (lines | Select-Object -Last 5 | Out-String)
$placed = wait_line 'bar \\\\\.\\DISPLAY\d+ at (-?\d+),(-?\d+) (\d+)x(\d+) px'
$script:barPx = 32
if ($placed -match ' at (-?\d+),(-?\d+) (\d+)x(\d+) px') { $script:barPx = [int]$Matches[4] }
check ($null -ne (wait_line 'drawn .* feed=up' 0 10000)) 'the bar is drawn with the daemon feed up'
$work = [Desk]::WorkTop()
check ($work -eq $script:barPx) "the work area starts below the bar (work area top $work, bar $($script:barPx) px, before $workBefore)"

say '== 2. a maximized window stops below the bar'
$np = Start-Process notepad -PassThru
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 60 -and $h -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 250; $np.Refresh(); $h = $np.MainWindowHandle; if ($h -eq [IntPtr]::Zero) { $h = (Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle } }
if ($h -and $h -ne [IntPtr]::Zero) {
    [Desk]::Maximize($h); Start-Sleep -Milliseconds 800
    $f = [Desk]::Frame($h)
    check ($f[1] -ge $script:barPx) "maximized Notepad's frame starts at y $($f[1]), at or below the bar's $($script:barPx) px"
} else { bad 'Notepad opened a window' }
Start-Sleep -Milliseconds 500
shot '1-workspace-1'

say '== 3. a switch redraws the bar within a frame'
$n = @(lines).Count
say "switch: $(bsx switch 3)"
$moved = wait_line '-> 3$' $n 3000
check ($null -ne $moved) 'the bar hears the switch to 3'
$first = wait_line 'first frame \\\\\.\\DISPLAY\d+ current=3 ([\d.]+) ms from the feed line' $n 3000
if ($first -match '([\d.]+) ms from the feed line') { $results.feed_to_first_frame_ms = [double]$Matches[1] }
check ($first -and $results.feed_to_first_frame_ms -lt 16.7) "the first frame showing 3 is drawn $($results.feed_to_first_frame_ms) ms after the daemon's line is read (under one 60 Hz frame)"
check ($null -ne (wait_line 'drawn \\\\\.\\DISPLAY\d+ current=3 ' $n 3000)) 'and workspace 3 settles as current'
Start-Sleep -Milliseconds 500
shot '2-workspace-3'

say '== 4. a click on the bar switches'
$n = @(lines).Count
# Workspace 2's tile, from the bar's layout at 96 DPI: 12 px in, then one 24 px tile and its 2 px gap.
$scale = $script:barPx / 32.0
[Desk]::Click([int](50 * $scale), [int]($script:barPx / 2))
check ($null -ne (wait_line 'click: workspace 2' $n 3000)) 'the click lands on workspace 2'
check ($null -ne (wait_line 'drawn \\\\\.\\DISPLAY1 current=2 ' $n 4000)) 'and the bar shows 2 as current'
Start-Sleep -Milliseconds 400

say '== 5. a theme change restyles the bar'
[void](bsx switch 1); Start-Sleep -Milliseconds 600
shot '3-before-theme'
$n = @(lines).Count
[void](theme set blocks)
check ($null -ne (wait_line 'theme polycarp -> blocks' $n 5000)) 'the bar reads the new theme' (lines | Select-Object -Last 4 | Out-String)
check ($null -ne (wait_line 'drawn .* theme=blocks indicator=NumberBlock' $n 5000)) 'and redraws with its number-block indicator'
Start-Sleep -Milliseconds 300
shot '4-after-theme-blocks'

say '== 6. every shipped theme reads'
$last = 'blocks'
foreach ($t in (Get-ChildItem (Join-Path $Themes '*.toml') | ForEach-Object { $_.BaseName })) {
    if ($t -eq $last) { continue }
    $n = @(lines).Count
    [void](theme set $t)
    $got = wait_line "theme $last -> |theme kept" $n 5000
    check ($got -and $got -notmatch 'theme kept') "theme $t reads" "$got"
    if ($got -match "-> (\S+)") { $last = $Matches[1] }
    Start-Sleep -Milliseconds 300
    try { [Desk]::Shot((Join-Path $Out "theme-$t.png"), $script:barPx * 2) } catch {}
}
$n = @(lines).Count
[void](theme off)
check ($null -ne (wait_line 'theme \S+ -> polycarp' $n 5000)) 'theme off goes back to the built-in theme'

say '== 7. the launcher: its key, type notepad, Enter starts Notepad'
$held = wait_line 'launcher key ' 0 1000
check ($held -match 'Ctrl\+Win\+K') 'the launcher holds Ctrl+Win+K' "$held"
check ($null -ne (wait_line 'launcher apps \d+ in' 0 20000)) 'the Start menu apps are read' (lines | Select-String 'launcher' | Out-String)
# Step 2's Notepad goes, so the Notepad found is the app, and the window that appears is the launcher's doing.
Get-Process notepad -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 1500
$n = @(lines).Count
[Desk]::Chord(0x11, 0x5B, 0x4B)   # Ctrl, left Win, K
$shown = wait_line 'launcher shown by key' $n 3000
check ($null -ne $shown) 'Ctrl+Win+K opens the launcher' (lines | Select-Object -Last 4 | Out-String)
if ($shown -match 'first frame ([\d.]+) ms') { $results.launcher_open_first_frame_ms = [double]$Matches[1] }
check ($shown -match ', in front') 'and it takes the keyboard' "$shown"
$n = @(lines).Count
foreach ($c in 'NOTEPAD'.ToCharArray()) { [Desk]::Chord([byte][char]$c); Start-Sleep -Milliseconds 80 }
$typed = @()
$end = [DateTime]::UtcNow.AddSeconds(4)
while ($typed.Count -lt 7 -and [DateTime]::UtcNow -lt $end) {
    $typed = @(@(lines) | Select-Object -Skip $n | Where-Object { $_ -match 'launcher key->paint=' }); Start-Sleep -Milliseconds 50
}
$ms = @($typed | ForEach-Object { if ($_ -match 'key->paint=([\d.]+) results=(\d+)') { [double]$Matches[1] } } | Sort-Object)
$rows = if ($typed.Count -gt 0 -and $typed[-1] -match 'results=(\d+)') { [int]$Matches[1] } else { 0 }
if ($ms.Count -gt 0) {
    $results.launcher_key_to_paint_ms_median = $ms[[int][math]::Floor(($ms.Count - 1) / 2)]
    $results.launcher_key_to_paint_ms_max = $ms[-1]
}
check ($ms.Count -eq 7) "each of the 7 keystrokes is drawn and logged ($($ms.Count) lines)"
check ($ms.Count -gt 0 -and $results.launcher_key_to_paint_ms_max -lt 16.7) "every keystroke reaches the screen within a 60 Hz frame (median $($results.launcher_key_to_paint_ms_median) ms, max $($results.launcher_key_to_paint_ms_max) ms)"
check ($rows -gt 0) "notepad finds something ($rows rows)"
check (-not (@($typed) -match 'notepad')) 'the timing lines never hold what was typed'
Start-Sleep -Milliseconds 300
shot '5-launcher-notepad'
$sp = shell_proc
if ($sp) {
    $c0 = $sp.TotalProcessorTime.TotalMilliseconds; Start-Sleep -Seconds 10; $sp.Refresh(); $c1 = $sp.TotalProcessorTime.TotalMilliseconds
    $results.launcher_open_idle_cpu_percent = [math]::Round(($c1 - $c0) / 10000.0 * 100.0, 3)
    check ($results.launcher_open_idle_cpu_percent -lt 0.5) "the open launcher idles at $($results.launcher_open_idle_cpu_percent)% of one core over 10 s"
}
$n = @(lines).Count
[Desk]::Chord(0x0D)
check ($null -ne (wait_line 'launcher run: app' $n 3000)) 'Enter starts the top hit, an app' (lines | Select-Object -Last 4 | Out-String)
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 60 -and $h -eq [IntPtr]::Zero; $i++) {
    Start-Sleep -Milliseconds 250
    $h = (Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle
    if ($null -eq $h) { $h = [IntPtr]::Zero }
}
check ($h -ne [IntPtr]::Zero) 'and a Notepad window appears'
Start-Sleep -Milliseconds 800
shot '6-launched-notepad'
$n = @(lines).Count
[Desk]::Chord(0x11, 0x5B, 0x4B)
check ($null -ne (wait_line 'launcher shown by key' $n 3000)) 'the key opens it again'
[Desk]::Chord(0x1B)
check ($null -ne (wait_line 'launcher hidden: Esc' $n 3000)) 'and Esc closes it'

say '== 8. idle'
Start-Sleep -Seconds 3
$sp = shell_proc
if ($sp) {
    $c0 = $sp.TotalProcessorTime.TotalMilliseconds; Start-Sleep -Seconds 30; $sp.Refresh(); $c1 = $sp.TotalProcessorTime.TotalMilliseconds
    $results.idle_cpu_percent_of_one_core = [math]::Round(($c1 - $c0) / 30000.0 * 100.0, 3)
    $results.private_mb = [math]::Round($sp.PrivateMemorySize64 / 1MB, 1)
    $results.working_set_mb = [math]::Round($sp.WorkingSet64 / 1MB, 1)
    check ($results.idle_cpu_percent_of_one_core -lt 0.5) "idle CPU $($results.idle_cpu_percent_of_one_core)% of one core over 30 s; memory $($results.private_mb) MB private, $($results.working_set_mb) MB working set"
} else { bad 'the shell is still running' }

say '== 9. stop gives the top of the screen back'
say "stop: $(bsx shell stop)"
Start-Sleep -Milliseconds 500
check (-not (shell_proc)) 'the shell quits'
check ([Desk]::WorkTop() -eq $workBefore) "the work area top is $([Desk]::WorkTop()) again (was $workBefore)"
[void](bsx stop)
Get-Process notepad -ErrorAction SilentlyContinue | Stop-Process -Force

$results.pass = $script:pass; $results.fail = $script:fail; $results.bar_px = $script:barPx
$results | ConvertTo-Json | Set-Content (Join-Path $Out 'shell.json')
say ''
if ($script:fail -eq 0) { say "PASS: $($script:pass) checks" } else { say "FAIL: $($script:fail) of $($script:pass + $script:fail) checks failed" }
Get-Content $slog -ErrorAction SilentlyContinue | Select-Object -Last 60 | ForEach-Object { Write-Host "  | $_" }
if ($script:fail -gt 0) { exit 1 }
