param(
  [string]$Directory = (Join-Path $env:USERPROFILE '.ytech-invent'),
  [string]$Alias = 'ytech-invent'
)
# Creates the private key that replaces the public debug key used to sign the APKs so far.
# The keystore and its settings stay outside the project and OneDrive; the password is typed by you and never stored.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$bundled = Join-Path $projectRoot '.tools\jdk\jdk-17.0.16\bin\keytool.exe'
$keytool = if (Test-Path -LiteralPath $bundled) { $bundled }
  elseif ($env:JAVA_HOME -and (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin\keytool.exe'))) { Join-Path $env:JAVA_HOME 'bin\keytool.exe' }
  else { (Get-Command keytool -ErrorAction Stop).Source }
$keystore = Join-Path $Directory 'ytech-invent-release.jks'
if (Test-Path -LiteralPath $keystore) { throw "Ja existe uma keystore em $keystore. Chaves de assinatura nunca sao sobrescritas." }
New-Item -ItemType Directory -Force -Path $Directory | Out-Null

Write-Host 'O keytool vai pedir uma senha (minimo 6 caracteres) duas vezes.'
Write-Host 'Guarde a senha num gerenciador de senhas: sem ela e sem este arquivo nao ha como atualizar o app instalado.'
& $keytool -genkeypair -v -storetype PKCS12 -keystore $keystore -alias $Alias -keyalg RSA -keysize 4096 -validity 10000 -dname 'CN=Ytech Invent, O=Ytech Solucoes, C=BR'
if ($LASTEXITCODE -ne 0) { throw 'O keytool nao criou a chave.' }
@{ storeFile = $keystore; keyAlias = $Alias } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Directory 'release-signing.json') -Encoding utf8

Write-Host ''
Write-Host 'Impressoes digitais da chave nova (o keytool pede a senha de novo):'
& $keytool -list -v -keystore $keystore -alias $Alias | Select-String -Pattern 'SHA1:|SHA256:'
Write-Host ''
Write-Host 'Proximos passos (README > Assinatura):'
Write-Host "1. Copie $keystore para um local seguro fora deste computador."
Write-Host '2. Cadastre o SHA-1 acima no cliente OAuth Android do Google Cloud, sem remover o atual ainda.'
Write-Host '3. Siga a migracao descrita no README antes de usar scripts\build-apk.ps1 -ReleaseKey.'
