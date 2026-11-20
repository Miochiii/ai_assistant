$ErrorActionPreference = 'Stop'
$taskRoot = 'E:\file\agent\ai assistant'
$taskProfile = 'C:\Users\Mio\.dsh\profiles\desktop'
$taskBackup = Join-Path $taskRoot 'runtime\evolve-install\20261111'
$taskTarget = Join-Path $taskRoot 'third_party\dsh-memory-evolve'
$taskLink = Join-Path $taskProfile 'node_modules\dsh-memory-evolve'
$taskPackagePath = Join-Path $taskProfile 'package.json'
$taskLockPath = Join-Path $taskProfile 'pnpm-lock.yaml'
$taskPatchPath = Join-Path $taskProfile 'cordis.patch.yml'
foreach ($taskName in @('package.json','pnpm-lock.yaml','cordis.patch.yml')) {
  if ((Get-FileHash -LiteralPath (Join-Path $taskProfile $taskName)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $taskBackup $taskName)).Hash) { throw "Profile changed after backup: $taskName" }
}
$taskSource = Get-Content -LiteralPath (Join-Path $taskTarget 'package.json') -Raw | ConvertFrom-Json
if ($taskSource.name -ne 'dsh-memory-evolve') { throw 'Unexpected source package' }
if (Test-Path -LiteralPath $taskLink) { throw 'Link already exists; inspect before changing' }
$taskPackage = Get-Content -LiteralPath $taskPackagePath -Raw | ConvertFrom-Json -AsHashtable
if ($taskPackage.dependencies.ContainsKey('dsh-memory-evolve')) { throw 'Already registered' }
$taskPackage.dependencies['dsh-memory-evolve'] = 'link:E:/file/agent/ai assistant/third_party/dsh-memory-evolve'
$taskPackage.dsh.profile.bundles = @($taskPackage.dsh.profile.bundles) + @('dsh-memory-evolve')
$taskLock = Get-Content -LiteralPath $taskLockPath -Raw
$taskAnchor = '      dsh-orb:'
if ($taskLock.Split($taskAnchor).Count -ne 2) { throw 'Unexpected lock structure' }
$taskEntry = "      dsh-memory-evolve:`n        specifier: link:E:/file/agent/ai assistant/third_party/dsh-memory-evolve`n        version: link:E:/file/agent/ai assistant/third_party/dsh-memory-evolve`n"
$taskLock = $taskLock.Replace($taskAnchor,$taskEntry+$taskAnchor)
$taskConfig = Get-Content -LiteralPath (Join-Path $taskRoot 'configs\evolve-integration.json') -Raw | ConvertFrom-Json
$taskConfigJson = $taskConfig | ConvertTo-Json -Depth 10 -Compress
$taskPatch = Get-Content -LiteralPath $taskPatchPath -Raw
$taskPatch += @"

# Memory backend handoff: native plugin owns new memory; old exposure gate remains.
- id: orb-memory
  disabled: true
- id: orb-host
  config:
    autoStart: true
    taskMemory:
      stateFile: 'E:/file/agent/ai assistant/runtime/memory/orb-task-exposures.json'
      legacyGuardOnly: true
- id: dsh-memory-evolve
  config: $taskConfigJson
"@
try {
  New-Item -ItemType Junction -Path $taskLink -Target $taskTarget | Out-Null
  [IO.File]::WriteAllText($taskPackagePath,($taskPackage|ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($taskLockPath,$taskLock,[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($taskPatchPath,$taskPatch,[Text.UTF8Encoding]::new($false))
  $taskActual = Get-Content -LiteralPath $taskPackagePath -Raw | ConvertFrom-Json
  if (@($taskActual.dsh.profile.bundles | Where-Object {$_ -eq 'dsh-memory-evolve'}).Count -ne 1) { throw 'Bundle readback failed' }
  if ((Get-Content -LiteralPath (Join-Path $taskLink 'package.json') -Raw | ConvertFrom-Json).name -ne 'dsh-memory-evolve') { throw 'Link readback failed' }
  $taskHashes = @{}
  foreach ($taskName in @('package.json','pnpm-lock.yaml','cordis.patch.yml')) {$taskHashes[$taskName]=(Get-FileHash -LiteralPath (Join-Path $taskProfile $taskName)).Hash}
  $taskReport = @{source=$taskTarget;version=$taskSource.version;profile=$taskProfile;backup=$taskBackup;installedHashes=$taskHashes;restartRequired=$true;liveVerified=$false}
  $taskReport|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $taskBackup 'installation.json') -Encoding utf8NoBOM
  $taskReport|ConvertTo-Json -Depth 8
} catch {
  foreach ($taskName in @('package.json','pnpm-lock.yaml','cordis.patch.yml')) {Copy-Item -LiteralPath (Join-Path $taskBackup $taskName) -Destination (Join-Path $taskProfile $taskName) -Force}
  throw
}
