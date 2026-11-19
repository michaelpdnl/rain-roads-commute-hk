$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
$outPath = Join-Path $projectPath 'submission'
New-Item -ItemType Directory -Force -Path $outPath | Out-Null
$zipPath = Join-Path $outPath 'COMP7503-Rain-Roads-Submission.zip'
$quickGuideName = (-join ([char[]](0x5148,0x770b,0x8fd9,0x91cc))) + '.md'
$include = @('flows.json','Dockerfile','compose.yaml','settings.js','package.json','package-lock.json','.env.example','.dockerignore','README.md','ACCEPTANCE.md',$quickGuideName,'lib','web','tools','tests','report','history')
$sources = foreach ($entry in $include) {
  $itemPath = Join-Path $projectPath $entry
  if (!(Test-Path -LiteralPath $itemPath)) { throw "Missing submission item: $entry" }
  $itemPath
}
Compress-Archive -LiteralPath $sources -DestinationPath $zipPath -Force
$file = Get-Item -LiteralPath $zipPath
Write-Host ("Created {0} ({1:N1} MB)" -f $file.FullName, ($file.Length / 1MB))
