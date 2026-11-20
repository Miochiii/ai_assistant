$ErrorActionPreference = 'Stop'
$taskRoot = 'E:\file\agent\ai assistant'
$taskProfile = 'C:\Users\Mio\.dsh\profiles\desktop'
$taskTarget = Join-Path $taskRoot 'third_party\dsh-watch-together'
$taskLink = Join-Path $taskProfile 'node_modules\dsh-watch-together'
$taskPackagePath = Join-Path $taskProfile 'package.json'
$taskLockPath = Join-Path $taskProfile 'pnpm-lock.yaml'
$taskSource = Get-Content -LiteralPath (Join-Path $taskTarget 'package.json') -Raw | ConvertFrom-Json
if ($taskSource.name -ne 'dsh-watch-together') { throw 'Unexpected source package' }
if (Test-Path -LiteralPath $taskLink) { throw 'Link already exists; inspect before changing' }
$taskPackage = Get-Content -LiteralPath $taskPackagePath -Raw | ConvertFrom-Json -AsHashtable
if ($taskPackage.dependencies.ContainsKey('dsh-watch-together')) { throw 'Already registered' }
$taskLock = Get-Content -LiteralPath $taskLockPath -Raw
$taskAnchor = '      dsh-orb:'
if ($taskLock.Split($taskAnchor).Count -ne 2) { throw 'Unexpected lock structure' }
$taskBackup = Join-Path $taskRoot ('runtime\watch-together-install\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $taskBackup | Out-Null
foreach ($taskName in @('package.json','pnpm-lock.yaml','cordis.patch.yml')) {
  Copy-Item -LiteralPath (Join-Path $taskProfile $taskName) -Destination (Join-Path $taskBackup $taskName)
}
$taskPackage.dependencies['dsh-watch-together'] = 'link:E:/file/agent/ai assistant/third_party/dsh-watch-together'
$taskPackage.dsh.profile.bundles = @($taskPackage.dsh.profile.bundles) + @('dsh-watch-together')
$taskEntry = "      dsh-watch-together:`n        specifier: link:E:/file/agent/ai assistant/third_party/dsh-watch-together`n        version: link:E:/file/agent/ai assistant/third_party/dsh-watch-together`n"
$taskLock = $taskLock.Replace($taskAnchor, $taskEntry + $taskAnchor)
try {
  New-Item -ItemType Junction -Path $taskLink -Target $taskTarget | Out-Null
  [IO.File]::WriteAllText($taskPackagePath, ($taskPackage | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($taskLockPath, $taskLock, [Text.UTF8Encoding]::new($false))
  $taskActual = Get-Content -LiteralPath $taskPackagePath -Raw | ConvertFrom-Json
  if (@($taskActual.dsh.profile.bundles | Where-Object { $_ -eq 'dsh-watch-together' }).Count -ne 1) { throw 'Bundle readback failed' }
  if ((Get-Content -LiteralPath (Join-Path $taskLink 'package.json') -Raw | ConvertFrom-Json).name -ne 'dsh-watch-together') { throw 'Link readback failed' }
  $taskHashes = @{}
  foreach ($taskName in @('package.json','pnpm-lock.yaml','cordis.patch.yml')) {
    $taskHashes[$taskName] = (Get-FileHash -LiteralPath (Join-Path $taskProfile $taskName)).Hash
  }
  if ($taskHashes['cordis.patch.yml'] -ne (Get-FileHash -LiteralPath (Join-Path $taskBackup 'cordis.patch.yml')).Hash) { throw 'Existing configuration unexpectedly changed' }
  $taskReport = @{ source=$taskTarget; version=$taskSource.version; profile=$taskProfile; backup=$taskBackup; installedHashes=$taskHashes; restartRequired=$true; liveVerified=$false }
  $taskReport | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskBackup 'installation.json') -Encoding utf8NoBOM
  $taskReport | ConvertTo-Json -Depth 8
} catch {
  foreach ($taskName in @('package.json','pnpm-lock.yaml')) {
    Copy-Item -LiteralPath (Join-Path $taskBackup $taskName) -Destination (Join-Path $taskProfile $taskName) -Force
  }
  # Directory.Delete without recursive removes only the newly created junction.
  if ((Get-Item -LiteralPath $taskLink -ErrorAction SilentlyContinue).LinkType -eq 'Junction') { [IO.Directory]::Delete($taskLink) }
  throw
}
