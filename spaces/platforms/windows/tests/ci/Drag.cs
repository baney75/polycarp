// What drag.ps1 does with the mouse and reads back. Win+drags typed with SendInput and the test mark (the daemon's test
// ops count them as a person's), the frame a window shows (DWM's extended frame bounds), the snap preview, and the
// work area. Every read-back is the window manager's, never the daemon's own answer.
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class Drag {
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MI { public int dx, dy; public uint data, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KI { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit, Size = 40)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MI mi; [FieldOffset(8)] public KI ki; }

    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint p, out RECT r, uint f);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);

    static readonly UIntPtr Mark = (UIntPtr)0xB57E57UL;
    static Drag() { SetProcessDPIAware(); }

    static void Send(INPUT i) { SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))); }
    static void Key(ushort vk, bool up) { var i = new INPUT { type = 1 }; i.ki.vk = vk; i.ki.flags = up ? 2u : 0u; i.ki.extra = Mark; Send(i); }
    // The pointer to (x, y) on the virtual screen, with a button flag or none.
    static void Mouse(uint button, int x, int y) {
        int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
        var i = new INPUT { type = 0 };
        i.mi.dx = (int)(((long)(x - vx) * 65535 + (vw - 1) / 2) / (vw - 1));
        i.mi.dy = (int)(((long)(y - vy) * 65535 + (vh - 1) / 2) / (vh - 1));
        i.mi.flags = button | 0x0001 | 0x4000 | 0x8000; // MOVE | VIRTUALDESK | ABSOLUTE
        i.mi.extra = Mark;
        Send(i);
    }
    static int[] Of(RECT r) { return new int[] { r.L, r.T, r.R, r.B }; }

    public static int[] Frame(long h) {
        RECT r;
        if (DwmGetWindowAttribute((IntPtr)h, 9, out r, 16) != 0) GetWindowRect((IntPtr)h, out r);
        return Of(r);
    }
    public static int[] Work() { RECT r; SystemParametersInfo(0x30, 0, out r, 0); return Of(r); }
    public static int[] Cursor() { POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }
    // The daemon's snap preview, when it is showing; null otherwise.
    public static int[] Preview() {
        var h = FindWindow("BaneySpacesSnapPreview", null);
        if (h == IntPtr.Zero || !IsWindowVisible(h)) return null;
        RECT r; GetWindowRect(h, out r); return Of(r);
    }
    // Not filled, frontmost, at this window rect.
    public static void Place(long h, int x, int y, int w, int hh) { ShowWindow((IntPtr)h, 9); SetWindowPos((IntPtr)h, IntPtr.Zero, x, y, w, hh, 0x0040); }
    // The top-level window a press at (x, y) would land on: the one Win+drag takes (drag.rs `target`).
    public static long Under(int x, int y) {
        var p = new POINT { X = x, Y = y };
        return GetAncestor(WindowFromPoint(p), 2).ToInt64(); // GA_ROOT
    }
    // Escape, marked: closes a Start or Search flyout left open.
    public static void Escape() { Key(0x1B, false); Key(0x1B, true); }
    public static void Close(long h) { PostMessage((IntPtr)h, 0x0010, IntPtr.Zero, IntPtr.Zero); }

    // One Win+drag: Win down, the pointer to (x0, y0), the button down, 12 steps 10 ms apart to (x1, y1), a rest, then
    // the preview is read, Escape is typed when esc, the button comes up and Win is let go. Returns where the pointer
    // was at the press and just before the release (x0, y0, x1, y1); preview is the preview's rect then, or null.
    // under is the window the press landed on.
    public static int[] Run(int x0, int y0, int x1, int y1, bool right, bool esc, out int[] preview, out long under) {
        Key(0x5B, false); Thread.Sleep(20);
        Mouse(0, x0, y0); Thread.Sleep(20);
        var a = Cursor();
        under = Under(a[0], a[1]);
        Mouse(right ? 0x0008u : 0x0002u, x0, y0); Thread.Sleep(20);
        for (int k = 1; k <= 12; k++) { Mouse(0, x0 + (x1 - x0) * k / 12, y0 + (y1 - y0) * k / 12); Thread.Sleep(10); }
        Thread.Sleep(80);
        preview = Preview();
        var b = Cursor();
        if (esc) { Key(0x1B, false); Key(0x1B, true); Thread.Sleep(30); }
        Mouse(right ? 0x0010u : 0x0004u, x1, y1); Thread.Sleep(20);
        Key(0x5B, true);
        return new int[] { a[0], a[1], b[0], b[1] };
    }
}
