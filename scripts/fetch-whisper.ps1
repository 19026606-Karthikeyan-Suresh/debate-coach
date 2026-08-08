<#
.SYNOPSIS
  Downloads whisper.cpp and the two ggml models the speech trainer needs.

.DESCRIPTION
  The binary is ~10 MB and the models are 148 MB (base.en) and 488 MB (small.en), so none of
  them are in git. This fetches them once.

  Files land in two places, and which one matters:

    src-tauri/binaries/whisper-cli-<triple>.exe  what the installer bundles
    src-tauri/resources/models/*.bin             what the installer bundles
    %APPDATA%/com.kartixc.debatecoach/whisper/   what a dev run resolves against

  A dev build resolves whisper from the app-data copy because tauri.conf.json deliberately does
  not declare externalBin: a declared binary that is not on disk fails `cargo build` outright,
  which would mean nobody could compile the project — or run CI — without first downloading
  636 MB. Release builds opt in instead:

    npm run tauri build -- --config tauri.bundle-whisper.conf.json

.PARAMETER SkipSmall
  Fetches base.en only. Live transcription works; the accurate post-speech re-pass falls back
  to base.en and the report is built from a worse transcript.

.PARAMETER Force
  Re-downloads files that are already present.
#>
[CmdletBinding()]
param(
  [switch]$SkipSmall,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

# Pinned rather than "latest" for the same reason rust-toolchain.toml is: whisper.cpp changes
# its CLI flags and its stdout format between releases, and src/whisper.rs parses both.
#
# v1.7.6 rather than the v1.7.4 written here in phase 5, and not by choice: **v1.7.0 through
# v1.7.5 shipped no release assets at all.** Prebuilt Windows binaries stop after v1.6.0 and do
# not resume until v1.7.6, so the original pin could never have worked — it was written without
# the script ever being run. v1.7.6 is the nearest release to it that exists as a download.
#
# The repository also moved from `ggerganov/whisper.cpp` to `ggml-org/whisper.cpp`. The GitHub
# API follows that rename but release asset URLs do not, so the old path 404s.
$WhisperRelease = 'v1.7.6'
$BinaryUrl = "https://github.com/ggml-org/whisper.cpp/releases/download/$WhisperRelease/whisper-bin-x64.zip"

# The models are still published under the personal account; only the code repo was renamed.
$ModelBaseUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

# Must match TAURI_ENV_TARGET_TRIPLE; Tauri looks up externalBin by this exact suffix.
$TargetTriple = 'x86_64-pc-windows-msvc'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$BinDir = Join-Path $RepoRoot 'src-tauri\binaries'
$ResourceModels = Join-Path $RepoRoot 'src-tauri\resources\models'
$AppData = Join-Path $env:APPDATA 'com.kartixc.debatecoach\whisper'
$AppDataModels = Join-Path $AppData 'models'

foreach ($dir in @($BinDir, $ResourceModels, $AppData, $AppDataModels)) {
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

function Get-RemoteFile {
  param([string]$Url, [string]$Destination, [string]$Label)

  if ((Test-Path $Destination) -and -not $Force) {
    Write-Host "  $Label already present, skipping." -ForegroundColor DarkGray
    return
  }
  Write-Host "  downloading $Label..." -ForegroundColor Cyan
  # Progress rendering makes Invoke-WebRequest roughly ten times slower on large files.
  $previous = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  try {
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
  } finally {
    $ProgressPreference = $previous
  }
}

Write-Host "whisper.cpp $WhisperRelease" -ForegroundColor Green

# --- binary -----------------------------------------------------------------
$zipPath = Join-Path $env:TEMP "whisper-$WhisperRelease.zip"
$extractPath = Join-Path $env:TEMP "whisper-$WhisperRelease"
$targetBinary = Join-Path $BinDir "whisper-cli-$TargetTriple.exe"

if ((Test-Path $targetBinary) -and -not $Force) {
  Write-Host "  whisper-cli already present, skipping." -ForegroundColor DarkGray
} else {
  Get-RemoteFile -Url $BinaryUrl -Destination $zipPath -Label 'whisper-bin-x64.zip'
  if (Test-Path $extractPath) { Remove-Item $extractPath -Recurse -Force }
  Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force

  # Releases have moved the executable between the archive root and Release/, and renamed it
  # from main.exe to whisper-cli.exe. Search rather than assume — but search in **name order,
  # not directory order**, which is what the first version of this got wrong.
  #
  # v1.7.6 ships both names: the real 469 KB decoder as whisper-cli.exe, and a 27 KB deprecation
  # shim as main.exe that prints a notice and exits 1. `-Include` with both names returns them
  # alphabetically, so `main.exe` won and the installed "whisper-cli.exe" was a stub that could
  # never transcribe anything. Ask for the modern name first and only fall back.
  $found = $null
  foreach ($candidate in @('whisper-cli.exe', 'main.exe')) {
    $found = Get-ChildItem -Path $extractPath -Recurse -Filter $candidate | Select-Object -First 1
    if ($found) { break }
  }
  if (-not $found) {
    throw "No whisper-cli.exe or main.exe inside $BinaryUrl. The release layout changed."
  }
  Copy-Item $found.FullName $targetBinary -Force
  Copy-Item $found.FullName (Join-Path $AppData 'whisper-cli.exe') -Force

  # whisper.cpp links its ggml DLLs dynamically, and Windows resolves them from the directory
  # of the exe that loaded them. Without them beside whisper-cli.exe the process dies before
  # printing anything, which src/whisper.rs can only report as "whisper-cli failed".
  #
  # The dev copy just needs them in the same folder. The bundled copy needs each one declared
  # as its own externalBin entry, because Tauri places only named binaries next to the app exe
  # and resources land in a subfolder Windows will not search. Which DLLs a release ships
  # changes, so the names are collected and printed rather than hardcoded in the merge config.
  $script:BundledDlls = @()
  Get-ChildItem -Path $extractPath -Recurse -Filter '*.dll' | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $AppData $_.Name) -Force
    $stem = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
    Copy-Item $_.FullName (Join-Path $BinDir "$stem-$TargetTriple.dll") -Force
    $script:BundledDlls += "binaries/$stem"
  }

  # Prove the thing that was installed actually runs, rather than finding out mid-round.
  #
  # Worth the two seconds because both failure modes here are silent: this release ships a
  # deprecation shim that exits 1 under a name we search for, and whisper-cli dies before
  # printing anything if the ggml DLLs are not beside it — which `src/whisper.rs` can only ever
  # report as "whisper-cli failed". Run after the DLL copy above for exactly that reason.
  # `2>$null` rather than `2>&1`: whisper-cli prints its usage to stderr, and merging a native
  # command's stderr in PowerShell 5.1 wraps every line in an ErrorRecord.
  & (Join-Path $AppData 'whisper-cli.exe') '--help' 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw ("Installed $($found.FullName) but it exits $LASTEXITCODE on --help, so it is a " +
      'deprecation stub or is missing its DLLs. The release layout changed again.')
  }

  Write-Host "  whisper-cli -> $targetBinary" -ForegroundColor Green
}

# --- models -----------------------------------------------------------------
$models = @('ggml-base.en.bin')
if (-not $SkipSmall) { $models += 'ggml-small.en.bin' }

foreach ($model in $models) {
  $resourceCopy = Join-Path $ResourceModels $model
  Get-RemoteFile -Url "$ModelBaseUrl/$model" -Destination $resourceCopy -Label $model
  Copy-Item $resourceCopy (Join-Path $AppDataModels $model) -Force
}

Write-Host ''
Write-Host 'Done. `npm run tauri dev` will now find whisper.' -ForegroundColor Green
Write-Host 'To bundle it into an installer:' -ForegroundColor Green
Write-Host '  npm run tauri build -- --config tauri.bundle-whisper.conf.json' -ForegroundColor Green

if ($script:BundledDlls.Count -gt 0) {
  Write-Host ''
  Write-Host 'Add these to bundle.externalBin in tauri.bundle-whisper.conf.json first —' -ForegroundColor Yellow
  Write-Host 'whisper-cli will not start in the installed app without them:' -ForegroundColor Yellow
  foreach ($entry in ($script:BundledDlls | Sort-Object -Unique)) {
    Write-Host "  `"$entry`"," -ForegroundColor Yellow
  }
}
