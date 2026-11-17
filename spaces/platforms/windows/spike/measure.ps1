# Measures one UI stack candidate: cold start to ready, idle CPU and memory of its whole process tree, and hotkey to
# first composed frame over many opens of a warm hidden window. Writes <Out>\<Name>.json, .log and .png.
#   measure.ps1 -Exe target\release\spike-native.exe -Name native -Out results
param(
    [Parameter(Mandatory)] [string]$Exe,
    [Parameter(Mandatory)] [string]$Name,
    [Parameter(Mandatory)] [string]$Out,
    [int]$Opens = 40,
    [int]$IdleSeconds = 30
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$log = Join-Path $Out "$Name.log"
Remove-Item $log -ErrorAction SilentlyContinue
$env:SPIKE_LOG = $log

Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Keys {
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit, Size = 40)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    static INPUT K(ushort vk, bool up) { var i = new INPUT(); i.type = 1; i.ki.vk = vk; i.ki.flags = up ? 2u : 0u; return i; }
    // Presses the chord: modifiers down in order, the key, then everything up in reverse.
    public static uint Chord(ushort[] mods, ushort key) {
        var list = new System.Collections.Generic.List<INPUT>();
        foreach (var m in mods) list.Add(K(m, false));
        list.Add(K(key, false)); list.Add(K(key, true));
        for (int i = mods.Length - 1; i >= 0; i--) list.Add(K(mods[i], true));
        return SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(INPUT)));
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

function Lines { if (Test-Path $log) { @(Get-Content $log) } else { @() } }
function Tree([int]$root) {
    $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
    $ids = [System.Collections.Generic.List[int]]::new(); $ids.Add($root)
    for ($i = 0; $i -lt $ids.Count; $i++) { foreach ($p in $all) { if ($p.ParentProcessId -eq $ids[$i] -and -not $ids.Contains([int]$p.ProcessId)) { $ids.Add([int]$p.ProcessId) } } }
    @($ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
}
function Mem([int]$root) {
    $t = Tree $root
    [ordered]@{ processes = $t.Count; private_mb = [math]::Round(($t | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB, 1); working_set_mb = [math]::Round(($t | Measure-Object WorkingSet64 -Sum).Sum / 1MB, 1) }
}
function Cpu([int]$root) { (Tree $root | Measure-Object -Property { $_.TotalProcessorTime.TotalMilliseconds } -Sum).Sum }
function Pct($xs, [double]$p) { $s = @($xs | Sort-Object); if ($s.Count -eq 0) { return $null }; $s[[math]::Min($s.Count - 1, [math]::Floor($p * $s.Count))] }

$freq = [System.Diagnostics.Stopwatch]::Frequency
$start = [System.Diagnostics.Stopwatch]::GetTimestamp()
$proc = Start-Process -FilePath $Exe -PassThru
$ready = $null
for ($i = 0; $i -lt 1200 -and -not $ready; $i++) { $ready = Lines | Where-Object { $_ -like 'ready*' } | Select-Object -First 1; if (-not $ready) { Start-Sleep -Milliseconds 25 } }
if (-not $ready) { Write-Host (Lines); throw "$Name never became ready" }
$coldMs = [math]::Round(([System.Diagnostics.Stopwatch]::GetTimestamp() - $start) * 1000.0 / $freq, 1)
$hotkey = ($ready -replace '.*hotkey=', '')
Write-Host "$Name ready in $coldMs ms, hotkey $hotkey"
if ($hotkey -eq 'ctrl+win+k') { $mods = [uint16[]](0x11, 0x5B); $key = [uint16]0x4B }
elseif ($hotkey -eq 'alt+space') { $mods = [uint16[]](0x12); $key = [uint16]0x20 }
else { throw "$Name could not register a hotkey" }

Start-Sleep -Seconds 3
$memIdle = Mem $proc.Id
$c0 = Cpu $proc.Id; Start-Sleep -Seconds $IdleSeconds; $c1 = Cpu $proc.Id
$idleCpu = [math]::Round(($c1 - $c0) / ($IdleSeconds * 1000.0) * 100.0, 3)

$external = @(); $inproc = @(); $missed = 0
for ($n = 1; $n -le $Opens; $n++) {
    $before = @(Lines | Where-Object { $_ -like 'painted*' }).Count
    $t0 = [System.Diagnostics.Stopwatch]::GetTimestamp()
    [void][Keys]::Chord($mods, $key)
    $line = $null
    for ($w = 0; $w -lt 400 -and -not $line; $w++) {
        $p = @(Lines | Where-Object { $_ -like 'painted*' })
        if ($p.Count -gt $before) { $line = $p[-1] } else { Start-Sleep -Milliseconds 5 }
    }
    if (-not $line) { $missed++; continue }
    if ($line -match 'painted qpc=(-?\d+) hotkey_qpc=(-?\d+)') {
        $external += [math]::Round(([int64]$Matches[1] - $t0) * 1000.0 / $freq, 2)
        $inproc += [math]::Round(([int64]$Matches[1] - [int64]$Matches[2]) * 1000.0 / $freq, 2)
    }
    if ($n -eq 1) { [Keys]::Shot((Join-Path $Out "$Name.png")) }
    $hb = @(Lines | Where-Object { $_ -like 'hidden*' }).Count
    [void][Keys]::Chord($mods, $key)
    for ($w = 0; $w -lt 400 -and @(Lines | Where-Object { $_ -like 'hidden*' }).Count -le $hb; $w++) { Start-Sleep -Milliseconds 5 }
    Start-Sleep -Milliseconds 150
}
$memAfter = Mem $proc.Id
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Tree $proc.Id | Stop-Process -Force -ErrorAction SilentlyContinue

$r = [ordered]@{
    name = $Name; hotkey = $hotkey; opens = $Opens; missed = $missed; cold_start_ms = $coldMs
    key_to_paint_ms = [ordered]@{ median = (Pct $external 0.5); p95 = (Pct $external 0.95); max = (Pct $external 1.0); first = $external[0] }
    hotkey_msg_to_paint_ms = [ordered]@{ median = (Pct $inproc 0.5); p95 = (Pct $inproc 0.95); max = (Pct $inproc 1.0) }
    idle_cpu_percent_of_one_core = $idleCpu; idle_seconds = $IdleSeconds
    memory_idle = $memIdle; memory_after_opens = $memAfter
    samples_ms = $external
}
$r | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $Out "$Name.json")
$r | ConvertTo-Json -Depth 4 | Write-Host
if ($missed -gt 0) { throw "$Name missed $missed of $Opens opens" }
