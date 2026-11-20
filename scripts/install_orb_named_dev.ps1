$ErrorActionPreference = 'Stop'
$workspace = 'E:\file\agent\ai assistant'
$profileDir = 'C:\Users\Mio\.dsh\profiles\desktop'
$target = Join-Path $workspace 'dsh_orb_full_orig'
$packagePath = Join-Path $profileDir 'package.json'
$lockPath = Join-Path $profileDir 'pnpm-lock.yaml'
$linkPath = Join-Path $profileDir 'node_modules\dsh-orb-mio-dev'
$pkg = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json -AsHashtable
$dev = Get-Content -LiteralPath (Join-Path $target 'package.json') -Raw | ConvertFrom-Json
if ($dev.name -ne 'dsh-orb-mio-dev' -or $dev.version -ne '0.2.1-mio-dev.1') { throw 'Unexpected development package' }
if (Test-Path -LiteralPath $linkPath) { throw 'Development link already exists; inspect before reinstall' }
if (@($pkg.dsh.profile.bundles | Where-Object { $_ -eq 'dsh-orb' }).Count -ne 1) { throw 'Unexpected active Orb bundle' }
if ($pkg.dependencies.ContainsKey('dsh-orb-mio-dev')) { throw 'Development dependency already exists' }
$lock = Get-Content -LiteralPath $lockPath -Raw
$anchor = '      dsh-orb:'
if (($lock.Split($anchor)).Count -ne 2) { throw 'Unexpected lockfile structure' }
$entry = "      dsh-orb-mio-dev:`n        specifier: link:E:/file/agent/ai assistant/dsh_orb_full_orig`n        version: link:E:/file/agent/ai assistant/dsh_orb_full_orig`n"
$newLock = $lock.Replace($anchor, $entry + $anchor)
$pkg.dependencies['dsh-orb-mio-dev'] = 'link:E:/file/agent/ai assistant/dsh_orb_full_orig'
$pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles | ForEach-Object { if ($_ -eq 'dsh-orb') { 'dsh-orb-mio-dev' } else { $_ } })
$backup = Join-Path $workspace ('runtime\orb-install\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup | Out-Null
Copy-Item -LiteralPath $packagePath -Destination (Join-Path $backup 'package.json')
Copy-Item -LiteralPath $lockPath -Destination (Join-Path $backup 'pnpm-lock.yaml')
Copy-Item -LiteralPath (Join-Path $profileDir 'cordis.patch.yml') -Destination (Join-Path $backup 'cordis.patch.yml')
$linked = $false
try {
  New-Item -ItemType Junction -Path $linkPath -Target $target | Out-Null
  $linked = $true
  $pkg | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $packagePath -Encoding utf8NoBOM
  $newLock | Set-Content -LiteralPath $lockPath -Encoding utf8NoBOM -NoNewline
  $actual = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
  if ($actual.dsh.profile.bundles -contains 'dsh-orb' -or $actual.dsh.profile.bundles -notcontains 'dsh-orb-mio-dev') { throw 'Bundle readback mismatch' }
  $loaded = Get-Content -LiteralPath (Join-Path $linkPath 'package.json') -Raw | ConvertFrom-Json
  if ($loaded.name -ne 'dsh-orb-mio-dev') { throw 'Link readback mismatch' }
  @{ backup=$backup; package=$packagePath; link=$linkPath; target=$target; version=$loaded.version;
     originalOrbRetained=$true; restartRequired=$true; runningHostVerified=$false;
     packageSha256=(Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash;
     lockSha256=(Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash
   } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backup 'installation.json') -Encoding utf8NoBOM
  Get-Content -LiteralPath (Join-Path $backup 'installation.json')
} catch {
  Copy-Item -LiteralPath (Join-Path $backup 'package.json') -Destination $packagePath -Force
  Copy-Item -LiteralPath (Join-Path $backup 'pnpm-lock.yaml') -Destination $lockPath -Force
  # Leave any newly created, inactive junction for explicit inspection; no recursive removal.
  throw
}
