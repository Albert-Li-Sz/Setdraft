param(
    [switch]$Native,
    [switch]$DryRun,
    [ValidateSet("production", "dev")][string]$Mode,
    [ValidateSet("0.0.0.0", "127.0.0.1")][string]$ListenAddress,
    [string]$PublicOrigin,
    [ValidateSet("cn", "global")][string]$Network,
    [string]$Registry,
    [string]$DockerRegistry,
    [string]$DownloadProxy
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$arguments = @("upgrade")
if ($DryRun) { $arguments += "--dry-run" }
if ($Mode) { $arguments += @("--mode", $Mode) }
foreach ($entry in @{
    "--host" = $ListenAddress; "--public-origin" = $PublicOrigin;
    "--network" = $Network; "--registry" = $Registry; "--docker-registry" = $DockerRegistry;
    "--download-proxy" = $DownloadProxy
}.GetEnumerator()) {
    if ($entry.Value) { $arguments += @($entry.Key, $entry.Value) }
}
if ($Native) {
    & node (Join-Path $root "scripts/hydro-local.mjs") @arguments
} else {
    $linuxRoot = (& wsl --exec wslpath -a $root).Trim()
    if ($LASTEXITCODE -ne 0) { throw "需要启用 Docker Desktop WSL 集成；或使用 -Native 运行原生安装。" }
    & wsl --cd $linuxRoot --exec sh ./scripts/setdraft-compose.sh @arguments
}
exit $LASTEXITCODE
