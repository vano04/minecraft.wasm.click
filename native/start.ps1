# Downloads the self-contained open-source CLI and verifies its published SHA-256.
# Windows PowerShell 5.1; no service, elevation or runtime installation.
$ErrorActionPreference = 'Stop'
$relayBase = 'https://minecraft.wasm.click/relay/cli'
$relayArch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'amd64' }
$relayName = "mcwc-relay-windows-$relayArch.exe"
$relayTemp = Join-Path ([IO.Path]::GetTempPath()) ('mcwc-relay-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($relayTemp)
try {
    $relayManifest = Invoke-RestMethod "$relayBase/manifest.json"
    $relayRecord = $relayManifest.files.$relayName
    if ($relayManifest.schema -ne 1 -or $relayRecord.sha256 -notmatch '^[a-f0-9]{64}$' -or $relayRecord.bytes -le 0 -or $relayRecord.bytes -gt 25165824) { throw 'Invalid relay download manifest.' }
    Write-Host 'Downloading the self-contained minecraft.wasm.click CLI (about 12 MB). No helper page or runtime installation.'
    $relayExe = Join-Path $relayTemp 'mcwc-relay.exe'
    Invoke-WebRequest -UseBasicParsing "$relayBase/$relayName" -OutFile $relayExe
    if ((Get-Item $relayExe).Length -ne $relayRecord.bytes -or (Get-FileHash -Algorithm SHA256 $relayExe).Hash.ToLowerInvariant() -ne $relayRecord.sha256) { throw 'Relay checksum mismatch. Nothing was run.' }
    & $relayExe
    if ($LASTEXITCODE -ne 0) { throw "Relay exited with code $LASTEXITCODE." }
} finally {
    Remove-Item -LiteralPath $relayTemp -Recurse -Force -ErrorAction SilentlyContinue
}
