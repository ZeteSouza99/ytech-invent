param(
  [switch]$Offline,
  [string]$Architectures = 'arm64-v8a,armeabi-v7a'
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$buildRoot = Join-Path $env:TEMP 'yi-apk'
$gradleCache = Join-Path $env:TEMP 'yi-gradle'
$androidUser = Join-Path $gradleCache 'android'

function Copy-BuildTree([string]$Source, [string]$Destination, [string[]]$Exclude = @()) {
  $arguments = @($Source, $Destination, '/E', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  if ($Exclude.Count) { $arguments += '/XD'; $arguments += $Exclude }
  & robocopy @arguments | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Falha ao preparar $Source" }
}

New-Item -ItemType Directory -Force -Path $buildRoot,$gradleCache,$androidUser | Out-Null
Write-Host '[1/4] Preparando codigo e arquivos Android...'
foreach ($directory in @('src','shared','modules','plugins','assets','android')) {
  Copy-BuildTree (Join-Path $projectRoot $directory) (Join-Path $buildRoot $directory) @('build','.gradle','.cxx')
}
foreach ($filename in @('App.tsx','index.ts','app.config.ts','metro.config.cjs','package.json','package-lock.json','tsconfig.json')) {
  Copy-Item -LiteralPath (Join-Path $projectRoot $filename) -Destination $buildRoot
}
# Only the public Google client ID belongs in this Android build.
$clientLine = Get-Content -LiteralPath (Join-Path $projectRoot '.env') | Where-Object { $_ -match '^EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=' } | Select-Object -First 1
if (!$clientLine) { throw 'Configure EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID em .env.' }
Set-Content -LiteralPath (Join-Path $buildRoot '.env') -Value $clientLine -Encoding utf8
Write-Host '[2/4] Preparando dependencias. Esta etapa pode levar alguns minutos...'
Copy-BuildTree (Join-Path $projectRoot 'node_modules') (Join-Path $buildRoot 'node_modules') @('.gradle','.cxx')

if (!(Test-Path (Join-Path $gradleCache 'wrapper'))) {
  $existingCache = @('C:\YtechBuild\.g', (Join-Path $env:USERPROFILE '.gradle')) | Where-Object { Test-Path (Join-Path $_ 'wrapper') } | Select-Object -First 1
  if ($existingCache) { Copy-BuildTree $existingCache $gradleCache @('daemon','.tmp') }
}
$jdk = Join-Path $projectRoot '.tools\jdk\jdk-17.0.16'
if (Test-Path (Join-Path $jdk 'bin\java.exe')) { $env:JAVA_HOME = $jdk }
if (!$env:JAVA_HOME) { throw 'Defina JAVA_HOME com um JDK 17.' }
$env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$env:ANDROID_USER_HOME = $androidUser
$env:GRADLE_USER_HOME = $gradleCache
$env:GRADLE_OPTS = "-Duser.home=$gradleCache"
$env:NODE_ENV = 'production'
$env:CI = '1'
$env:EXPO_NO_TELEMETRY = '1'
$env:EXPO_OFFLINE = '1'
$env:EXPO_PUBLIC_RECORD_SCANS = 'false'
$env:JAVA_TOOL_OPTIONS = "-Duser.home=$gradleCache"
$gradleArgs = @(':app:assembleRelease', "-PreactNativeArchitectures=$Architectures", '-Pkotlin.compiler.execution.strategy=in-process', '--no-daemon', '--console=plain', '--max-workers=2')
if ($Offline) { $gradleArgs += '--offline' }
$log = Join-Path $buildRoot 'build-release.log'
Write-Host "[3/4] Compilando APK release. Log: $log"
Push-Location (Join-Path $buildRoot 'android')
try {
  # Windows PowerShell 5 treats native stderr as ErrorRecord. Let Gradle's
  # exit code determine success while streaming both outputs to the screen.
  $previousErrorPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & .\gradlew.bat @gradleArgs 2>&1 | Tee-Object -FilePath $log
  } finally { $ErrorActionPreference = $previousErrorPreference }
  if ($LASTEXITCODE -ne 0) {
    Get-Content -LiteralPath $log -Tail 100
    throw "Compilacao falhou. Log: $log"
  }
} finally { Pop-Location }
$apk = Join-Path $buildRoot 'android\app\build\outputs\apk\release\app-release.apk'
if (!(Test-Path $apk)) { throw 'O Gradle terminou sem produzir o APK esperado.' }
$output = Join-Path $projectRoot 'artifacts'
Write-Host '[4/4] Copiando APK para a pasta artifacts...'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$version = (Get-Content (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
$destination = Join-Path $output "YtechInvent-$version.apk"
Copy-Item -LiteralPath $apk -Destination $destination
Write-Output "APK pronto: $destination"
Get-FileHash -LiteralPath $destination -Algorithm SHA256 | Format-List
