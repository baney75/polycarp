# Windows PowerShell 5.1 (`shell: powershell`): its .NET Framework has System.Drawing and Windows Forms for the shot.
# Measures one UI stack candidate, the same way for both:
#   cold start: process start to its `ready` line, over -Launches launches (the first is reported apart, as the one
#     that pays for a cold disk cache);
#   key to screen: SendInput of the hotkey to the moment this open's panel color is read back from the screen at a
#     point inside the panel. Each open draws the panel in the other of two colors, so a stale frame never counts;
#   idle CPU and private memory of the whole process tree, and how many processes it has.
# Any `error` line, any line it can't parse and any open that never reaches the screen fail the run.
# Writes <Out>\<Name>.json, .log and .png.
#   measure.ps1 -Exe target\release\spike-native.exe -Name native -Out results
param(
    [Parameter(Mandatory)] [string]$Exe,
    [Parameter(Mandatory)] [string]$Name,
    [Parameter(Mandatory)] [string]$Out,
    [int]$Opens = 40,
    [int]$IdleSeconds = 30,
    [int]$Launches = 5
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null

Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class Keys {
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit, Size = 40)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
    [DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc, int x, int y);
    static INPUT K(ushort vk, bool up) { var i = new INPUT(); i.type = 1; i.ki.vk = vk; i.ki.flags = up ? 2u : 0u; return i; }
    // Screen coordinates are physical pixels, like the candidates' `rect`.
    public static void Init() { SetProcessDPIAware(); }
    // Presses the chord: modifiers down in order, the key, then everything up in reverse.
    public static uint Chord(ushort[] mods, ushort key) {
        var list = new INPUT[mods.Length * 2 + 2];
        int n = 0;
        foreach (var m in mods) list[n++] = K(m, false);
        list[n++] = K(key, false); list[n++] = K(key, true);
        for (int i = mods.Length - 1; i >= 0; i--) list[n++] = K(mods[i], true);
        return SendInput((uint)n, list, Marshal.SizeOf(typeof(INPUT)));
    }
    // The composed screen's color at x,y as 0xRRGGBB: one pixel copied off the screen, then read.
    public static int Read(int x, int y) {
        IntPtr screen = GetDC(IntPtr.Zero), mem = CreateCompatibleDC(screen), bmp = CreateCompatibleBitmap(screen, 1, 1);
        IntPtr old = SelectObject(mem, bmp);
        BitBlt(mem, 0, 0, 1, 1, screen, x, y, 0x00CC0020 | 0x40000000); // SRCCOPY | CAPTUREBLT
        uint c = GetPixel(mem, 0, 0); // 0x00BBGGRR
        SelectObject(mem, old); DeleteObject(bmp); DeleteDC(mem); ReleaseDC(IntPtr.Zero, screen);
        return (int)(((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF));
    }
    static bool Near(int a, int b, int tol) {
        for (int s = 0; s < 24; s += 8) if (Math.Abs(((a >> s) & 0xFF) - ((b >> s) & 0xFF)) > tol) return false;
        return true;
    }
    // Reads the screen at x,y until it shows rgb (each channel within tol); returns the Stopwatch timestamp of the read
    // that saw it, or -1 after timeoutMs.
    public static long WaitColor(int x, int y, int rgb, int tol, int timeoutMs) {
        long end = Stopwatch.GetTimestamp() + (long)timeoutMs * Stopwatch.Frequency / 1000;
        while (Stopwatch.GetTimestamp() < end) {
            if (Near(Read(x, y), rgb, tol)) return Stopwatch.GetTimestamp();
        }
        return -1;
    }
    // Milliseconds one screen read takes: the resolution of key-to-screen.
    public static double ReadMs(int x, int y, int n) {
        long t = Stopwatch.GetTimestamp();
        for (int i = 0; i < n; i++) Read(x, y);
        return (Stopwatch.GetTimestamp() - t) * 1000.0 / Stopwatch.Frequency / n;
    }
    public static void Shot(string path) {
        var b = System.Windows.Forms.Screen.PrimaryScreen.Bounds;
        using (var bmp = new System.Drawing.Bitmap(b.Width, b.Height))
        using (var g = System.Drawing.Graphics.FromImage(bmp)) {
            g.CopyFromScreen(b.X, b.Y, 0, 0, b.Size);
            bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
        }
    }
}
'@
[Keys]::Init()

# The candidates' two panel colors: odd opens, then even opens.
function PanelColor([int]$n) { if ($n % 2 -eq 1) { 0x34382e } else { 0x2e3a46 } }

# Every whole line of the log. The candidates write each line with its newline in one write, and the file is read with
# write sharing, so a line still being written is the text after the last newline: it is left for the next read.
function Lines {
    if (-not (Test-Path $script:log)) { return @() }
    $fs = [System.IO.File]::Open($script:log, 'Open', 'Read', 'ReadWrite')
    try { $text = (New-Object System.IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
    $end = $text.LastIndexOf("`n")
    if ($end -lt 0) { return @() }
    @($text.Substring(0, $end).Split("`n") | ForEach-Object { $_.TrimEnd("`r") })
}
$shapes = @(
    '^ready pid=\d+ hotkey=(ctrl\+win\+k|alt\+space|none) rect=-?\d+,-?\d+,\d+,\d+ dpi=\d+ driver=\S+ adapter=.+$',
    '^painted qpc=-?\d+ hotkey_qpc=-?\d+$',
    '^hidden qpc=-?\d+$',
    '^error .+$'
)
function Unparsed($lines) { @($lines | Where-Object { $l = $_; -not ($shapes | Where-Object { $l -match $_ }) }) }
function Count($lines, [string]$prefix) { @($lines | Where-Object { $_.StartsWith($prefix) }).Count }

function Tree([int]$root) {
    $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
    $ids = [System.Collections.Generic.List[int]]::new(); $ids.Add($root)
    for ($i = 0; $i -lt $ids.Count; $i++) { foreach ($p in $all) { if ($p.ParentProcessId -eq $ids[$i] -and -not $ids.Contains([int]$p.ProcessId)) { $ids.Add([int]$p.ProcessId) } } }
    @($ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
}
# Private bytes summed over the tree. A working set double-counts pages shared between WebView2's processes, so it is
# not reported.
function Mem([int]$root) {
    $t = Tree $root
    [ordered]@{ processes = $t.Count; private_mb = [math]::Round(($t | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB, 1) }
}
function Cpu([int]$root) { $sum = 0.0; foreach ($p in (Tree $root)) { $sum += $p.TotalProcessorTime.TotalMilliseconds }; $sum }
function Pct($xs, [double]$p) { $s = @($xs | Sort-Object); if ($s.Count -eq 0) { return $null }; $s[[math]::Min($s.Count - 1, [math]::Floor($p * $s.Count))] }
function Stop-Tree([int]$root) {
    $t = Tree $root
    $t | Stop-Process -Force -ErrorAction SilentlyContinue
    $t | ForEach-Object { try { $_.WaitForExit(10000) | Out-Null } catch {} }
}

$freq = [System.Diagnostics.Stopwatch]::Frequency
function Ms([int64]$from, [int64]$to) { [math]::Round(($to - $from) * 1000.0 / $freq, 2) }

# Cold start, -Launches times. Every launch but the last is stopped; the last one is measured below.
$cold = @()
for ($k = 1; $k -le $Launches; $k++) {
    $script:log = if ($k -eq $Launches) { Join-Path $Out "$Name.log" } else { Join-Path $Out "$Name-launch$k.log" }
    Remove-Item $script:log -ErrorAction SilentlyContinue
    $env:SPIKE_LOG = $script:log
    $start = [System.Diagnostics.Stopwatch]::GetTimestamp()
    $proc = Start-Process -FilePath $Exe -PassThru
    $ready = $null
    for ($i = 0; $i -lt 3000 -and -not $ready; $i++) {
        $ready = Lines | Where-Object { $_ -like 'ready*' } | Select-Object -First 1
        if (-not $ready) {
            if (Lines | Where-Object { $_ -like 'error*' }) { break }
            Start-Sleep -Milliseconds 5
        }
    }
    if (-not $ready) { Write-Host (Lines); Stop-Tree $proc.Id; throw "$Name never became ready (launch $k)" }
    $cold += Ms $start ([System.Diagnostics.Stopwatch]::GetTimestamp())
    if ($k -lt $Launches) { Stop-Tree $proc.Id; Start-Sleep -Milliseconds 500 }
}
$rest = @($cold | Select-Object -Skip 1)
Write-Host "$Name ready in $($cold -join ', ') ms"
Write-Host "  $ready"

if ($ready -notmatch 'hotkey=(\S+) rect=(-?\d+),(-?\d+),(\d+),(\d+) dpi=(\d+) driver=(\S+) adapter=(.+)$') { throw "$Name ready line has no rect: $ready" }
$hotkey = $Matches[1]
$rect = [ordered]@{ x = [int]$Matches[2]; y = [int]$Matches[3]; w = [int]$Matches[4]; h = [int]$Matches[5] }
$dpi = [int]$Matches[6]; $driver = $Matches[7]; $adapter = $Matches[8]
if ($hotkey -eq 'ctrl+win+k') { $mods = [uint16[]](0x11, 0x5B); $key = [uint16]0x4B }
elseif ($hotkey -eq 'alt+space') { $mods = [uint16[]](0x12); $key = [uint16]0x20 }
else { throw "$Name could not register a hotkey" }
# Inside the panel, clear of its text and border: 40 px in from the right edge and 30 px down, at the display's scale.
$scale = $dpi / 96.0
$px = [int]($rect.x + $rect.w - 40 * $scale); $py = [int]($rect.y + 30 * $scale)
$readMs = [math]::Round([Keys]::ReadMs($px, $py, 50), 3)
Write-Host "  screen probe at $px,$py, one read $readMs ms"

Start-Sleep -Seconds 3
$memIdle = Mem $proc.Id
$c0 = Cpu $proc.Id; Start-Sleep -Seconds $IdleSeconds; $c1 = Cpu $proc.Id
$idleCpu = [math]::Round(($c1 - $c0) / ($IdleSeconds * 1000.0) * 100.0, 3)

$screen = @(); $logged = @(); $inproc = @(); $missed = 0
for ($n = 1; $n -le $Opens; $n++) {
    $lines = Lines
    $before = (Count $lines 'painted') + (Count $lines 'error open')
    $t0 = [System.Diagnostics.Stopwatch]::GetTimestamp()
    [void][Keys]::Chord($mods, $key)
    # The candidate numbers its opens itself; a chord it never got must not shift every later color.
    $seen = [Keys]::WaitColor($px, $py, (PanelColor ($before + 1)), 3, 2000)
    # The candidate's own line for this open: painted, or an error.
    $line = $null
    for ($w = 0; $w -lt 400 -and -not $line; $w++) {
        $p = @(Lines | Where-Object { $_ -like 'painted*' -or $_ -like 'error open*' })
        if ($p.Count -gt $before) { $line = $p[-1] } else { Start-Sleep -Milliseconds 5 }
    }
    if ($seen -lt 0 -or -not $line -or $line -notmatch '^painted qpc=(-?\d+) hotkey_qpc=(-?\d+)$') {
        $missed++
        Write-Host "  open ${n}: $(if ($seen -lt 0) { 'never on screen' } else { 'on screen' }), log: $(if ($line) { $line } else { 'nothing' })"
    } else {
        $screen += Ms $t0 $seen
        $logged += Ms $t0 ([int64]$Matches[1])
        $inproc += Ms ([int64]$Matches[2]) ([int64]$Matches[1])
        if ($n -eq 1) { [Keys]::Shot((Join-Path $Out "$Name.png")) }
    }
    # Close it again, whatever happened, if the candidate counted the open: it says hidden when it hides.
    $lines = Lines
    $hb = Count $lines 'hidden'
    if ((Count $lines 'painted') + (Count $lines 'error open') -gt $hb) {
        [void][Keys]::Chord($mods, $key)
        for ($w = 0; $w -lt 400 -and (Count (Lines) 'hidden') -le $hb; $w++) { Start-Sleep -Milliseconds 5 }
    }
    Start-Sleep -Milliseconds 150
}
$memAfter = Mem $proc.Id
Stop-Tree $proc.Id

$all = Lines
$errors = @($all | Where-Object { $_ -like 'error*' })
$bad = Unparsed $all
$r = [ordered]@{
    name = $Name; hotkey = $hotkey; driver = $driver; adapter = $adapter; dpi = $dpi; rect = $rect
    opens = $Opens; samples = $screen.Count; missed = $missed; errors = $errors.Count; unparsed_lines = $bad.Count
    cold_start_ms = [ordered]@{ launches = $cold.Count; first = $cold[0]; median_of_rest = (Pct $rest 0.5); max_of_rest = (Pct $rest 1.0); all = $cold }
    key_to_screen_ms = [ordered]@{ median = (Pct $screen 0.5); p95 = (Pct $screen 0.95); max = (Pct $screen 1.0); first = $screen[0] }
    screen_read_ms = $readMs
    key_to_painted_line_ms = [ordered]@{ median = (Pct $logged 0.5); p95 = (Pct $logged 0.95); max = (Pct $logged 1.0) }
    hotkey_msg_to_painted_line_ms = [ordered]@{ median = (Pct $inproc 0.5); p95 = (Pct $inproc 0.95); max = (Pct $inproc 1.0) }
    idle_cpu_percent_of_one_core = $idleCpu; idle_seconds = $IdleSeconds
    memory_idle = $memIdle; memory_after_opens = $memAfter
    samples_ms = $screen
}
$r | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $Out "$Name.json")
$r | ConvertTo-Json -Depth 4 | Write-Host
$why = @()
if ($errors.Count -gt 0) { $why += "$($errors.Count) error lines (first: $($errors[0]))" }
if ($bad.Count -gt 0) { $why += "$($bad.Count) lines it could not parse (first: $($bad[0]))" }
if ($missed -gt 0) { $why += "missed $missed of $Opens opens" }
if ($why) { throw "${Name}: $($why -join '; ')" }
