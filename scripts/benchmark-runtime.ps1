param(
  [ValidateSet('idle','10-peers','100-peers','500-peers','sync','traffic-poll','bulk-qr','cleanup')]
  [string]$Scenario = 'idle',
  [ValidateRange(15,3600)][int]$DurationSeconds = 60,
  [ValidateRange(1,60)][int]$SampleSeconds = 5,
  [string[]]$Containers = @('wireguardpanel-app-1','wireguardpanel-worker-1','wireguardpanel-db-1'),
  [string]$DatabaseContainer = 'wireguardpanel-db-1',
  [string]$ApplicationImage = 'wireguardpanel-app:latest'
)

$ErrorActionPreference = 'Stop'
$Containers = @($Containers | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
$samples = [System.Collections.Generic.List[object]]::new()
$deadline = (Get-Date).AddSeconds($DurationSeconds)

while ((Get-Date) -lt $deadline) {
  $rows = docker stats --no-stream --format '{{json .}}' $Containers
  foreach ($row in $rows) {
    if (-not $row) { continue }
    $item = $row | ConvertFrom-Json
    $memory = if ($item.MemUsage -match '^([0-9.]+)(KiB|MiB|GiB)') {
      $amount = [double]$Matches[1]
      switch ($Matches[2]) { 'KiB' { $amount * 1KB } 'MiB' { $amount * 1MB } 'GiB' { $amount * 1GB } }
    } else { 0 }
    $samples.Add([pscustomobject]@{Time=(Get-Date).ToUniversalTime().ToString('o');Name=$item.Name;CpuPercent=[double]($item.CPUPerc -replace '%','');MemoryBytes=[long]$memory;BlockIO=$item.BlockIO;Pids=[int]$item.PIDs})
  }
  Start-Sleep -Seconds $SampleSeconds
}

$summary = $samples | Group-Object Name | ForEach-Object {
  [pscustomobject]@{
    Name=$_.Name
    AverageCpuPercent=[math]::Round(($_.Group | Measure-Object CpuPercent -Average).Average,2)
    PeakCpuPercent=[math]::Round(($_.Group | Measure-Object CpuPercent -Maximum).Maximum,2)
    AverageMemoryBytes=[long](($_.Group | Measure-Object MemoryBytes -Average).Average)
    PeakMemoryBytes=[long](($_.Group | Measure-Object MemoryBytes -Maximum).Maximum)
    LastBlockIO=$_.Group[-1].BlockIO
    PeakPids=[int](($_.Group | Measure-Object Pids -Maximum).Maximum)
  }
}

$image = docker image inspect $ApplicationImage --format '{{.Size}}'
$database = docker exec -i $DatabaseContainer psql -U wireguard_control -d wireguard_control -Atc "SELECT json_build_object('bytes',pg_database_size(current_database()),'peers',(SELECT count(*) FROM peers),'snapshots',(SELECT count(*) FROM traffic_snapshots),'auditRows',(SELECT count(*) FROM audit_logs));"
[pscustomobject]@{
  Scenario=$Scenario
  StartedAt=if ($samples.Count) { $samples[0].Time } else { $null }
  DurationSeconds=$DurationSeconds
  Containers=$summary
  ImageBytes=[long]$image
  Database=($database | ConvertFrom-Json)
} | ConvertTo-Json -Depth 6
