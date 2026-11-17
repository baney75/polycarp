# Crash and restart safety on a windows-latest runner's own desktop (study item 6).
#
#   crash-check.ps1 -Bin <dir with baneyspaces.exe and bs-testapp.exe> -Out <evidence dir> [-Kills 20] [-ExplorerRestarts 5]
#
# Six test windows, two each on workspaces 1, 2 and 3. Then:
# 1. -Kills times: fire a switch without waiting for it, Stop-Process -Force the daemon a few ms later, and within 2 s
#    every test window must read as uncloaked with its center on a monitor (a 5 ms sampler watches from the kill on,
#    since the daemon started again hides the off-workspace windows soon after). Then the daemon must be back (a new
#    pid), `baneyspaces state` must put each window on its workspace, and Windows must show exactly the windows of
#    the workspace shown, within 2 s more.
# 2. The crash-loop guard: three kills, each as soon as the daemon is up, and the third is not followed by a start;
#    every window is shown.
# 3. -ExplorerRestarts times: Stop-Process explorer. Within 2 s of the taskbar being back: the same daemon, every
#    window on its workspace, the shown workspace the same, and Windows showing exactly its windows.
# Every read is Win32 (DWM cloak, window rect, monitors) or `baneyspaces state`. Exits 1 on any failure.
param(
    [Parameter(Mandatory)][string]$Bin,
    [Parameter(Mandatory)][string]$Out,
    [int]$Kills = 20,
    [int]$ExplorerRestarts = 5
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\win.ps1"
Add-Type -TypeDefinition @'
using System; using System.Diagnostics; using System.Runtime.InteropServices; using System.Threading;
// From Start() on, the first millisecond each window reads as shown: not cloaked, its center on a monitor.
public static class ShownWatch {
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int sz);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(P p, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowW(string c, string t);
  [StructLayout(LayoutKind.Sequential)] struct R { public int L, T, Rt, B; }
  [StructLayout(LayoutKind.Sequential)] struct P { public int X, Y; }
  static Thread t; static volatile bool stop; static long[] hs; static long[] first; static Stopwatch sw;
  public static bool Shown(long h) {
    int c; DwmGetWindowAttribute((IntPtr)h, 14, out c, 4); if (c != 0) return false;
    R r; if (!GetWindowRect((IntPtr)h, out r)) return false;
    P p; p.X = (r.L + r.Rt) / 2; p.Y = (r.T + r.B) / 2;
    return MonitorFromPoint(p, 0) != IntPtr.Zero;
  }
  public static void Start(long[] handles) {
    hs = handles; first = new long[hs.Length]; for (int i = 0; i < first.Length; i++) first[i] = -1;
    stop = false; sw = Stopwatch.StartNew();
    t = new Thread(() => { while (!stop) { for (int i = 0; i < hs.Length; i++) if (first[i] < 0 && Shown(hs[i])) first[i] = sw.ElapsedMilliseconds; Thread.Sleep(5); } });
    t.IsBackground = true; t.Start();
  }
  // The taskbar: there once explorer.exe is back.
  public static long Tray() { return FindWindowW("Shell_TrayWnd", null).ToInt64(); }
  public static bool AllSeen() { foreach (var f in first) if (f < 0) return false; return true; }
  public static long[] Stop() { stop = true; t.Join(); return first; }
}
'@

New-Item -ItemType Directory -Force $Out | Out-Null
$bs = Join-Path $Bin 'baneyspaces.exe'
$testapp = Join-Path $Bin 'bs-testapp.exe'
$state = if ($env:BANEYSPACES_STATE_DIR) { $env:BANEYSPACES_STATE_DIR } else { Join-Path $env:LOCALAPPDATA 'BaneySpaces' }
$dlog = Join-Path $Out 'daemon.log'

function Cli { $o = (& $bs @args 2>&1 | Out-String).Trim(); try { $o | ConvertFrom-Json } catch { $null } }
function Procs([string]$match) { @(Get-CimInstance Win32_Process -Filter "Name = 'baneyspaces.exe'" | Where-Object { $_.CommandLine -match $match }) }
function Daemon { @(Procs ' daemon' | Where-Object { $_.CommandLine -notmatch '--background' })[0] }
function WatchdogFor([int]$daemonPid) { @(Procs " watchdog --pid $daemonPid ")[0] }
function Up { $d = Cli doctor; ($d.data.checks | Where-Object check -eq 'daemon').ok -eq $true }
function HomeOf($st, [long]$h) { "$($st.data.windows.(WinId $h).home)" }
function ShownWorkspaces($st) { @($st.data.monitors.PSObject.Properties | ForEach-Object { "$($_.Value.current)" }) }
# Every test window on its own workspace in `state`, and shown by Windows exactly when that workspace is shown.
function Settled {
    $st = Cli state
    if (-not $st.ok) { return "state: $($st.error.message)" }
    $shown = ShownWorkspaces $st
    $bad = @()
    for ($i = 0; $i -lt $hs.Count; $i++) {
        $h = $hs[$i]; $n = "$($ws[$i])"; $at = HomeOf $st $h
        $want = $shown -contains $n; $is = [ShownWatch]::Shown($h)
        if ($at -ne $n -or $want -ne $is) { $bad += "w-$h home=$at (want $n) shown=$is (want $want)" }
    }
    if ($bad.Count) { return "workspace(s) shown: $($shown -join ','); " + ($bad -join '; ') }
    ''
}
function WaitSettled([int]$ms) {
    $sw = [Diagnostics.Stopwatch]::StartNew(); $why = 'not checked'
    while ($sw.ElapsedMilliseconds -le $ms) { $why = Settled; if (-not $why) { return @([int]$sw.ElapsedMilliseconds, '') }; Start-Sleep -Milliseconds 50 }
    @(-1, $why)
}
function Place {
    for ($i = 0; $i -lt $hs.Count; $i++) { if ($ws[$i] -ne 1) { $null = Cli move $ws[$i] --stay --window (WinId $hs[$i]) } }
    $null = Cli switch 1
}

try {
    "== clean start"
    Get-Process baneyspaces, bs-testapp -ErrorAction SilentlyContinue | Stop-Process -Force
    Remove-Item (Join-Path $state 'state.json'), (Join-Path $state 'watchdog.json') -ErrorAction SilentlyContinue
    $null = Cli daemon --background --log $dlog
    Check 'the daemon starts' (Up) ''

    $ws = @(1, 1, 2, 2, 3, 3); $hs = @()
    foreach ($n in $ws) {
        $p = Start-Process $testapp -PassThru
        $null = Wait-Until { $p.Refresh(); $p.MainWindowHandle -ne 0 } 5000
        $hs += [long]$p.MainWindowHandle
    }
    $null = Wait-Until { $st = Cli state; @($hs | Where-Object { $st.data.windows.(WinId $_) }).Count -eq $hs.Count } 5000
    Place
    $r = WaitSettled 3000
    Check 'six test windows, two on each of workspaces 1, 2 and 3' ($r[0] -ge 0) "$($hs -join ' ') $($r[1])"
    if ($script:failures) { throw 'setup failed' }
    $null = Wait-Until { [bool](WatchdogFor (Daemon).ProcessId) } 3000
    Check 'the daemon runs a watchdog' ([bool](WatchdogFor (Daemon).ProcessId)) "$((Procs ' watchdog').CommandLine)"

    "== $Kills kills mid-switch"
    for ($k = 1; $k -le $Kills; $k++) {
        $d = Daemon
        # Up a while, so this is not a crash loop (watchdog::QUICK_MS is 5 s).
        $age = ((Get-Date) - $d.CreationDate).TotalMilliseconds
        if ($age -lt 5500) { Start-Sleep -Milliseconds ([int](5500 - $age)) }
        $to = @(2, 3, 1)[$k % 3]
        Start-Process $bs -ArgumentList 'switch', "$to" -WindowStyle Hidden
        Start-Sleep -Milliseconds (Get-Random -Minimum 0 -Maximum 60)
        [ShownWatch]::Start([long[]]$hs)
        Stop-Process -Id $d.ProcessId -Force
        $null = Wait-Until { [ShownWatch]::AllSeen() } 2000
        $first = [ShownWatch]::Stop()
        Check "kill $k (switch to $to in flight): every test window shown and on a monitor within 2 s" (@($first | Where-Object { $_ -lt 0 -or $_ -gt 2000 }).Count -eq 0) "ms after the kill: $($first -join ' ')"
        $ms = Wait-Until { $n = Daemon; $n -and $n.ProcessId -ne $d.ProcessId -and (Up) } 5000
        Check "kill ${k}: the daemon is back" ($ms -ge 0) "$ms ms; old pid $($d.ProcessId), now $((Daemon).ProcessId)"
        $r = WaitSettled 2000
        Check "kill ${k}: every window on its workspace in state, Windows showing exactly the shown workspace's" ($r[0] -ge 0) "$($r[0]) ms $($r[1])"
        if ($script:failures) { break }
    }

    if (-not $script:failures) {
        "== crash-loop guard: three kills right after each start"
        for ($q = 1; $q -le 3; $q++) {
            $null = Wait-Until { $d = Daemon; $d -and (WatchdogFor $d.ProcessId) } 5000
            $d = Daemon
            Stop-Process -Id $d.ProcessId -Force
            if ($q -lt 3) {
                $ms = Wait-Until { $n = Daemon; $n -and $n.ProcessId -ne $d.ProcessId } 5000
                Check "quick kill ${q}: started again" ($ms -ge 0) "$ms ms"
            }
        }
        Start-Sleep 3
        Check 'quick kill 3: not started again' (-not (Daemon)) "$((Procs ' daemon').CommandLine)"
        $hidden = @($hs | Where-Object { -not [ShownWatch]::Shown($_) })
        Check 'and every test window is shown' ($hidden.Count -eq 0) "hidden: $($hidden -join ' ')"
        Check 'the log says why' ((Select-String -Path $dlog -Pattern 'not starting the daemon again' -Quiet)) ''
    }

    if (-not $script:failures) {
        "== $ExplorerRestarts explorer.exe restarts"
        $null = Cli daemon --background --log $dlog
        Place
        $null = WaitSettled 3000
        for ($e = 1; $e -le $ExplorerRestarts; $e++) {
            $null = Cli switch (@(2, 3, 1)[$e % 3])
            $r = WaitSettled 3000
            $d = Daemon; $before = Cli state
            Stop-Process -Name explorer -Force
            $null = Wait-Until { [ShownWatch]::Tray() -eq 0 } 5000
            # Windows starts the shell again by itself (AutoRestartShell); a runner that does not gets it started.
            if ((Wait-Until { [ShownWatch]::Tray() -ne 0 } 6000) -lt 0) { Start-Process explorer.exe }
            $null = Wait-Until { [ShownWatch]::Tray() -ne 0 } 20000
            $r = WaitSettled 2000
            $after = Cli state
            Check "explorer restart ${e}: the same daemon, the same shown workspace" ((Daemon).ProcessId -eq $d.ProcessId -and ((ShownWorkspaces $before) -join ',') -eq ((ShownWorkspaces $after) -join ',')) "pid $($d.ProcessId) -> $((Daemon).ProcessId); $((ShownWorkspaces $before) -join ',') -> $((ShownWorkspaces $after) -join ',')"
            Check "explorer restart ${e}: within 2 s of the taskbar, every window on its workspace and shown or hidden to match" ($r[0] -ge 0) "$($r[0]) ms $($r[1])"
        }
    }
} catch {
    Check 'the check ran to the end' $false "$_"
} finally {
    Copy-Item (Join-Path $state 'state.json'), (Join-Path $state 'watchdog.json') $Out -ErrorAction SilentlyContinue
    $null = & $bs stop 2>&1
    Get-Process bs-testapp -ErrorAction SilentlyContinue | Stop-Process -Force
}
if ($script:failures -gt 0) { "crash-check: $script:failures check(s) failed"; exit 1 }
"crash-check: pass"
exit 0
