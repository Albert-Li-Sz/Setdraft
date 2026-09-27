param(
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
$arguments = @("install")
if ($DryRun) { $arguments += "--dry-run" }
if ($Mode) { $arguments += @("--mode", $Mode) }
foreach ($entry in @{
    "--host" = $ListenAddress; "--public-origin" = $PublicOrigin;
    "--network" = $Network; "--registry" = $Registry; "--docker-registry" = $DockerRegistry;
    "--download-proxy" = $DownloadProxy
}.GetEnumerator()) {
    if ($entry.Value) { $arguments += @($entry.Key, $entry.Value) }
}
& node (Join-Path $root "scripts/hydro-local.mjs") @arguments
exit $LASTEXITCODE
