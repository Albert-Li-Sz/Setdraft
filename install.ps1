param(
    [switch]$DryRun,
    [ValidateSet("production", "dev")][string]$Mode
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$arguments = @("install")
if ($DryRun) { $arguments += "--dry-run" }
if ($Mode) { $arguments += @("--mode", $Mode) }
& node (Join-Path $root "scripts/hydro-local.mjs") @arguments
exit $LASTEXITCODE
