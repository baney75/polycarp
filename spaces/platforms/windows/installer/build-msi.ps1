# Builds the Polycarp MSI for Windows (x64) and a winget manifest for it.
#
#   build-msi.ps1 [-Out DIR] [-UrlBase URL] [-NoBuild]
#
# Needs Rust (MSVC) and WiX 5.0.2: `dotnet tool install --global wix --version 5.0.2`. WiX 6 and later ask the
# builder to accept an end-user license tied to a paid maintenance fee, so the version is pinned below 6.
#
# Writes DIR\Polycarp-<version>-x64.msi and DIR\winget\ (the three manifest files from winget\, with the MSI's real
# SHA-256 and ProductCode and, when -UrlBase is given, InstallerUrl set to UrlBase/<msi file name>). The version is baneyspaces-windows' Cargo.toml version; the
# manifests in winget\ must carry the same one.
#
# Unsigned. Signing costs money, so there is a hook and no certificate: when POLYCARP_SIGN is set to a script path,
# that script is called with each file to sign (the three .exe files, then the .msi) and must sign it in place and
# exit 0. Nothing in CI sets it.
param(
    [string]$Out = '',
    [string]$UrlBase = '',
    [switch]$NoBuild
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$spaces = (Resolve-Path "$here\..\..\..").Path
$repo = (Resolve-Path "$spaces\..").Path
if (-not $Out) { $Out = Join-Path $repo 'dist\windows' }
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path $Out).Path

function Run($exe, [string[]]$a) {
    & $exe @a
    if ($LASTEXITCODE -ne 0) { throw "$exe $($a -join ' ') exited $LASTEXITCODE" }
}

$toml = Get-Content "$spaces\platforms\windows\baneyspaces\Cargo.toml" -Raw
if ($toml -notmatch '(?m)^version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"') { throw 'no version in baneyspaces-windows Cargo.toml' }
$version = $Matches[1]
foreach ($f in Get-ChildItem "$here\winget\*.yaml") {
    if ((Get-Content $f.FullName -Raw) -notmatch "(?m)^PackageVersion: $([regex]::Escape($version))\r?$") {
        throw "$($f.Name) does not say PackageVersion: $version (the crate's version)"
    }
}

if (-not $NoBuild) {
    Push-Location $spaces; try { Run cargo @('build', '--release', '--locked', '-p', 'baneyspaces-windows') } finally { Pop-Location }
    Push-Location "$repo\cli"; try { Run cargo @('build', '--release', '--locked') } finally { Pop-Location }
}
$bin = Join-Path $Out 'bin'
New-Item -ItemType Directory -Force $bin | Out-Null
Copy-Item "$spaces\target\release\baneyspaces.exe", "$spaces\target\release\baneyspacesw.exe" $bin -Force
Copy-Item "$repo\cli\target\release\polycarp.exe" $bin -Force

$sign = $env:POLYCARP_SIGN
function Sign($path) { if ($sign) { Run $sign @($path) } }
Get-ChildItem "$bin\*.exe" | ForEach-Object { Sign $_.FullName }

$msi = Join-Path $Out "Polycarp-$version-x64.msi"
# A new ProductCode for every build, chosen here so the manifest can carry it: winget matches the installed package
# to the manifest by it.
$productCode = '{' + ([guid]::NewGuid().ToString().ToUpperInvariant()) + '}'
Run wix @('build', "$here\Polycarp.wxs", '-arch', 'x64', '-d', "Version=$version", '-d', "ProductCode=$productCode", '-d', "BinDir=$bin", '-d', "SourceDir=$spaces", '-o', $msi)
Sign $msi
$sha = (Get-FileHash $msi -Algorithm SHA256).Hash

$wg = Join-Path $Out 'winget'
New-Item -ItemType Directory -Force $wg | Out-Null
foreach ($f in Get-ChildItem "$here\winget\*.yaml") {
    $text = Get-Content $f.FullName -Raw
    $text = $text -replace '(?m)^(\s*InstallerSha256: )[0-9A-Fa-f]{64}', "`${1}$sha"
    $text = $text -replace "(?m)^(\s*ProductCode: ).*$", "`${1}'$productCode'"
    if ($UrlBase) { $text = $text -replace '(?m)^(\s*InstallerUrl: ).*$', "`${1}$($UrlBase.TrimEnd('/'))/$(Split-Path $msi -Leaf)" }
    # The template's note about the placeholder hash does not belong in a filled-in manifest.
    $text = ($text -split "`n" | Where-Object { $_ -notmatch '^# (build-msi|The all-zero|needs it)' }) -join "`n"
    Set-Content -Path (Join-Path $wg $f.Name) -Value $text -NoNewline -Encoding utf8NoBOM
}
"msi: $msi"
"sha256: $sha"
"product code: $productCode"
"winget manifest: $wg"
