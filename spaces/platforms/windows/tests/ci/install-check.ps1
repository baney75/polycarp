# The one-step install, end to end on a clean Windows runner (study item 1, gap F2).
#
#   install-check.ps1 -Msi <path> -Manifest <winget dir>
#
# Installs with `winget install --manifest` when winget is on the machine, else with `msiexec /i /qn` (it prints
# which). Within 10 s of the installer returning: the daemon runs, the sign-in entry (HKCU Run) names an exe that
# exists, and `polycarp --version` exits 0 from the user PATH the installer wrote. A Notepad window sent to workspace 2
# is cloaked. Then uninstall: within 10 s no Polycarp process is left, the sign-in entry and the PATH entry are gone,
# and the Notepad window is shown again (the uninstall put it back before removing the daemon).
param([Parameter(Mandatory)][string]$Msi, [Parameter(Mandatory)][string]$Manifest)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\win.ps1"
$Msi = (Resolve-Path $Msi).Path
$Manifest = (Resolve-Path $Manifest).Path
$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$folder = Join-Path $env:LOCALAPPDATA 'Programs\Polycarp'

function Daemons { @(Get-CimInstance Win32_Process -Filter "Name = 'baneyspaces.exe'" | Where-Object { $_.CommandLine -match ' daemon' -and $_.CommandLine -notmatch '--background' }) }
function Ours { @(Get-Process baneyspaces, baneyspacesw, polycarp -ErrorAction SilentlyContinue) }
function RunValue { (Get-ItemProperty $run -Name Polycarp -ErrorAction SilentlyContinue).Polycarp }
function UserPath { [Environment]::GetEnvironmentVariable('Path', 'User') }

Check 'clean runner: no Polycarp process, no sign-in entry' ((Ours).Count -eq 0 -and -not (RunValue)) "processes $((Ours).Count)"

$winget = Get-Command winget -ErrorAction SilentlyContinue
if ($winget) {
    "installer: winget $(& winget --version) with the local manifest $Manifest"
    & winget settings --enable LocalManifestFiles | Out-Host
    & winget validate --manifest $Manifest | Out-Host
    Check 'winget validate' ($LASTEXITCODE -eq 0) "exit $LASTEXITCODE"
    & winget install --manifest $Manifest --silent --accept-package-agreements --disable-interactivity | Out-Host
    $code = $LASTEXITCODE
} else {
    "installer: msiexec /i /qn (winget is not on this runner)"
    $p = Start-Process msiexec -ArgumentList @('/i', "`"$Msi`"", '/qn', '/l*v', "`"$env:RUNNER_TEMP\install.log`"") -Wait -PassThru
    $code = $p.ExitCode
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

# A window on another workspace, so the uninstall has something to put back.
$np = Start-Process notepad -PassThru
$null = Wait-Until { $np.Refresh(); $np.MainWindowHandle -ne 0 } 5000
$h = [long]$np.MainWindowHandle
& (Join-Path $folder 'baneyspaces.exe') move 2 --stay --window (WinId $h) | Out-Host
$ms = Wait-Until { ([PcWin]::Cloaked($h) -band 2) -ne 0 } 3000
Check 'a window sent to workspace 2 is cloaked' ($ms -ge 0) "cloaked=$([PcWin]::Cloaked($h))"

if ($winget) {
    & winget uninstall --manifest $Manifest --silent --disable-interactivity | Out-Host
    $code = $LASTEXITCODE
} else {
    $p = Start-Process msiexec -ArgumentList @('/x', "`"$Msi`"", '/qn', '/l*v', "`"$env:RUNNER_TEMP\uninstall.log`"") -Wait -PassThru
    $code = $p.ExitCode
}
Check 'uninstaller exit code' ($code -eq 0) "exit $code"
$ms = Wait-Until { (Ours).Count -eq 0 } 10000
Check 'no Polycarp process within 10 s of the uninstall' ($ms -ge 0) "$ms ms; left: $((Ours | ForEach-Object { "$($_.Name) $($_.Id)" }) -join ', ')"
Check 'the sign-in entry is gone' (-not (RunValue)) "Run\Polycarp = '$(RunValue)'"
Check 'the PATH entry is gone' (-not ((UserPath) -split ';' | Where-Object { $_.TrimEnd('\') -eq $folder })) "$(UserPath)"
Check 'the installed files are gone' (-not (Test-Path (Join-Path $folder 'baneyspaces.exe'))) "$folder"
Check 'the window on workspace 2 is shown again' ([PcWin]::Cloaked($h) -eq 0 -and [PcWin]::OnAMonitor($h)) "cloaked=$([PcWin]::Cloaked($h)) rect=$([PcWin]::Rect($h) -join ',')"
Stop-Process -Id $np.Id -Force -ErrorAction SilentlyContinue

if ($script:failures -gt 0) { "install-check: $script:failures check(s) failed"; exit 1 }
"install-check: pass"
exit 0
