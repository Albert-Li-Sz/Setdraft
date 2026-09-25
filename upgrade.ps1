param(
    [switch]$DryRun
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$arguments = @("upgrade")
if ($DryRun) { $arguments += "--dry-run" }
& node (Join-Path $root "scripts/hydro-local.mjs") @arguments
exit $LASTEXITCODE
