// What switch-bench.ps1 times and counts from outside the daemon. Compiled together with Desk.cs (it types with
// Desk.Keys and uncloaks with Desk.Uncloak). Every read-back is DWM or GDI, never the daemon's own answer.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;

public static class Bench {
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int sz);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);

    // DWMWA_CLOAKED: 0 when the window is drawn, nonzero when anyone cloaked it.
    public static int Cloaked(long h) { int v; DwmGetWindowAttribute((IntPtr)h, 14, out v, 4); return v; }

    static bool Settled(long[] show, long[] hide) {
        foreach (var h in show) if (Cloaked(h) != 0) return false;
        foreach (var h in hide) if (Cloaked(h) == 0) return false;
        return true;
    }

    // Win+digit typed as a person (the test mark), timed from just before SendInput until every window of show reads
    // uncloaked and every window of hide reads cloaked. -1 if that has not happened after timeoutMs.
    public static double Switch(ushort digitVk, long[] show, long[] hide, int timeoutMs) {
        var sw = Stopwatch.StartNew();
        Desk.Keys(new ushort[] { 0x5B, digitVk }, true);
        while (!Settled(show, hide)) {
            if (sw.ElapsedMilliseconds > timeoutMs) return -1;
            Thread.Yield();
        }
        return sw.Elapsed.TotalMilliseconds;
    }

    // The shell cloak taken off a hidden window from outside (as another tool or a virtual desktop switch would), timed
    // from just before the call until the window reads cloaked again. -1 if it is still uncloaked after timeoutMs.
    // how: what Desk.Uncloak said ("setcloak 0x0" when the call took) and whether the window was seen uncloaked.
    public static double Exposed(long h, int timeoutMs, out string how) {
        var sw = Stopwatch.StartNew();
        how = Desk.Uncloak(h);
        bool seen = false;
        while (Cloaked(h) == 0) {
            seen = true;
            if (sw.ElapsedMilliseconds > timeoutMs) { how += ", still uncloaked"; return -1; }
            Thread.Yield();
        }
        how += seen ? ", seen uncloaked" : ", cloaked again before the first read";
        return sw.Elapsed.TotalMilliseconds;
    }

    // Pixels of each exact color (0xRRGGBB) on the whole virtual screen, and the shot saved to path when one is given (PowerShell passes $null as "", so empty counts as none).
    public static int[] Count(int[] rgb, string path) {
        int x = GetSystemMetrics(76), y = GetSystemMetrics(77), w = GetSystemMetrics(78), hgt = GetSystemMetrics(79);
        var index = new Dictionary<int, int>();
        for (int i = 0; i < rgb.Length; i++) index[rgb[i] & 0xFFFFFF] = i;
        var counts = new int[rgb.Length];
        using (var b = new Bitmap(w, hgt, PixelFormat.Format32bppArgb)) {
            using (var g = Graphics.FromImage(b)) g.CopyFromScreen(x, y, 0, 0, b.Size);
            var d = b.LockBits(new Rectangle(0, 0, w, hgt), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            var row = new int[w];
            for (int r = 0; r < hgt; r++) {
                Marshal.Copy(IntPtr.Add(d.Scan0, r * d.Stride), row, 0, w);
                foreach (var p in row) { int i; if (index.TryGetValue(p & 0xFFFFFF, out i)) counts[i]++; }
            }
            b.UnlockBits(d);
            if (!string.IsNullOrEmpty(path)) b.Save(path);
        }
        return counts;
    }
}
