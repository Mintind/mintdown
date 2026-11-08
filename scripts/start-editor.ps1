$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (Test-Path -LiteralPath (Join-Path $cargoBin 'cargo.exe')) {
    $env:Path = $cargoBin + [IO.Path]::PathSeparator + $env:Path
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw 'Cargo not found. Install the Rust stable MSVC toolchain first.'
}
if (-not (Test-Path -LiteralPath (Join-Path $project 'node_modules\.bin\tauri.cmd'))) {
    throw 'Frontend dependencies are missing. Run npm.cmd ci in the project directory first.'
}

Push-Location -LiteralPath $project
try {
    & npm.cmd run tauri:dev
    if ($LASTEXITCODE -ne 0) { throw "Editor startup failed with exit code $LASTEXITCODE" }
}
finally {
    Pop-Location
}
