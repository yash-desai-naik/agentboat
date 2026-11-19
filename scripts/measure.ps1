# Watches AgentBoat's real memory and CPU over time: the app process plus every WebView2 process it
# started. "Private" is the private working set (Task Manager's "Memory" column); CPU is shown as
# a percentage of one core and of the whole machine.
#
#   powershell -ExecutionPolicy Bypass -File scripts\measure.ps1 [-Seconds 120] [-Every 2] [-Csv out.csv]
#
# Measures an already running AgentBoat (start it first, with the window shown). One line per sample,
# then a summary per phase if you passed -Marks (a file of "unix-ms label" lines written while
# measuring, e.g. by the CDP script that drives the app).

param(
    [int]$Seconds = 120,
    [double]$Every = 2,
    [string]$Csv,
    [string]$Marks
)

$ErrorActionPreference = "Stop"

function Get-Tree([int]$RootId) {
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine
    $ids = [System.Collections.Generic.List[int]]::new()
    $ids.Add($RootId)
    $i = 0
    while ($i -lt $ids.Count) {
        $parent = $ids[$i]
        foreach ($p in $all) {
            $id = [int]$p.ProcessId
            if ([int]$p.ParentProcessId -eq $parent -and -not $ids.Contains($id)) { $ids.Add($id) }
        }
        $i++
    }
    return $ids
}

$proc = Get-Process agentboat -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { throw "AgentBoat is not running." }
$rootId = $proc.Id
$cores = [Environment]::ProcessorCount
$ids = Get-Tree $rootId

function Sample-Cpu($Ids) {
    $sum = 0.0
    foreach ($id in $Ids) {
        $p = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($p) { $sum += $p.TotalProcessorTime.TotalMilliseconds }
    }
    return $sum
}

function Sample-Mem($Ids) {
    $app = 0.0; $web = 0.0
    $perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "Name like 'agentboat%' or Name like 'msedgewebview2%'"
    foreach ($p in $perf) {
        $id = [int]$p.IDProcess
        if (-not $Ids.Contains($id)) { continue }
        if ($id -eq $rootId) { $app += $p.WorkingSetPrivate } else { $web += $p.WorkingSetPrivate }
    }
    return @([math]::Round($app / 1MB, 1), [math]::Round($web / 1MB, 1))
}

$rows = [System.Collections.Generic.List[object]]::new()
$end = (Get-Date).AddSeconds($Seconds)
$lastCpu = Sample-Cpu $ids
$lastT = Get-Date
Write-Host ("{0,-12} {1,9} {2,8} {3,8} {4,9} {5,6}" -f "time", "cpu%core", "cpu%all", "appMB", "webviewMB", "procs")
while ((Get-Date) -lt $end) {
    Start-Sleep -Milliseconds ([int]($Every * 1000))
    # WebView2 can start helper processes later: refresh the tree now and then.
    if ($rows.Count % 5 -eq 0) { $ids = Get-Tree $rootId }
    $now = Get-Date
    $cpu = Sample-Cpu $ids
    $dt = ($now - $lastT).TotalMilliseconds
    $core = [math]::Round(($cpu - $lastCpu) / $dt * 100, 1)
    $all = [math]::Round($core / $cores, 2)
    $lastCpu = $cpu; $lastT = $now
    $mem = Sample-Mem $ids
    $ms = [DateTimeOffset]::new($now).ToUnixTimeMilliseconds()
    $row = [pscustomobject]@{ Ms = $ms; Time = $now.ToString("HH:mm:ss"); CpuCore = $core; CpuAll = $all; AppMB = $mem[0]; WebMB = $mem[1]; Procs = $ids.Count }
    $rows.Add($row)
    Write-Host ("{0,-12} {1,9} {2,8} {3,8} {4,9} {5,6}" -f $row.Time, $row.CpuCore, $row.CpuAll, $row.AppMB, $row.WebMB, $row.Procs)
}

if ($Csv) { $rows | Export-Csv -NoTypeInformation -Path $Csv }

if ($Marks -and (Test-Path $Marks)) {
    $m = Get-Content $Marks | Where-Object { $_ -match "^\d+ " } | ForEach-Object {
        $parts = $_ -split " ", 2
        [pscustomobject]@{ Ms = [long]$parts[0]; Label = $parts[1] }
    }
    Write-Host ""
    Write-Host ("{0,-28} {1,8} {2,10} {3,10} {4,10}" -f "phase", "samples", "cpu%core", "max%core", "totalMB")
    for ($k = 0; $k -lt $m.Count; $k++) {
        $from = $m[$k].Ms
        $to = if ($k + 1 -lt $m.Count) { $m[$k + 1].Ms } else { [long]::MaxValue }
        $in = $rows | Where-Object { $_.Ms -gt $from -and $_.Ms -le $to }
        if (-not $in) { continue }
        $avg = [math]::Round(($in | Measure-Object CpuCore -Average).Average, 1)
        $max = ($in | Measure-Object CpuCore -Maximum).Maximum
        $memAvg = [math]::Round((($in | ForEach-Object { $_.AppMB + $_.WebMB }) | Measure-Object -Average).Average, 0)
        Write-Host ("{0,-28} {1,8} {2,10} {3,10} {4,10}" -f $m[$k].Label, @($in).Count, $avg, $max, $memAvg)
    }
}
