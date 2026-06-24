$ErrorActionPreference = "SilentlyContinue"

$project = Resolve-Path (Join-Path $PSScriptRoot "..")
$pidFile = Join-Path $project ".web.pid"

function Get-ChildProcessIds($parentId) {
  $children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $parentId }
  foreach ($child in $children) {
    $child.ProcessId
    Get-ChildProcessIds $child.ProcessId
  }
}

$ids = @()

if (Test-Path -LiteralPath $pidFile) {
  $rootId = [int](Get-Content -LiteralPath $pidFile)
  $ids += Get-ChildProcessIds $rootId
  $ids += $rootId
}

$projectPath = $project.Path.Replace("\", "\\")
$webProcesses = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -like "*makers-topic-agent*" -and $_.CommandLine -like "*web-server.mjs*"
}

foreach ($proc in $webProcesses) {
  $ids += $proc.ProcessId
  $ids += Get-ChildProcessIds $proc.ProcessId
}

$ids = $ids | Where-Object { $_ } | Select-Object -Unique

if ($ids.Count -eq 0) {
  Write-Host "No project web server process found."
} else {
  foreach ($id in ($ids | Sort-Object -Descending)) {
    Stop-Process -Id $id -Force
  }
  Write-Host "Stopped project web server process(es): $($ids -join ', ')"
}

Remove-Item -LiteralPath $pidFile -Force
