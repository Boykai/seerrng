$ErrorActionPreference = 'Stop'

$serviceName = 'SeerrNG'
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($null -ne $service) {
  $nssm = Get-Command 'nssm.exe' -ErrorAction Stop
  & $nssm.Definition get $serviceName Application > $null 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "A service named $serviceName exists but is not managed by NSSM. It was left unchanged."
  }

  if ($service.Status -ne 'Stopped') {
    Stop-Service -Name $serviceName -Force
    $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
  }
}
