# What the CI checks read from Windows itself, never from Polycarp: a window's DWM cloak, its frame, the monitors.
# Dot-source it: `. $PSScriptRoot\win.ps1`. Kept small so other CI scripts can share it.
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class PcWin {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int sz);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonProc p, IntPtr l);
  delegate bool MonProc(IntPtr m, IntPtr dc, ref RECT r, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  // DWMWA_CLOAKED: 0 shown; 1 by the app, 2 by the shell, 4 inherited.
  public static int Cloaked(long h) { int v = 0; DwmGetWindowAttribute((IntPtr)h, 14, out v, 4); return v; }
  public static int[] Rect(long h) { RECT r; GetWindowRect((IntPtr)h, out r); return new int[] { r.L, r.T, r.R, r.B }; }
  public static List<int[]> Monitors() {
    var all = new List<int[]>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr m, IntPtr dc, ref RECT r, IntPtr l) => { all.Add(new int[] { r.L, r.T, r.R, r.B }); return true; }, IntPtr.Zero);
    return all;
  }
  // Inside a monitor: the window's center lies on one.
  public static bool OnAMonitor(long h) {
    var r = Rect(h); int x = (r[0] + r[2]) / 2, y = (r[1] + r[3]) / 2;
    foreach (var m in Monitors()) if (x >= m[0] && x < m[2] && y >= m[1] && y < m[3]) return true;
    return false;
  }
}
'@

# Waits until $test returns true, polling every 50 ms, for at most $ms. Returns the milliseconds it took, or -1.
function Wait-Until([scriptblock]$test, [int]$ms) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -le $ms) {
        if (& $test) { return [int]$sw.ElapsedMilliseconds }
        Start-Sleep -Milliseconds 50
    }
    return -1
}

$script:failures = 0
function Check([string]$name, [bool]$ok, [string]$detail) {
    if ($ok) { "ok   $name ($detail)" } else { "FAIL $name ($detail)"; $script:failures++ }
}

# The window handle as the daemon names it: w-<decimal hwnd>.
function WinId([long]$h) { "w-$h" }
