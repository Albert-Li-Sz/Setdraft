param(
    [switch]$DryRun,
    [ValidateSet("production", "dev")][string]$Mode,
    [string]$Domain,
    [switch]$Https,
    [switch]$Http,
    [string]$SslCert,
    [string]$SslKey,
    [ValidateSet("off", "external", "caddy")][string]$ProxyMode,
    [ValidateSet("cn", "global")][string]$Network,
    [string]$Registry,
    [string]$DockerRegistry,
    [string]$DownloadProxy,
    [string]$CaddyArchive
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$arguments = @("upgrade")
if ($DryRun) { $arguments += "--dry-run" }
if ($Mode) { $arguments += @("--mode", $Mode) }
if ($Https) { $arguments += "--https" }
if ($Http) { $arguments += "--http" }
foreach ($entry in @{
    "--domain" = $Domain; "--ssl-cert" = $SslCert; "--ssl-key" = $SslKey; "--proxy-mode" = $ProxyMode;
    "--network" = $Network; "--registry" = $Registry; "--docker-registry" = $DockerRegistry;
    "--download-proxy" = $DownloadProxy; "--caddy-archive" = $CaddyArchive
}.GetEnumerator()) {
    if ($entry.Value) { $arguments += @($entry.Key, $entry.Value) }
}
& node (Join-Path $root "scripts/hydro-local.mjs") @arguments
exit $LASTEXITCODE
