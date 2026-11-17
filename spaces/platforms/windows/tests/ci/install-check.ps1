# The one-step install, end to end on a clean Windows runner (study item 1, gap F2).
#
#   install-check.ps1 -Msi <path> -Manifest <winget dir>
#
#   install-check.ps1 -Msi <path> -Manifest <winget dir> -Msi2 <path> -Manifest2 <winget dir> [-RequireWinget]
#
# Installs with `winget install --manifest` when winget is on the machine, else with `msiexec /i /qn` (it prints
# which; -RequireWinget, as CI passes, fails instead). Within 10 s of the installer returning: the daemon runs, the
# sign-in entry (HKCU Run) names an exe that exists, and `polycarp --version` exits 0 from the user PATH the installer
# wrote. A Notepad window sent to workspace 2 is cloaked. -Msi2 is a second build of the same version: installed over
# the first it exits 0 (not 3010), leaves one registered product and one daemon, and the window is shown again.
# Then the window is cloaked again, the daemon is ended with taskkill /F, and Polycarp is uninstalled: within 10 s no
# Polycarp process is left, the sign-in entry and the PATH entry are gone, and the window still exists, is not
# cloaked and is on a monitor (the uninstall's `restore` put it back with no daemon running).
param([Parameter(Mandatory)][string]$Msi, [Parameter(Mandatory)][string]$Manifest,
      [Parameter(Mandatory)][string]$Msi2, [Parameter(Mandatory)][string]$Manifest2, [switch]$RequireWinget)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\win.ps1"
$Msi = (Resolve-Path $Msi).Path
$Manifest = (Resolve-Path $Manifest).Path
$Manifest2 = (Resolve-Path $Manifest2).Path
$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$folder = Join-Path $env:LOCALAPPDATA 'Programs\Polycarp'

function Daemons { @(Get-CimInstance Win32_Process -Filter "Name = 'baneyspaces.exe'" | Where-Object { $_.CommandLine -match ' daemon' -and $_.CommandLine -notmatch '--background' }) }
function Ours { @(Get-Process baneyspaces, baneyspacesw, polycarp -ErrorAction SilentlyContinue) }
function RunValue { (Get-ItemProperty $run -Name Polycarp -ErrorAction SilentlyContinue).Polycarp }
function UserPath { [Environment]::GetEnvironmentVariable('Path', 'User') }
# The ProductCodes Windows Installer has registered under Polycarp.wxs's UpgradeCode.
function Products {
    # Enumerated by the pipeline: the StringList's Count reads back as one count per item once it holds two.
    @((New-Object -ComObject WindowsInstaller.Installer).RelatedProducts('{EF27631F-61D9-4BC6-BAC2-896014A8ED96}') | ForEach-Object { "$_" })
}
function Msiexec([string[]]$a, [string]$log) { (Start-Process msiexec -ArgumentList ($a + @('/qn', '/l*v', "`"$env:RUNNER_TEMP\$log`"")) -Wait -PassThru).ExitCode }
function Cloak([long]$h) {
    & (Join-Path $folder 'baneyspaces.exe') move 2 --stay --window (WinId $h) | Out-Host
    Wait-Until { ([PcWin]::Cloaked($h) -band 2) -ne 0 } 3000
}

Check 'clean runner: no Polycarp process, no sign-in entry' ((Ours).Count -eq 0 -and -not (RunValue)) "processes $((Ours).Count)"

$winget = Get-Command winget -ErrorAction SilentlyContinue
Check 'winget is on the runner, or not required' ($winget -or -not $RequireWinget) "winget: $([bool]$winget)"
if ($winget) {
    "installer: winget $(& winget --version) with the local manifest $Manifest"
    & winget settings --enable LocalManifestFiles | Out-Host
    & winget validate --manifest $Manifest | Out-Host
    Check 'winget validate' ($LASTEXITCODE -eq 0) "exit $LASTEXITCODE"
    & winget install --manifest $Manifest --silent --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Host
    $code = $LASTEXITCODE
} else {
    "installer: msiexec /i /qn (winget is not on this runner)"
    $code = Msiexec @('/i', "`"$Msi`"") install.log
}
Check 'installer exit code' ($code -eq 0) "exit $code"

$ms = Wait-Until { (Daemons).Count -eq 1 } 10000
Check 'daemon runs within 10 s' ($ms -ge 0) "$ms ms; $((Daemons).CommandLine)"
$entry = RunValue
$exe = if ($entry -match '^"([^"]+)"') { $Matches[1] } else { '' }
Check 'sign-in entry (HKCU Run) names an installed exe' ($exe -and (Test-Path $exe) -and $entry -match 'daemon --background') "$entry"
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + (UserPath)
$pc = Get-Command polycarp -ErrorAction SilentlyContinue
$out = if ($pc) { & $pc.Source --version 2>&1 } else { 'polycarp not on PATH' }
Check 'polycarp --version exits 0 from the PATH the installer wrote' ($pc -and $LASTEXITCODE -eq 0 -and $pc.Source -like "$folder*") "$($pc.Source): $out"
$doctor = & (Join-Path $folder 'baneyspaces.exe') doctor | ConvertFrom-Json
$d = $doctor.data.checks | Where-Object check -eq 'daemon'
Check 'baneyspaces doctor reaches the daemon' ($d.ok) "$($d.detail)"

# A window on another workspace, so the same-version install has something to put back.
$np = Start-Process notepad -PassThru
$null = Wait-Until { $np.Refresh(); $np.MainWindowHandle -ne 0 } 5000
$h = [long]$np.MainWindowHandle
$ms = Cloak $h
Check 'a window sent to workspace 2 is cloaked' ($ms -ge 0) "$(Describe $h)"

$code = Msiexec @('/i', "`"$Msi2`"") same-version.log
Check 'a second build of the same version installs over the first (exit 0, not 3010)' ($code -eq 0) "exit $code"
$second = if ((Get-Content "$Manifest2\*.installer.yaml" -Raw) -match "ProductCode: '([^']+)'") { $Matches[1] } else { '?' }
Check 'one registered product, the second build' (((Products) -join ',') -eq $second) "registered: $((Products) -join ', '); second build: $second"
$ms = Wait-Until { (Daemons).Count -eq 1 } 10000
Check 'one daemon runs after it' ($ms -ge 0) "$((Daemons).Count) daemon(s)"
Check 'the cloaked window was shown again by the stop before it' ([PcWin]::Shown($h)) "$(Describe $h)"

# A daemon that dies with a window hidden: the uninstall must still show it.
$ms = Cloak $h
Check 'the window is cloaked again' ($ms -ge 0) "$(Describe $h)"
(Daemons) | ForEach-Object { & taskkill /F /PID $_.ProcessId | Out-Host }
$ms = Wait-Until { (Daemons).Count -eq 0 } 5000
Check 'taskkill /F ended the daemon and the window stays cloaked' ($ms -ge 0 -and ([PcWin]::Cloaked($h) -band 2) -ne 0) "$(Describe $h)"
if ($winget) {
    & winget uninstall --manifest $Manifest2 --silent --accept-source-agreements --disable-interactivity | Out-Host
    $code = $LASTEXITCODE
} else {
    $code = Msiexec @('/x', "`"$Msi2`"") uninstall.log
}
Check 'uninstaller exit code' ($code -eq 0) "exit $code"
$ms = Wait-Until { (Ours).Count -eq 0 } 10000
Check 'no Polycarp process within 10 s of the uninstall' ($ms -ge 0) "$ms ms; left: $((Ours | ForEach-Object { "$($_.Name) $($_.Id)" }) -join ', ')"
Check 'the sign-in entry is gone' (-not (RunValue)) "Run\Polycarp = '$(RunValue)'"
Check 'the PATH entry is gone' (-not ((UserPath) -split ';' | Where-Object { $_.TrimEnd('\') -eq $folder })) "$(UserPath)"
Check 'the installed files are gone' (-not (Test-Path (Join-Path $folder 'baneyspaces.exe'))) "$folder"
Check 'the window hidden when the daemon died exists, is not cloaked and is on a monitor' ([PcWin]::Shown($h)) "$(Describe $h)"
# Control: a destroyed window must fail that check, and reading it must throw rather than read as cloak 0.
Stop-Process -Id $np.Id -Force -ErrorAction SilentlyContinue
$null = Wait-Until { -not [PcWin]::Exists($h) } 5000
$threw = try { $null = [PcWin]::Cloaked($h); $false } catch { $true }
Check 'control: a destroyed window is not shown and reading its cloak throws' (-not [PcWin]::Shown($h) -and $threw) "threw=$threw"

if ($script:failures -gt 0) { "install-check: $script:failures check(s) failed"; exit 1 }
"install-check: pass"
exit 0
