# The Windows shell (the top bar) on a GitHub Actions Windows runner's own desktop: the real daemon, the real bar,
# real theme changes through the `polycarp` command. Saves full-screen and bar-only screenshots, reads back the work
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
say "daemon: $(bsx daemon --background --log $dlog)"
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

say '== 7. idle'
Start-Sleep -Seconds 3
$sp = shell_proc
if ($sp) {
    $c0 = $sp.TotalProcessorTime.TotalMilliseconds; Start-Sleep -Seconds 30; $sp.Refresh(); $c1 = $sp.TotalProcessorTime.TotalMilliseconds
    $results.idle_cpu_percent_of_one_core = [math]::Round(($c1 - $c0) / 30000.0 * 100.0, 3)
    $results.private_mb = [math]::Round($sp.PrivateMemorySize64 / 1MB, 1)
    $results.working_set_mb = [math]::Round($sp.WorkingSet64 / 1MB, 1)
    check ($results.idle_cpu_percent_of_one_core -lt 0.5) "idle CPU $($results.idle_cpu_percent_of_one_core)% of one core over 30 s; memory $($results.private_mb) MB private, $($results.working_set_mb) MB working set"
} else { bad 'the shell is still running' }

say '== 8. stop gives the top of the screen back'
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
