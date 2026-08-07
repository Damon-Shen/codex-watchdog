$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $projectRoot "src\launcher.mjs"

& node $launcher @args
exit $LASTEXITCODE
