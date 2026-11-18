// What the CI live suite reads back from Windows and does to it from outside the daemon. Loaded by live.ps1 with
// Add-Type. Read-backs are Win32 only (EnumWindows, DWM cloak state, layered alpha, the foreground), never the
// daemon's own answer.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;

public class Win {
    public long Hwnd; public uint Pid; public string Class; public string Title;
    public int Cloaked; public int Alpha; public bool Parked; public bool Iconic; public int L, T, R, B;
    // What a person would see: drawn, not cloaked, not transparent, not minimized, on screen. A minimized window
    // draws nothing on the desktop (an agent's window starts minimized and a parked one may stay that way).
    public bool Seen { get { return Cloaked == 0 && Alpha > 0 && !Parked && !Iconic; } }
    public override string ToString() {
        return String.Format("w-{0} pid={1} class={2} title='{3}' cloaked={4} alpha={5} parked={6} iconic={7} rect={8},{9},{10},{11} SEEN={12}",
            Hwnd, Pid, Class, Title, Cloaked, Alpha, Parked, Iconic, L, T, R, B, Seen);
    }
}

[ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IServiceProvider10 { [PreserveSig] int QueryService(ref Guid svc, ref Guid riid, out IntPtr obj); }
[ComImport, Guid("372E1D3B-38D3-42E4-A15B-8AB2B178F513"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
public interface IApplicationView {
    [PreserveSig] int SetFocus(); [PreserveSig] int SwitchTo(); [PreserveSig] int TryInvokeBack(IntPtr cb);
    [PreserveSig] int GetThumbnailWindow(out IntPtr h); [PreserveSig] int GetMonitor(out IntPtr m); [PreserveSig] int GetVisibility(out int v);
    [PreserveSig] int SetCloak(uint type, int flags);
}
[ComImport, Guid("1841c6d7-4f9d-42c0-af41-8747538f10e5"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationViewCollection {
    [PreserveSig] int GetViews(out IntPtr a); [PreserveSig] int GetViewsByZOrder(out IntPtr a);
    [PreserveSig] int GetViewsByAumid([MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr a);
    [PreserveSig] int GetViewForHwnd(IntPtr hwnd, out IApplicationView view);
}

public static class Desk {
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool SetWindowTextW(IntPtr h, string t);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int c);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowW(string c, string t);
    [DllImport("user32.dll")] static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetLong(IntPtr h, int i);
    [DllImport("user32.dll")] static extern bool GetLayeredWindowAttributes(IntPtr h, out uint k, out byte a, out uint f);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] i, int sz);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int sz);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct KI { public ushort vk; public ushort scan; public uint flags; public uint time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit, Size = 40)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KI ki; }

    // hook.rs TEST_INPUT_MARK: a test daemon counts injected input with this mark as typed by a person.
    public const ulong Mark = 0xB57E57;
    static readonly string[] Shell = { "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Windows.UI.Core.CoreWindow", "XamlExplorerHostIslandWindow" };

    static string Text(IntPtr h) { var t = new StringBuilder(512); GetWindowText(h, t, 512); return t.ToString(); }
    static string ClassOf(IntPtr h) { var c = new StringBuilder(256); GetClassName(h, c, 256); return c.ToString(); }

    public static Win Read(long id) {
        var h = (IntPtr)id;
        if (!IsWindow(h)) return null;
        long ex = GetLong(h, -20).ToInt64();
        int cloaked; DwmGetWindowAttribute(h, 14, out cloaked, 4);
        RECT r; GetWindowRect(h, out r);
        int alpha = 255;
        if ((ex & 0x80000) != 0) { uint k, f; byte a; if (GetLayeredWindowAttributes(h, out k, out a, out f) && (f & 2) != 0) alpha = a; }
        uint pid; GetWindowThreadProcessId(h, out pid);
        return new Win { Hwnd = id, Pid = pid, Class = ClassOf(h), Title = Text(h), Cloaked = cloaked, Alpha = alpha,
            Parked = r.L <= -30000 && !IsIconic(h), Iconic = IsIconic(h), L = r.L, T = r.T, R = r.R, B = r.B };
    }

    // The app windows (all: every visible top-level window, owned, untitled and tool windows too).
    public static List<Win> Windows(bool all) {
        var rows = new List<Win>();
        EnumWindows((h, l) => {
            if (!IsWindowVisible(h)) return true;
            if (!all) {
                if (Text(h).Length == 0) return true;
                long ex = GetLong(h, -20).ToInt64();
                if ((ex & 0x80) != 0 && (ex & 0x40000) == 0) return true;
                if (GetWindow(h, 4) != IntPtr.Zero && (ex & 0x40000) == 0) return true;
                if (Array.IndexOf(Shell, ClassOf(h)) >= 0) return true;
            }
            rows.Add(Read(h.ToInt64()));
            return true;
        }, IntPtr.Zero);
        return rows;
    }

    public static long Foreground() { return GetForegroundWindow().ToInt64(); }
    public static bool Front(long h) { return SetForegroundWindow((IntPtr)h); }
    public static bool Visible(long h) { return IsWindowVisible((IntPtr)h); }
    public static bool SetTitle(long h, string t) { return SetWindowTextW((IntPtr)h, t); }
    // The window's own thread hides it (SW_HIDE) or shows it without taking the front (SW_SHOWNA), as a tray app
    // does with its window: ShowWindowAsync posts the call to the thread that owns the window.
    public static bool AppShow(long h, bool show) { return ShowWindowAsync((IntPtr)h, show ? 8 : 0); }

    // Keys pressed in order and released in reverse, as one SendInput batch. marked: as a person (see Mark).
    public static uint Keys(ushort[] vks, bool marked) {
        var l = new List<INPUT>();
        Func<ushort, bool, INPUT> k = (vk, up) => { var i = new INPUT(); i.type = 1; i.ki.vk = vk; i.ki.flags = up ? 2u : 0u; i.ki.extra = (UIntPtr)(marked ? Mark : 0); return i; };
        foreach (var v in vks) l.Add(k(v, false));
        for (int i = vks.Length - 1; i >= 0; i--) l.Add(k(vks[i], true));
        return SendInput((uint)l.Count, l.ToArray(), Marshal.SizeOf(typeof(INPUT)));
    }

    // The shell cloak off, as another tool or a virtual desktop switch would.
    public static string Uncloak(long h) {
        var t = Type.GetTypeFromCLSID(new Guid("C2F03A33-21F5-47FA-B4BB-156362A2F239"));
        var sp = (IServiceProvider10)Activator.CreateInstance(t);
        var g = new Guid("1841c6d7-4f9d-42c0-af41-8747538f10e5"); IntPtr o; sp.QueryService(ref g, ref g, out o);
        var coll = (IApplicationViewCollection)Marshal.GetObjectForIUnknown(o);
        IApplicationView v; int hr = coll.GetViewForHwnd((IntPtr)h, out v);
        if (hr != 0 || v == null) return "no view 0x" + hr.ToString("x");
        return "setcloak 0x" + v.SetCloak(1, 0).ToString("x");
    }

    // WM_QUERYENDSESSION, or WM_ENDSESSION(false) for a cancelled sign-out, to the daemon's hidden window.
    public static string EndSession(bool cancel) {
        var w = FindWindowW("BaneySpacesSession", null);
        if (w == IntPtr.Zero) return "no session window";
        return (cancel ? "cancel -> " : "query -> ") + SendMessageW(w, cancel ? 0x16u : 0x11u, IntPtr.Zero, IntPtr.Zero);
    }

    public static void Shot(string path) {
        int x = GetSystemMetrics(76), y = GetSystemMetrics(77), w = GetSystemMetrics(78), h = GetSystemMetrics(79);
        using (var b = new Bitmap(w, h)) using (var g = Graphics.FromImage(b)) { g.CopyFromScreen(x, y, 0, 0, b.Size); b.Save(path); }
    }

    public static int Displays() { return GetSystemMetrics(80); }

    // Watches, as fast as it can poll, for windows that were not there at the start, and counts the polls in which
    // each was seen. Start, do the thing, then Stop for one line per new window.
    class Track { public long First = -1, FirstSeen = -1, LastSeen = -1; public int Visible; public string Last, AtFirstSeen; }
    static System.Threading.Thread watcher;
    static volatile bool watching;
    static Dictionary<long, Track> fresh;
    static int polls;
    public static void WatchStart(bool all) {
        var baseline = new HashSet<long>();
        foreach (var w in Windows(all)) baseline.Add(w.Hwnd);
        fresh = new Dictionary<long, Track>(); polls = 0; watching = true;
        var sw = System.Diagnostics.Stopwatch.StartNew();
        watcher = new System.Threading.Thread(() => {
            while (watching) {
                polls++;
                foreach (var w in Windows(all)) {
                    if (baseline.Contains(w.Hwnd)) continue;
                    Track t; if (!fresh.TryGetValue(w.Hwnd, out t)) { t = new Track { First = sw.ElapsedMilliseconds }; fresh[w.Hwnd] = t; }
                    if (w.Seen) { if (t.FirstSeen < 0) { t.FirstSeen = sw.ElapsedMilliseconds; t.AtFirstSeen = w.ToString(); } t.LastSeen = sw.ElapsedMilliseconds; t.Visible++; }
                    t.Last = w.ToString();
                }
            }
        });
        watcher.IsBackground = true; watcher.Start();
    }
    public static List<string> WatchStop() {
        watching = false; watcher.Join();
        var o = new List<string> { "polls=" + polls };
        foreach (var kv in fresh) {
            var t = kv.Value;
            o.Add(String.Format("NEW w-{0} first_seen_at={1}ms visible_polls={2} exposed_ms={3} :: {4}{5}", kv.Key, t.First, t.Visible, t.Visible > 0 ? t.LastSeen - t.FirstSeen : 0, t.Last,
                t.AtFirstSeen != null ? " :: when first seen: " + t.AtFirstSeen : ""));
        }
        if (fresh.Count == 0) o.Add("NEW none");
        return o;
    }
}
