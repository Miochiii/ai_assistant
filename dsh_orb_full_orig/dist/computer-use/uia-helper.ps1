param()

# UIA worker: reads one JSON request per line on stdin, writes one JSON line per request on stdout.
# Read-only: it never sends input. Kept ASCII-only on purpose -- Windows PowerShell 5.1 reads
# .ps1 files as ANSI when there is no BOM, and non-ASCII comments/strings break the parser.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

function Write-Line($payload) {
  [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

# Virtualized elements can report an infinite BoundingRectangle; casting that to Int32 throws.
function Get-RectOrNull($r) {
  $vals = @($r.X, $r.Y, $r.Width, $r.Height)
  foreach ($v in $vals) {
    $d = [double]$v
    if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return @() }
  }
  if ($r.Width -le 0 -or $r.Height -le 0) { return @() }
  # A minimized window reports coordinates like -31713: useless for clicking, so drop them.
  $OFFSCREEN_LIMIT = -10000
  if ($r.X -le $OFFSCREEN_LIMIT -or $r.Y -le $OFFSCREEN_LIMIT) { return @() }
  return @([int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
}

# Accessible names often carry a shortcut suffix: "Settings and more (Alt+F)".
# Users type just the plain part, so compare on the stripped form as well.
function Normalize-Name($name) {
  if ([string]::IsNullOrWhiteSpace($name)) { return '' }
  return ($name -replace '\s*\([^)]*\)\s*$', '').Trim()
}

function Get-ElementInfo($el, [switch]$Light) {
  if ($null -eq $el) { return $null }
  $cur = $el.Current
  $r = $cur.BoundingRectangle
  $info = [ordered]@{
    name  = $cur.Name
    type  = $cur.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    class = $cur.ClassName
    aid   = $cur.AutomationId
    rect  = (Get-RectOrNull $r)
  }
  if ($Light) { return $info }
  try {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $node = $el
    for ($i = 0; $i -lt 12; $i++) {
      $parent = $walker.GetParent($node)
      if ($null -eq $parent) { break }
      $node = $parent
    }
    $info.window = $node.Current.Name
  } catch {
    $info.window = $null
  }
  return $info
}

function Get-Root([int]$hwnd) {
  if ($hwnd -gt 0) {
    $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
    if ($null -ne $el) { return $el }
  }
  return [System.Windows.Automation.AutomationElement]::RootElement
}

function Get-Candidates($root, [int]$limit) {
  $names = New-Object System.Collections.ArrayList
  $seen = @{}
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $stack = New-Object System.Collections.Stack
  $stack.Push($root)
  $visited = 0
  while ($stack.Count -gt 0 -and $names.Count -lt $limit -and $visited -lt 4000) {
    $node = $stack.Pop()
    $visited++
    $cur = $node.Current
    $type = $cur.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    if (($type -eq 'Button' -or $type -eq 'MenuItem' -or $type -eq 'ListItem') -and -not [string]::IsNullOrWhiteSpace($cur.Name)) {
      if (-not $seen.ContainsKey($cur.Name)) {
        $seen[$cur.Name] = 1
        [void]$names.Add($cur.Name)
      }
    }
    $child = $walker.GetFirstChild($node)
    while ($null -ne $child) {
      $stack.Push($child)
      $child = $walker.GetNextSibling($child)
    }
  }
  return $names
}

Write-Line ([ordered]@{ ready = $true })

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }

  $request = $null
  try { $request = $line | ConvertFrom-Json } catch { $request = $null }
  if ($null -eq $request) { continue }

  $id = $request.id
  try {
    switch ($request.op) {
      'ping' {
        Write-Line ([ordered]@{ id = $id; ok = $true; pong = $true })
      }
      'elementAt' {
        $pt = [System.Windows.Point]::new([double]$request.x, [double]$request.y)
        $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
        Write-Line ([ordered]@{ id = $id; ok = $true; element = (Get-ElementInfo $el) })
      }
      'controls' {
        $root = Get-Root ([int]$request.hwnd)
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        $items = New-Object System.Collections.ArrayList
        $named = 0
        $filter = [string]$request.filter
        $limit = [int]$request.limit
        if ($limit -le 0) { $limit = 40 }
        for ($i = 0; $i -lt $all.Count; $i++) {
          $el = $all.Item($i)
          $info = Get-ElementInfo $el -Light
          if ($null -eq $info) { continue }
          $t = $info.type
          if ($t -ne 'Button' -and $t -ne 'SplitButton' -and $t -ne 'MenuItem' -and $t -ne 'Edit' -and $t -ne 'ListItem') { continue }
          if ([string]::IsNullOrWhiteSpace($info.name)) { continue }
          $named++
          if ($filter.Length -gt 0 -and $info.name -notlike "*$filter*") { continue }
          if ($items.Count -ge $limit) { continue }
          [void]$items.Add([ordered]@{ name = $info.name; type = $t; class = $info.class; aid = $info.aid; rect = $info.rect })
        }
        $sw.Stop()
        Write-Line ([ordered]@{ id = $id; ok = $true; named = $named; total = $all.Count; walkMs = $sw.ElapsedMilliseconds; elements = $items })
      }
      'find' {
        $root = Get-Root ([int]$request.hwnd)
        $wantedRaw = [string]$request.name
        $el = $null
        if (-not [string]::IsNullOrWhiteSpace($wantedRaw)) {
          $cond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $wantedRaw)
          $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
        }
        if ($null -eq $el -and -not [string]::IsNullOrWhiteSpace($wantedRaw)) {
          # Second chance: ignore the trailing shortcut suffix. Third: substring match.
          $wanted = Normalize-Name $wantedRaw
          $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
          $contains = $null
          for ($i = 0; $i -lt $all.Count; $i++) {
            $cand = $all.Item($i)
            $candName = $cand.Current.Name
            if ([string]::IsNullOrWhiteSpace($candName)) { continue }
            $normalized = Normalize-Name $candName
            if ($normalized -eq $wanted) { $el = $cand; break }
            if ($null -eq $contains -and $wanted.Length -gt 0 -and $normalized -like "*$wanted*") { $contains = $cand }
          }
          if ($null -eq $el -and $null -ne $contains) { $el = $contains }
        }
        if ($null -ne $el) {
          Write-Line ([ordered]@{ id = $id; ok = $true; element = (Get-ElementInfo $el) })
        } else {
          $candidates = Get-Candidates $root 40
          Write-Line ([ordered]@{ id = $id; ok = $false; error = 'not found'; candidates = $candidates })
        }
      }
      default {
        Write-Line ([ordered]@{ id = $id; ok = $false; error = ("unknown op: " + [string]$request.op) })
      }
    }
  } catch {
    Write-Line ([ordered]@{ id = $id; ok = $false; error = $_.Exception.Message })
  }
}
