param([Parameter(Mandatory=$true)][string]$BackupDirectory)
$ErrorActionPreference = 'Stop'
$backup = (Resolve-Path -LiteralPath $BackupDirectory).Path
$receipt = Get-Content -LiteralPath (Join-Path $backup 'installation.json') -Raw | ConvertFrom-Json
$packagePath = 'C:\Users\Mio\.dsh\profiles\desktop\package.json'
$lockPath = 'C:\Users\Mio\.dsh\profiles\desktop\pnpm-lock.yaml'
if ((Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash -ne $receipt.packageSha256 -or
    (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash -ne $receipt.lockSha256) {
  throw 'Profile changed after installation. Refusing to overwrite newer configuration; merge manually.'
}
Copy-Item -LiteralPath (Join-Path $backup 'package.json') -Destination $packagePath -Force
Copy-Item -LiteralPath (Join-Path $backup 'pnpm-lock.yaml') -Destination $lockPath -Force
Write-Output 'Original Orb bundle restored. Restart DSH to load it. Developer files and inactive junction retained.'
