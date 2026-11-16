[CmdletBinding()]
param(
  [string]$Version = "",
  [string]$OutputDirectory = "",
  [string]$WixBin = "",
  [string]$XwinRoot = "",
  [string]$VcRuntimeDir = "",
  [string]$Toolchain = "1.95.0-x86_64-pc-windows-msvc",
  [switch]$SkipBuild,
  [switch]$SkipInstallTest,
  [switch]$SignDevelopment,
  [string]$PfxPath = "",
  [string]$PfxPassword = "",
  [string]$Thumbprint = "",
  [string]$TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
if ($env:OS -ne "Windows_NT") {
  throw "The Windows MSI pipeline must run on Windows."
}

$root = Split-Path -Parent $PSScriptRoot
$rustRoot = Join-Path $root "remote-desktop-rs"
$manifest = Join-Path $rustRoot "Cargo.toml"
$componentManifest = Join-Path $rustRoot "crates/desktop-streaming/Cargo.toml"
$wxs = Join-Path $rustRoot "packaging/windows/product.wxs"
if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $root "release/windows"
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

if (-not $Version) {
  $workspace = Get-Content -LiteralPath $manifest -Raw
  $match = [regex]::Match($workspace, '(?ms)^\[workspace\.package\].*?^version\s*=\s*"([^"]+)"')
  if (-not $match.Success) {
    throw "Could not read the Rust workspace version from $manifest."
  }
  $Version = $match.Groups[1].Value
}
if ($Version -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$') {
  throw "MSI ProductVersion must contain 3 or 4 numeric parts; got '$Version'."
}

$signRequested = $SignDevelopment -or $PfxPath -or $Thumbprint
if (($SignDevelopment -and ($PfxPath -or $Thumbprint)) -or ($PfxPath -and $Thumbprint)) {
  throw "Choose exactly one signing source: -SignDevelopment, -PfxPath, or -Thumbprint."
}

$binary = Join-Path $rustRoot "target/x86_64-pc-windows-msvc/release/task-handoff-desktop-streaming.exe"
if (-not $SkipBuild) {
  if (-not $XwinRoot) {
    $XwinRoot = $env:TASK_HANDOFF_XWIN_ROOT
  }
  if (-not $XwinRoot) {
    $candidates = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA "cargo-xwin") -Directory -Filter "splat*" -ErrorAction SilentlyContinue |
      Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "crt/lib/x86_64/libcmt.lib") } |
      Sort-Object LastWriteTime -Descending
    if ($candidates) {
      $XwinRoot = $candidates[0].FullName
    }
  }
  if (-not $XwinRoot -or -not (Test-Path -LiteralPath (Join-Path $XwinRoot "crt/lib/x86_64/libcmt.lib"))) {
    throw "An xwin CRT/SDK root is required. Pass -XwinRoot or set TASK_HANDOFF_XWIN_ROOT."
  }
  $XwinRoot = (Resolve-Path -LiteralPath $XwinRoot).Path

  if (-not $VcRuntimeDir) {
    $VcRuntimeDir = $env:TASK_HANDOFF_VC_RUNTIME_DIR
  }
  if (-not $VcRuntimeDir -and $env:VCToolsRedistDir) {
    $VcRuntimeDir = Get-ChildItem -LiteralPath $env:VCToolsRedistDir -Directory -Filter "x64" -Recurse -ErrorAction SilentlyContinue |
      Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "vcruntime140.dll") } |
      Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $VcRuntimeDir) {
    $fallback = Join-Path $root "tools/vc-runtime-min/System64"
    if (Test-Path -LiteralPath (Join-Path $fallback "vcruntime140.dll")) {
      $VcRuntimeDir = $fallback
    }
  }
  if ($VcRuntimeDir -and -not (Test-Path -LiteralPath (Join-Path $VcRuntimeDir "vcruntime140.dll"))) {
    throw "VcRuntimeDir does not contain vcruntime140.dll: $VcRuntimeDir"
  }

  foreach ($tool in "clang-cl", "llvm-lib", "lld-link") {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
      throw "$tool is required on PATH for the MSVC build."
    }
  }

  $pathParts = @((Join-Path $env:USERPROFILE ".cargo/bin"), (Join-Path $env:USERPROFILE "winlibs/mingw64/bin"))
  if ($VcRuntimeDir) { $pathParts += $VcRuntimeDir }
  $pathParts += $env:Path
  $env:Path = $pathParts -join ";"
  $env:TARGET_CC = "clang-cl"
  $env:TARGET_CXX = "clang-cl"
  $env:CC_x86_64_pc_windows_msvc = "clang-cl"
  $env:CXX_x86_64_pc_windows_msvc = "clang-cl"
  $env:TARGET_AR = "llvm-lib"
  $env:AR_x86_64_pc_windows_msvc = "llvm-lib"
  $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = "lld-link"
  $includeFlags = @(
    "--target=x86_64-pc-windows-msvc",
    "-Wno-unused-command-line-argument",
    "-fuse-ld=lld-link",
    "/MT",
    "/imsvc $XwinRoot/crt/include",
    "/imsvc $XwinRoot/sdk/include/ucrt",
    "/imsvc $XwinRoot/sdk/include/um",
    "/imsvc $XwinRoot/sdk/include/shared",
    "/imsvc $XwinRoot/sdk/include/winrt"
  ) -join " "
  $env:CL_FLAGS = $includeFlags
  $env:CFLAGS_x86_64_pc_windows_msvc = $includeFlags
  $env:CXXFLAGS_x86_64_pc_windows_msvc = "$includeFlags /EHsc"
  $env:LIB = @(
    "$XwinRoot/crt/lib/x86_64",
    "$XwinRoot/sdk/lib/um/x86_64",
    "$XwinRoot/sdk/lib/ucrt/x86_64"
  ) -join ";"
  $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS = @(
    "-C target-feature=+crt-static",
    "-C linker-flavor=lld-link",
    "-C link-arg=-nodefaultlib:ucrt",
    "-C link-arg=-defaultlib:libucrt",
    "-Lnative=$XwinRoot/crt/lib/x86_64",
    "-Lnative=$XwinRoot/sdk/lib/um/x86_64",
    "-Lnative=$XwinRoot/sdk/lib/ucrt/x86_64"
  ) -join " "
  Remove-Item Env:RUSTFLAGS -ErrorAction SilentlyContinue

  Write-Output "Building MSVC release $Version"
  & cargo "+$Toolchain" build --locked --release --target x86_64-pc-windows-msvc --manifest-path $manifest -p desktop-streaming --bin task-handoff-desktop-streaming
  if ($LASTEXITCODE -ne 0) { throw "Cargo MSVC release build failed with exit code $LASTEXITCODE." }
}

if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
  throw "MSVC binary is missing: $binary"
}

$stage = Join-Path $OutputDirectory "stage/$Version"
if (Test-Path -LiteralPath $stage) {
  Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item -LiteralPath $binary -Destination (Join-Path $stage "task-handoff-desktop-streaming.exe")
Copy-Item -LiteralPath (Join-Path $rustRoot "crates/desktop-streaming/README.md") -Destination (Join-Path $stage "README.md")
Copy-Item -LiteralPath (Join-Path $root "LICENSE") -Destination (Join-Path $stage "LICENSE")
Copy-Item -LiteralPath (Join-Path $root "NOTICE") -Destination (Join-Path $stage "NOTICE")
$stagedExe = Join-Path $stage "task-handoff-desktop-streaming.exe"
$signScript = Join-Path $PSScriptRoot "sign-windows-artifacts.ps1"
$signParameters = @{ OutputDirectory = $OutputDirectory }
if ($SignDevelopment) { $signParameters.DevelopmentCertificate = $true }
if ($PfxPath) { $signParameters.PfxPath = $PfxPath }
if ($PfxPassword) { $signParameters.PfxPassword = $PfxPassword }
if ($Thumbprint) { $signParameters.Thumbprint = $Thumbprint }
if ($TimestampUrl) { $signParameters.TimestampUrl = $TimestampUrl }
if ($signRequested) {
  $preSignParameters = $signParameters.Clone()
  $preSignParameters.Files = @($stagedExe)
  $preSignParameters.OutputDirectory = Join-Path $OutputDirectory "prepackage-signature"
  & $signScript @preSignParameters
}

$component = [ordered]@{
  name = "task-handoff-desktop-streaming"
  version = $Version
  platform = "win32"
  arch = "x64"
  target = "x86_64-pc-windows-msvc"
  staticCrt = $true
  displayCapture = $true
  windowCapture = $true
  builtAt = (Get-Date).ToUniversalTime().ToString("o")
  sha256 = (Get-FileHash -LiteralPath $stagedExe -Algorithm SHA256).Hash.ToLowerInvariant()
}
$component | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage "component.json") -Encoding UTF8

if (-not $WixBin) {
  $WixBin = $env:WIX_BIN
}
if (-not $WixBin) {
  $candle = Get-Command candle.exe -ErrorAction SilentlyContinue
  if ($candle) { $WixBin = Split-Path -Parent $candle.Source }
}
if (-not $WixBin -or -not (Test-Path -LiteralPath (Join-Path $WixBin "candle.exe"))) {
  throw "WiX 3 is required. Pass -WixBin or set WIX_BIN."
}
$WixBin = (Resolve-Path -LiteralPath $WixBin).Path
$objDir = Join-Path $OutputDirectory "obj/$Version"
New-Item -ItemType Directory -Force -Path $objDir | Out-Null
$wixobj = Join-Path $objDir "product.wixobj"
$msi = Join-Path $OutputDirectory "TaskHandoffRemoteDesktop-$Version-x64.msi"

Write-Output "Compiling MSI"
& (Join-Path $WixBin "candle.exe") -nologo -arch x64 "-dProductVersion=$Version" "-dSourceDir=$stage" -out $wixobj $wxs
if ($LASTEXITCODE -ne 0) { throw "candle.exe failed with exit code $LASTEXITCODE." }
& (Join-Path $WixBin "light.exe") -nologo -out $msi $wixobj
if ($LASTEXITCODE -ne 0) { throw "light.exe failed with exit code $LASTEXITCODE." }

if ($signRequested) {
  $finalSignParameters = $signParameters.Clone()
  $finalSignParameters.Files = @($msi)
  & $signScript @finalSignParameters
}

$installVerified = $false
$uninstallVerified = $false
if (-not $SkipInstallTest) {
  $installDir = Join-Path $env:LOCALAPPDATA "TaskHandoff/RemoteDesktop"
  $installedExe = Join-Path $installDir "task-handoff-desktop-streaming.exe"
  $installLog = Join-Path $OutputDirectory "install-$Version.log"
  $uninstallLog = Join-Path $OutputDirectory "uninstall-$Version.log"
  Write-Output "Installing MSI for current user"
  $install = Start-Process -FilePath (Join-Path $env:WINDIR "System32/msiexec.exe") -ArgumentList @(
    "/i", $msi, "/qn", "/norestart", "/l*v", $installLog
  ) -Wait -PassThru -WindowStyle Hidden
  if ($install.ExitCode -ne 0) { throw "MSI install failed with exit code $($install.ExitCode); see $installLog" }
  if (-not (Test-Path -LiteralPath $installedExe -PathType Leaf)) { throw "MSI did not install the component executable." }
  $installedVersion = (& $installedExe --version | Select-Object -First 1).Trim()
  if ($installedVersion -ne $Version) { throw "Installed component reported '$installedVersion', expected '$Version'." }
  $installedHash = (Get-FileHash -LiteralPath $installedExe -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($installedHash -ne $component.sha256) {
    throw "Installed executable SHA-256 '$installedHash' does not match the staged component '$($component.sha256)'."
  }
  if ($signRequested) {
    $installedSignature = Get-AuthenticodeSignature -LiteralPath $installedExe
    $installedSignatureAccepted = $installedSignature.Status -eq "Valid" -or
      ($SignDevelopment -and $installedSignature.Status -eq "UnknownError" -and $installedSignature.SignerCertificate)
    if (-not $installedSignatureAccepted) {
      throw "Installed executable signature verification failed: $($installedSignature.Status) $($installedSignature.StatusMessage)"
    }
  }
  $installVerified = $true
  Write-Output "Uninstalling MSI"
  $uninstall = Start-Process -FilePath (Join-Path $env:WINDIR "System32/msiexec.exe") -ArgumentList @(
    "/x", $msi, "/qn", "/norestart", "/l*v", $uninstallLog
  ) -Wait -PassThru -WindowStyle Hidden
  if ($uninstall.ExitCode -ne 0) { throw "MSI uninstall failed with exit code $($uninstall.ExitCode); see $uninstallLog" }
  if (Test-Path -LiteralPath $installedExe) { throw "MSI uninstall left the component executable behind." }
  $uninstallVerified = $true
}

$componentSignatureStatus = $null
$msiSignatureStatus = $null
if ($signRequested) {
  $preSignSummary = Get-Content -LiteralPath (Join-Path $OutputDirectory "prepackage-signature/authenticode.json") -Raw | ConvertFrom-Json
  $componentSignatureStatus = [string]$preSignSummary.artifacts[0].status
  $finalSignSummary = Get-Content -LiteralPath (Join-Path $OutputDirectory "authenticode.json") -Raw | ConvertFrom-Json
  $msiSignatureStatus = [string]$finalSignSummary.artifacts[0].status
}

$buildSummary = [ordered]@{
  componentSignatureStatus = $componentSignatureStatus
  msiSignatureStatus = $msiSignatureStatus
  version = $Version
  target = "x86_64-pc-windows-msvc"
  staticCrt = $true
  msi = [System.IO.Path]::GetFileName($msi)
  msiSha256 = (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash.ToLowerInvariant()
  componentSha256 = (Get-FileHash -LiteralPath $stagedExe -Algorithm SHA256).Hash.ToLowerInvariant()
  signed = [bool]$signRequested
  signMode = if ($SignDevelopment) { "development-self-signed" } elseif ($PfxPath) { "pfx" } elseif ($Thumbprint) { "certificate-store" } else { $null }
  componentSigningEvidence = if ($signRequested) { "prepackage-signature/authenticode.json" } else { $null }
  msiSigningEvidence = if ($signRequested) { "authenticode.json" } else { $null }
  installVerified = $installVerified
  uninstallVerified = $uninstallVerified
}
$buildSummary | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory "build.json") -Encoding UTF8
Write-Output "MSI: $msi"
Write-Output "Build evidence: $(Join-Path $OutputDirectory 'build.json')"
