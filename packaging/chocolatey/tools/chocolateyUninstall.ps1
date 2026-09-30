$ErrorActionPreference = 'Stop'

$serviceName = 'SeerrNG'
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($null -ne $service) {
  $nssm = Get-Command 'nssm.exe' -ErrorAction SilentlyContinue
  if ($null -eq $nssm) {
    throw 'NSSM is required to remove the SeerrNG Windows service. Reinstall the nssm Chocolatey dependency and retry.'
  }

  & $nssm.Definition get $serviceName Application > $null 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "The $serviceName service is not managed by NSSM. It was left unchanged."
  }

  if ($service.Status -ne 'Stopped') {
    Stop-Service -Name $serviceName -Force
    $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
  }

  & $nssm.Definition remove $serviceName confirm
  if ($LASTEXITCODE -ne 0) {
    throw "NSSM could not remove the $serviceName service (exit code $LASTEXITCODE)."
  }
}

$applicationRoot = Join-Path $env:ProgramData 'SeerrNG\applications'
if (Test-Path -LiteralPath $applicationRoot) {
  Get-ChildItem -LiteralPath $applicationRoot -Force |
    ForEach-Object {
      if (($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to remove an unexpected reparse point from the SeerrNG application directory: $($_.FullName)"
      }
      Remove-Item -LiteralPath $_.FullName -Recurse -Force
    }
}

Write-Host 'The SeerrNG service and application files were removed. Configuration under %ProgramData%\SeerrNG\config was preserved.'
