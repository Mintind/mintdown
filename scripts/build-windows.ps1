param(
    [switch]$Verification,
    [string]$Version,
    [switch]$Offline
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (Test-Path -LiteralPath (Join-Path $cargoBin 'cargo.exe')) { $env:Path = $cargoBin + [IO.Path]::PathSeparator + $env:Path }
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'Install Rust stable MSVC and Visual Studio C++ Build Tools first.' }
if ($Version -and -not $Verification) { throw 'Version overrides are allowed only for isolated upgrade verification.' }
if ($Version -and $Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Version must be x.y.z.' }
if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = Join-Path $project 'src-tauri\target\d2' }
if (-not $env:CARGO_BUILD_JOBS) { $env:CARGO_BUILD_JOBS = '2' }
Push-Location -LiteralPath $project
$oldTest = $env:VITE_NATIVE_TEST
$oldProxy = $env:HTTPS_PROXY
try {
    if (-not $env:HTTPS_PROXY) {
        $uri = [uri]'https://github.com'
        $proxy = [Net.WebRequest]::DefaultWebProxy
        if ($proxy -and -not $proxy.IsBypassed($uri)) {
            $address = $proxy.GetProxy($uri)
            $env:HTTPS_PROXY = $address.GetComponents([UriComponents]::SchemeAndServer, [UriFormat]::UriEscaped)
            Write-Output 'Using the existing Windows proxy for build-tool downloads.'
        }
    }
    $config = Get-Content -Raw -LiteralPath 'src-tauri/tauri.conf.json' | ConvertFrom-Json
    $arguments = @('exec', '--', 'tauri', 'build', '--ci', '--bundles', 'nsis', '--no-sign')
    if ($Verification) {
        $env:VITE_NATIVE_TEST = '1'
        $arguments += @('--features', 'native-test', '--config', 'src-tauri/tauri.installer-test.conf.json')
        if ($Version) {
            $overrideFolder = Join-Path $project 'tests\.layout-evidence\d2\config'
            New-Item -ItemType Directory -Force -Path $overrideFolder | Out-Null
            $override = Join-Path $overrideFolder "version-$Version.json"
            [IO.File]::WriteAllText($override, (@{ version = $Version } | ConvertTo-Json))
            $arguments += @('--config', $override)
        }
    } else { Remove-Item Env:VITE_NATIVE_TEST -ErrorAction SilentlyContinue }
    if ($Offline) { $arguments += @('--', '--offline') }
    & npm.cmd @arguments
    if ($LASTEXITCODE -ne 0) { throw "Windows installer build failed: $LASTEXITCODE" }
    $releaseVersion = if ($Version) { $Version } else { $config.version }
    $destination = if ($Verification) { Join-Path $project "tests\.layout-evidence\d2\installers\$releaseVersion" }
        else { Join-Path $project "artifacts\windows\$releaseVersion" }
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    $installer = Get-ChildItem -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release\bundle\nsis') -Filter "*_${releaseVersion}_x64-setup.exe" |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $installer) { throw 'The expected x64 NSIS installer was not generated.' }
    $targetInstaller = Join-Path $destination $installer.Name
    Copy-Item -LiteralPath $installer.FullName -Destination $targetInstaller
    $binary = Join-Path $env:CARGO_TARGET_DIR 'release\Mintdown.exe'
    if (-not (Test-Path -LiteralPath $binary)) { throw 'Mintdown.exe was not generated.' }
    Copy-Item -LiteralPath $binary -Destination (Join-Path $destination 'Mintdown.exe')
    $buildInfo = Get-Content -Raw -LiteralPath (Join-Path $project 'dist/build-info.json') | ConvertFrom-Json
    Copy-Item -LiteralPath (Join-Path $project 'dist/build-info.json') -Destination (Join-Path $destination 'build-info.json')
    $manifest = [ordered]@{ version = $releaseVersion; verification = [bool]$Verification; architecture = 'x64';
        identifier = if ($Verification) { 'com.markdowneditor.kit.installertest' } else { $config.identifier };
        buildSource = $buildInfo;
        files = @(Get-ChildItem -LiteralPath $destination -Filter '*.exe' | ForEach-Object {
            [ordered]@{ name = $_.Name; bytes = $_.Length; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant() }
        }) }
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $destination 'SHA256.json')
    Write-Output "Windows artifacts: $destination"
} finally {
    if ($null -eq $oldTest) { Remove-Item Env:VITE_NATIVE_TEST -ErrorAction SilentlyContinue } else { $env:VITE_NATIVE_TEST = $oldTest }
    if ($null -eq $oldProxy) { Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue } else { $env:HTTPS_PROXY = $oldProxy }
    Pop-Location
}
