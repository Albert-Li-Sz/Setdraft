param(
    [switch]$DryRun,
    [switch]$PurgeData,
    [switch]$RemoveDeps
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$arguments = @("uninstall")
if ($DryRun) { $arguments += "--dry-run" }
if ($PurgeData) { $arguments += "--purge-data" }
if ($RemoveDeps) { $arguments += "--remove-deps" }
& node (Join-Path $root "scripts/hydro-local.mjs") @arguments
exit $LASTEXITCODE
