param(
    [switch]$Native,
    [switch]$DryRun,
    [switch]$PurgeData,
    [switch]$RemoveDeps
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$arguments = @("uninstall")
if ($DryRun) { $arguments += "--dry-run" }
if ($PurgeData) { $arguments += "--purge-data" }
if ($RemoveDeps) { $arguments += "--remove-deps" }
if ($Native) {
    & node (Join-Path $root "scripts/hydro-local.mjs") @arguments
} else {
    $linuxRoot = (& wsl --exec wslpath -a $root).Trim()
    if ($LASTEXITCODE -ne 0) { throw "需要启用 Docker Desktop WSL 集成；或使用 -Native 运行原生安装。" }
    & wsl --cd $linuxRoot --exec sh ./scripts/setdraft-compose.sh @arguments
}
exit $LASTEXITCODE
