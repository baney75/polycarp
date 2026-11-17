# Polycarp and the Windows shell side by side on a windows-latest runner's own desktop (study item 10).
#
#   shell-check.ps1 -Bin <dir with baneyspaces.exe and bs-testapp.exe> -Out <evidence dir> [-Switches 50]
#
# Six test windows, two each on workspaces 1, 2 and 3. Then:
# 1. Control for the desktop read: Win+Ctrl+D opens a second virtual desktop, and Windows must say a test window is
#    not on the current one (so the read can fail). Win+Ctrl+F4 closes it; every window must be back on the current
#    desktop and on its workspace.
# 2. -Switches workspace switches. Within 2 s of each: every window `baneyspaces state` puts on a workspace is on the
#    current virtual desktop (IVirtualDesktopManager.IsWindowOnCurrentVirtualDesktop), so hiding never moves a window
#    to another desktop; and each test window reads as shell-cloaked (DWMWA_CLOAKED 2) and is listed hidden in
#    `state` exactly when its workspace is not shown.
# 3. No Polycarp module loaded in explorer.exe. Control: the same matcher finds baneyspaces.exe in the daemon.
# Every read is Win32 or COM from this script, or `baneyspaces state`. Exits 1 on any failure.
param(
    [Parameter(Mandatory)][string]$Bin,
    [Parameter(Mandatory)][string]$Out,
    [int]$Switches = 50
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\win.ps1"
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
// The documented IVirtualDesktopManager (shobjidl_core.h).
[ComImport, Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVirtualDesktopManager {
  [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr h, out int on);
  [PreserveSig] int GetWindowDesktopId(IntPtr h, out Guid id);
}
public static class Vdm {
  static IVirtualDesktopManager m;
  public static int Hr;
  // 1 on the current virtual desktop, 0 not, -1 Windows could not say (the HRESULT is left in Hr).
  public static int On(long h) {
    if (m == null) m = (IVirtualDesktopManager)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A")));
    int on; Hr = m.IsWindowOnCurrentVirtualDesktop((IntPtr)h, out on);
    return Hr < 0 ? -1 : (on != 0 ? 1 : 0);
  }
  public static string Desktop(long h) { Guid g; On(h); return m.GetWindowDesktopId((IntPtr)h, out g) < 0 ? "?" : g.ToString(); }
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  // Presses the keys in order and lets them go in reverse.
  public static void Chord(params byte[] vks) {
    foreach (var k in vks) keybd_event(k, 0, 0, UIntPtr.Zero);
    for (int i = vks.Length - 1; i >= 0; i--) keybd_event(vks[i], 0, 2, UIntPtr.Zero);
  }
}
'@

New-Item -ItemType Directory -Force $Out | Out-Null
$bs = Join-Path $Bin 'baneyspaces.exe'
$testapp = Join-Path $Bin 'bs-testapp.exe'
$state = if ($env:BANEYSPACES_STATE_DIR) { $env:BANEYSPACES_STATE_DIR } else { Join-Path $env:LOCALAPPDATA 'BaneySpaces' }
$dlog = Join-Path $Out 'daemon.log'
$polycarpModule = 'baneyspaces|polycarp'

function Spaces { $o = (& $bs @args 2>&1 | Out-String).Trim(); try { $o | ConvertFrom-Json } catch { $null } }
function Up { $d = Spaces doctor; ($d.data.checks | Where-Object check -eq 'daemon').ok -eq $true }
function ShownWorkspaces($st) { @($st.data.monitors.PSObject.Properties | ForEach-Object { "$($_.Value.current)" }) }
function OnAll { @($hs | Where-Object { [Vdm]::On($_) -ne 1 }).Count -eq 0 }
# '' when Polycarp and the shell agree; otherwise what does not.
function Coexist {
    $st = Spaces state
    if (-not $st.ok) { return "state: $($st.error.message)" }
    $shown = ShownWorkspaces $st
    $hidden = @($st.data.hidden | ForEach-Object { [long]$_.hwnd })
    $bad = @()
    foreach ($p in $st.data.windows.PSObject.Properties) {
        $at = "$($p.Value.home)"
        if ($at -notmatch '^[1-9]$') { continue }
        $h = [long]($p.Name -replace '^w-', '')
        $on = [Vdm]::On($h)
        if ($on -ne 1) { $bad += ('{0} ({1}, workspace {2}) on the current desktop: {3} (hr 0x{4:X8})' -f $p.Name, $p.Value.app, $at, $on, [Vdm]::Hr) }
    }
    for ($i = 0; $i -lt $hs.Count; $i++) {
        $h = $hs[$i]; $n = "$($ws[$i])"; $at = "$($st.data.windows.(WinId $h).home)"
        $wantHidden = -not ($shown -contains $n)
        $cloak = [PcWin]::Cloaked($h)
        $listed = $hidden -contains $h
        $cloakOk = if ($wantHidden) { $cloak -eq 2 } else { $cloak -eq 0 }
        if ($at -ne $n -or -not $cloakOk -or $listed -ne $wantHidden) {
            $bad += "$(WinId $h) home=$at (want $n) cloak=$cloak listed-hidden=$listed (want hidden=$wantHidden)"
        }
    }
    if ($bad.Count) { return "workspace(s) shown: $($shown -join ','); " + ($bad -join '; ') }
    ''
}
function WaitCoexist([int]$ms) {
    $sw = [Diagnostics.Stopwatch]::StartNew(); $why = 'not checked'
    while ($sw.ElapsedMilliseconds -le $ms) { $why = Coexist; if (-not $why) { return @([int]$sw.ElapsedMilliseconds, '') }; Start-Sleep -Milliseconds 50 }
    @(-1, $why)
}
function Modules([int]$procId) {
    try { @((Get-Process -Id $procId).Modules | ForEach-Object { $_.FileName }) } catch { @("<could not read: $_>") }
}

$times = @()
try {
    "== clean start"
    Get-Process baneyspaces, bs-testapp -ErrorAction SilentlyContinue | Stop-Process -Force
    Remove-Item (Join-Path $state 'state.json') -ErrorAction SilentlyContinue
    $null = Spaces daemon --background --log $dlog
    Check 'the daemon starts' (Up) ''

    $ws = @(1, 1, 2, 2, 3, 3); $hs = @()
    foreach ($n in $ws) {
        $p = Start-Process $testapp -PassThru
        $null = Wait-Until { $p.Refresh(); $p.MainWindowHandle -ne 0 } 5000
        $hs += [long]$p.MainWindowHandle
    }
    $null = Wait-Until { $st = Spaces state; @($hs | Where-Object { $st.data.windows.(WinId $_) }).Count -eq $hs.Count } 5000
    for ($i = 0; $i -lt $hs.Count; $i++) { if ($ws[$i] -ne 1) { $null = Spaces move $ws[$i] --stay --window (WinId $hs[$i]) } }
    $null = Spaces switch 1
    $r = WaitCoexist 3000
    Check 'six test windows, two on each of workspaces 1, 2 and 3, all on the current desktop' ($r[0] -ge 0) "$($hs -join ' ') $($r[1])"
    if ($script:failures) { throw 'setup failed' }

    "== control: a second virtual desktop"
    $first = [Vdm]::Desktop($hs[0])
    [Vdm]::Chord([byte[]](0x5B, 0x11, 0x44))   # Win+Ctrl+D: a new desktop, and Windows moves to it
    $ms = Wait-Until { [Vdm]::On($hs[0]) -eq 0 } 3000
    Check 'control: on a new desktop, Windows says a test window is not on the current one' ($ms -ge 0) "$ms ms; its desktop $first; read $([Vdm]::On($hs[0])) hr 0x$('{0:X8}' -f [Vdm]::Hr)"
    if ($ms -ge 0) {
        [Vdm]::Chord([byte[]](0x5B, 0x11, 0x73))   # Win+Ctrl+F4: close it, back to the first
        $ms = Wait-Until { OnAll } 3000
        Check 'control: the new desktop closed, every test window is on the current one again' ($ms -ge 0) "$ms ms"
        $r = WaitCoexist 3000
        Check 'control: and every window is on its workspace, shown or hidden to match' ($r[0] -ge 0) "$($r[0]) ms $($r[1])"
    }

    "== $Switches switches"
    if (-not $script:failures) {
        $to = 1
        for ($s = 1; $s -le $Switches; $s++) {
            $to = @(1, 2, 3 | Where-Object { $_ -ne $to })[(Get-Random -Maximum 2)]
            $null = Spaces switch $to
            $r = WaitCoexist 2000
            $times += $r[0]
            if ($r[0] -lt 0) { Check "switch $s to ${to}: Polycarp and the shell agree within 2 s" $false $r[1]; break }
        }
        if (-not $script:failures) {
            $sorted = @($times | Sort-Object)
            Check "$Switches switches: every time, every window on the current desktop, test windows cloaked exactly when off the shown workspace" $true "ms to agree: median $($sorted[[int]($sorted.Count / 2)]), max $($sorted[-1])"
        }
    }

    "== explorer.exe modules"
    $daemon = @(Get-CimInstance Win32_Process -Filter "Name = 'baneyspaces.exe'" | Where-Object { $_.CommandLine -match ' daemon' -and $_.CommandLine -notmatch '--background' })[0]
    $own = @(Modules $daemon.ProcessId | Where-Object { $_ -match $polycarpModule })
    Check 'control: the matcher finds baneyspaces.exe in the daemon' (@($own | Where-Object { $_ -match 'baneyspaces\.exe$' }).Count -ge 1) "$($own -join ', ')"
    $explorers = @(Get-Process explorer -ErrorAction SilentlyContinue)
    $loaded = @($explorers | ForEach-Object { Modules $_.Id })
    $hits = @($loaded | Where-Object { $_ -match $polycarpModule -or $_ -match '^<could not read' })
    Check 'explorer.exe loads no Polycarp module' ($explorers.Count -ge 1 -and $hits.Count -eq 0) "$($explorers.Count) explorer process(es), $($loaded.Count) modules; matched: $($hits -join ', ')"
    $loaded | Set-Content (Join-Path $Out 'explorer-modules.txt')
} catch {
    Check 'the check ran to the end' $false "$_"
} finally {
    $times -join "`n" | Set-Content (Join-Path $Out 'switch-ms.txt')
    Copy-Item (Join-Path $state 'state.json') $Out -ErrorAction SilentlyContinue
    $null = & $bs stop 2>&1
    Get-Process bs-testapp -ErrorAction SilentlyContinue | Stop-Process -Force
}
if ($script:failures -gt 0) { "shell-check: $script:failures check(s) failed"; exit 1 }
"shell-check: pass"
exit 0
