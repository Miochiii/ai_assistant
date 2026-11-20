param(
  [string]$ProcessName = 'WINWORD',
  [string]$Out = 'tmp\uia-probe.json',
  [long]$Hwnd = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

$result = [ordered]@{
  ok       = $false
  process  = $ProcessName
  error    = $null
  window   = $null
  timingMs = [ordered]@{}
  counts   = [ordered]@{ descendants = 0; buttons = 0; noName = 0; badRect = 0 }
  matches  = @()
  pointAt  = @()
  buttons  = @()
}

# Virtualized / off-screen elements can report an infinite BoundingRectangle.
function Convert-Rect($r) {
  $values = @($r.X, $r.Y, $r.Width, $r.Height)
  foreach ($v in $values) {
    # .NET Framework has no Double.IsFinite; NaN/Infinity covers the same cases.
    $d = [double]$v
    if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return $null }
  }
  if ($r.Width -le 0 -or $r.Height -le 0) { return $null }
  return @([int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
}

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) {
  $result.error = 'no window'
  [System.IO.File]::WriteAllText((Join-Path $PWD $Out), ($result | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
  Write-Output 'NO_WINDOW'
  exit 1
}

# -Hwnd wins when given: Chromium apps often have several top-level windows and
# MainWindowHandle can point at a small popup instead of the main window.
if ($Hwnd -gt 0) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Hwnd)
  $result.window = [ordered]@{ pid = $proc.Id; hwnd = $Hwnd; title = (Get-Process -Id $proc.Id).MainWindowTitle }
} else {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
  $result.window = [ordered]@{ pid = $proc.Id; hwnd = $proc.MainWindowHandle.ToInt64(); title = $proc.MainWindowTitle }
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$sw.Stop()
$result.timingMs.walkAll = $sw.ElapsedMilliseconds
$result.counts.descendants = $all.Count

$buffer = New-Object System.Collections.ArrayList
$noName = 0
$badRect = 0
for ($i = 0; $i -lt $all.Count; $i++) {
  $el = $all.Item($i)
  $cur = $el.Current
  $type = $cur.ControlType.ProgrammaticName -replace '^ControlType\.', ''
  if ($type -ne 'Button' -and $type -ne 'SplitButton' -and $type -ne 'MenuItem') { continue }
  if ([string]::IsNullOrWhiteSpace($cur.Name)) { $noName++; continue }
  $rect = Convert-Rect $cur.BoundingRectangle
  if ($null -eq $rect) { $badRect++; continue }
  [void]$buffer.Add([ordered]@{
    name  = $cur.Name
    type  = $type
    class = $cur.ClassName
    aid   = $cur.AutomationId
    rect  = $rect
  })
}
$result.counts.buttons = $buffer.Count
$result.counts.noName = $noName
$result.counts.badRect = $badRect
$result.buttons = $buffer

# Keywords: 增大字号 / 字号 / 字体 / 保存 / Font
$needles = @(
  ([string][char]0x589E + [char]0x5927 + [char]0x5B57 + [char]0x53F7),
  ([string][char]0x5B57 + [char]0x53F7),
  ([string][char]0x5B57 + [char]0x4F53),
  ([string][char]0x4FDD + [char]0x5B58),
  'Font'
)
$hits = New-Object System.Collections.ArrayList
foreach ($item in $buffer) {
  foreach ($n in $needles) {
    if ($item.name -like "*$n*") { [void]$hits.Add($item); break }
  }
}
$result.matches = $hits

$points = @(@(430, 153), @(700, 150), @(300, 150))
foreach ($p in $points) {
  try {
    $pt = [System.Windows.Point]::new([double]$p[0], [double]$p[1])
    $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
    if ($null -eq $el) {
      $result.pointAt += [ordered]@{ point = $p; name = $null; type = 'null'; class = $null; rect = $null }
    } else {
      $result.pointAt += [ordered]@{
        point = $p
        name  = $el.Current.Name
        type  = $el.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
        class = $el.Current.ClassName
        rect  = (Convert-Rect $el.Current.BoundingRectangle)
      }
    }
  } catch {
    $result.pointAt += [ordered]@{ point = $p; name = $null; type = 'error'; class = $_.Exception.Message; rect = $null }
  }
}

$result.ok = $true
[System.IO.File]::WriteAllText((Join-Path $PWD $Out), ($result | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
Write-Output ("OK descendants={0} named={1} noName={2} badRect={3} walk={4}ms matches={5}" -f `
  $result.counts.descendants, $result.counts.buttons, $result.counts.noName, $result.counts.badRect, $result.timingMs.walkAll, $result.matches.Count)
