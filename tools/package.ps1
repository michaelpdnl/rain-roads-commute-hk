$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
$outPath = Join-Path $projectPath 'submission'
New-Item -ItemType Directory -Force -Path $outPath | Out-Null
$zipPath = Join-Path $outPath 'COMP7503-Rain-Roads-Submission.zip'
$quickGuideName = (-join ([char[]](0x5148,0x770b,0x8fd9,0x91cc))) + '.md'

# A previous PDF/ZIP is not evidence for the new Python original-method worker.
# report.py writes these hashes only after checking current evidence and captures.
$manifestPath = Join-Path $projectPath 'report/build-manifest.json'
if (!(Test-Path -LiteralPath $manifestPath)) { throw 'Regenerate and visually verify the current report before packaging: missing report/build-manifest.json' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$originalReference = 'PLAN-v4.md ' + [char]0x00a7 + '8'
if ($manifest.reference -ne $originalReference) { throw 'Report manifest is not for original PLAN-v4 section 8.' }
$projectPrefix = [IO.Path]::GetFullPath($projectPath).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
foreach ($group in @($manifest.inputs, $manifest.outputs)) {
  if (!$group -or @($group.PSObject.Properties).Count -eq 0) { throw 'Report manifest has no input/output hashes.' }
  foreach ($property in $group.PSObject.Properties) {
    $inputPath = [IO.Path]::GetFullPath((Join-Path $projectPath $property.Name))
    if (!$inputPath.StartsWith($projectPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Invalid report manifest path: $($property.Name)" }
    if (!(Test-Path -LiteralPath $inputPath -PathType Leaf)) { throw "Missing report provenance item: $($property.Name)" }
    if ((Get-FileHash -LiteralPath $inputPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $property.Value) {
      throw "Report is stale; regenerate after current evidence/source changes: $($property.Name)"
    }
  }
}
$include = @(
  'flows.json','Dockerfile','Dockerfile.analytics','compose.yaml','settings.js',
  'package.json','package-lock.json','requirements-analytics.txt','.env.example','.dockerignore',
  'README.md','ACCEPTANCE.md','PLAN-v4.md',$quickGuideName,
  'lib','analysis','web','mockup','tools','tests',
  'report/Project-Report.pdf','report/Project-Report.md','report/evidence.json','report/build-manifest.json',
  'report/screenshots/live.png','report/screenshots/analysis.png','report/screenshots/replay.png',
  'report/screenshots/decisions.png','report/screenshots/quality.png',
  'artifacts/original-runtime-verification.json'
  'artifacts/original-data-audit.json','artifacts/original-backfill-summary.json',
  'artifacts/original-browser-verification.json'
)
if (Test-Path -LiteralPath (Join-Path $projectPath 'report/authors.json')) { $include += 'report/authors.json' }
if (Test-Path -LiteralPath (Join-Path $projectPath 'artifacts/original-test-results.json')) {
  $include += 'artifacts/original-test-results.json'
}
# A history snapshot is optional. If supplied, it must be exported for this run;
# historical report/verification files are deliberately not copied wholesale.
if (Test-Path -LiteralPath (Join-Path $projectPath 'history')) {
  $historyManifestPath = Join-Path $projectPath 'history/manifest.json'
  if (!(Test-Path -LiteralPath $historyManifestPath)) { throw 'Supplied history has no manifest.' }
  $historyManifest = Get-Content -LiteralPath $historyManifestPath -Raw | ConvertFrom-Json
  if (!$historyManifest.createdAt -or ([DateTimeOffset]$historyManifest.createdAt) -lt ([DateTimeOffset]$manifest.runtimeCheckedAt).AddHours(-1)) {
    throw 'Supplied history is stale; export a current snapshot after backfill and verify its restore before packaging.'
  }
  $include += 'history'
}
foreach ($entry in $include) {
  if (!(Test-Path -LiteralPath (Join-Path $projectPath $entry))) { throw "Missing submission item: $entry" }
}

# Preserve relative paths (including artifacts/) and omit Python caches.
$stagingPath = Join-Path $outPath ('.package-staging-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stagingPath | Out-Null
try {
  foreach ($entry in $include) {
    $itemPath = Join-Path $projectPath $entry
    $item = Get-Item -LiteralPath $itemPath
    $files = if ($item.PSIsContainer) { Get-ChildItem -LiteralPath $itemPath -File -Recurse } else { @($item) }
    foreach ($sourceFile in $files) {
      if ($sourceFile.FullName -match '[\\/](__pycache__|\.pytest_cache)[\\/]' -or $sourceFile.Extension -eq '.pyc') { continue }
      $relativePath = $sourceFile.FullName.Substring($projectPrefix.Length)
      $destinationPath = Join-Path $stagingPath $relativePath
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destinationPath) | Out-Null
      Copy-Item -LiteralPath $sourceFile.FullName -Destination $destinationPath
    }
  }
  Compress-Archive -Path (Join-Path $stagingPath '*') -DestinationPath $zipPath -Force
}
finally {
  $resolvedStaging = [IO.Path]::GetFullPath($stagingPath)
  $submissionPrefix = [IO.Path]::GetFullPath($outPath).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
  if (!$resolvedStaging.StartsWith($submissionPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to remove staging outside submission directory.' }
  if (Test-Path -LiteralPath $resolvedStaging) { Remove-Item -LiteralPath $resolvedStaging -Recurse -Force }
}
$file = Get-Item -LiteralPath $zipPath
Write-Host ("Created {0} ({1:N1} MB)" -f $file.FullName, ($file.Length / 1MB))
