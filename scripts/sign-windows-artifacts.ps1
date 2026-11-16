[CmdletBinding(DefaultParameterSetName = "CertificateFile")]
param(
  [Parameter(Mandatory = $true)]
  [string[]]$Files,

  [string]$OutputDirectory = "",

  [Parameter(ParameterSetName = "CertificateFile")]
  [string]$PfxPath,

  [Parameter(ParameterSetName = "CertificateFile")]
  [string]$PfxPassword,

  [Parameter(ParameterSetName = "CertificateStore")]
  [string]$Thumbprint,

  [Parameter(Mandatory = $true, ParameterSetName = "Development")]
  [switch]$DevelopmentCertificate,

  [string]$CertificateSubject = "CN=TaskHandoff Development Code Signing",
  [string]$TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) "release/windows"
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$resolvedFiles = @()
foreach ($file in $Files) {
  $resolved = (Resolve-Path -LiteralPath $file -ErrorAction Stop).Path
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
    throw "Signing input is not a file: $file"
  }
  $resolvedFiles += $resolved
}

function Add-CurrentUserCertificateStore {
  param(
    [Parameter(Mandatory = $true)][System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate,
    [Parameter(Mandatory = $true)][string]$Name
  )
  $store = [System.Security.Cryptography.X509Certificates.X509Store]::new($Name, "CurrentUser")
  try {
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    if (-not ($store.Certificates | Where-Object Thumbprint -eq $Certificate.Thumbprint)) {
      $store.Add($Certificate)
    }
  } finally {
    $store.Close()
  }
}

$mode = ""
$certificate = $null
if ($DevelopmentCertificate) {
  $mode = "development-self-signed"
  $certificate = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.Subject -eq $CertificateSubject -and $_.NotAfter -gt (Get-Date).AddDays(7) } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1
  if (-not $certificate) {
    $certificate = New-SelfSignedCertificate `
      -Type CodeSigningCert `
      -Subject $CertificateSubject `
      -KeyAlgorithm RSA `
      -KeyLength 3072 `
      -HashAlgorithm SHA256 `
      -CertStoreLocation Cert:\CurrentUser\My `
      -NotAfter (Get-Date).AddYears(2) `
      -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3")
  }
  if (-not $certificate.HasPrivateKey) {
    throw "The development signing certificate has no private key."
  }
  # Writing the current-user Root store requires an interactive consent
  # dialog on supported Windows versions, so a headless pipeline cannot
  # install the development root. The verification below records the
  # self-signed chain explicitly instead of claiming OS-level trust.
  Add-CurrentUserCertificateStore -Certificate $certificate -Name "TrustedPublisher"
} elseif ($PfxPath) {
  $mode = "pfx"
  $resolvedPfx = (Resolve-Path -LiteralPath $PfxPath -ErrorAction Stop).Path
  $parameters = @{ FilePath = $resolvedPfx }
  if ($PfxPassword) {
    $parameters.Password = ConvertTo-SecureString -String $PfxPassword -AsPlainText -Force
  }
  $certificate = Get-PfxCertificate @parameters
} elseif ($Thumbprint) {
  $mode = "certificate-store"
  $normalized = $Thumbprint -replace "\s", ""
  $certificate = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $normalized } | Select-Object -First 1
  if (-not $certificate) {
    throw "Code-signing certificate $normalized was not found in CurrentUser\My."
  }
} else {
  throw "Provide -PfxPath, -Thumbprint, or -DevelopmentCertificate."
}

if (-not $certificate.HasPrivateKey) {
  throw "The selected code-signing certificate has no private key."
}

$results = @()
foreach ($file in $resolvedFiles) {
  $parameters = @{
    FilePath = $file
    Certificate = $certificate
    HashAlgorithm = "SHA256"
  }
  if (-not $DevelopmentCertificate -and $TimestampUrl) {
    $parameters.TimestampServer = $TimestampUrl
  }
  $signature = Set-AuthenticodeSignature @parameters
  $verified = Get-AuthenticodeSignature -LiteralPath $file
  $status = [string]$verified.Status
  $trust = "trusted"
  if ($status -ne "Valid") {
    $untrustedDevelopmentRoot = $DevelopmentCertificate -and
      $verified.SignerCertificate -and
      $verified.SignerCertificate.Thumbprint -eq $certificate.Thumbprint -and
      $status -eq "UnknownError"
    if (-not $untrustedDevelopmentRoot) {
      throw "Authenticode verification failed for $file`: $status $($verified.StatusMessage)"
    }
    $trust = "self-signed-development-untrusted-root"
    $status = "ValidSignatureUntrustedDevelopmentRoot"
  }
  $results += [ordered]@{
    path = [System.IO.Path]::GetFileName($file)
    sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    status = $status
    trust = $trust
    statusMessage = [string]$verified.StatusMessage
    signerSubject = $verified.SignerCertificate.Subject
    signerThumbprint = $verified.SignerCertificate.Thumbprint
  }
}

$developmentCertificatePath = Join-Path $OutputDirectory "TaskHandoffDevelopmentCodeSigning.cer"
if ($DevelopmentCertificate) {
  Export-Certificate -Cert $certificate -FilePath $developmentCertificatePath -Type CERT | Out-Null
}

$summary = [ordered]@{
  mode = $mode
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  certificateSubject = $certificate.Subject
  certificateThumbprint = $certificate.Thumbprint
  certificateNotAfter = $certificate.NotAfter.ToUniversalTime().ToString("o")
  developmentCertificate = if ($DevelopmentCertificate) { [System.IO.Path]::GetFileName($developmentCertificatePath) } else { $null }
  artifacts = $results
}
$summaryPath = Join-Path $OutputDirectory "authenticode.json"
$summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $summaryPath -Encoding UTF8
Write-Output "Verified Authenticode signatures for $($results.Count) artifact(s); evidence: $summaryPath"
