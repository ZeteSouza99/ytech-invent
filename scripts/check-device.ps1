$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
if (!(Test-Path -LiteralPath $adb)) { throw 'ADB nao encontrado no SDK Android.' }
$deviceOutput = & $adb devices
if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel consultar os dispositivos pelo ADB.' }
$connected = @($deviceOutput | Where-Object { $_ -match '^\S+\s+device$' } | ForEach-Object { ($_ -split '\s+')[0] })
if ($connected.Count -ne 1) { throw 'Conecte exatamente um aparelho e autorize a depuracao USB na tela dele.' }
$serial = $connected[0]
function Invoke-Device([string[]]$DeviceArguments) {
  $result = & $adb -s $serial @DeviceArguments
  if ($LASTEXITCODE -ne 0) { throw "Falha no comando ADB: $($DeviceArguments -join ' ')" }
  return $result
}
$output = Join-Path $projectRoot 'artifacts\device-check'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$package = 'com.ytechsolucoes.invent'
$packageInfo = Invoke-Device -DeviceArguments @('shell','dumpsys','package',$package)
if (!($packageInfo -match 'versionName=')) { throw 'O Ytech Invent nao esta instalado neste aparelho.' }
$report = [ordered]@{
  model = (Invoke-Device -DeviceArguments @('shell','getprop','ro.product.model')) -join "`n"
  android = (Invoke-Device -DeviceArguments @('shell','getprop','ro.build.version.release')) -join "`n"
  screen = (Invoke-Device -DeviceArguments @('shell','wm','size')) -join "`n"
  density = (Invoke-Device -DeviceArguments @('shell','wm','density')) -join "`n"
  fontScale = (Invoke-Device -DeviceArguments @('shell','settings','get','system','font_scale')) -join "`n"
  version = ($packageInfo | Select-String -Pattern 'versionCode=|versionName=' | ForEach-Object { $_.Line.Trim() }) -join "`n"
}
$report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'device.json') -Encoding utf8
Write-Host 'Mantenha o aparelho desbloqueado. Abrindo Ytech Invent...'
Invoke-Device -DeviceArguments @('shell','am','start','-W','-n',"$package/.MainActivity") | Out-Null
Start-Sleep -Seconds 2
$focus = Invoke-Device -DeviceArguments @('shell','dumpsys','window')
if (!(($focus | Select-String -Pattern 'mCurrentFocus=|mFocusedApp=') -match [regex]::Escape($package))) {
  throw 'O app nao esta em primeiro plano. Desbloqueie o aparelho, abra Ytech Invent e tente novamente.'
}
$remotePrefix = '/data/local/tmp/ytech-check-' + [guid]::NewGuid().ToString('N')
try {
  Invoke-Device -DeviceArguments @('shell','screencap','-p',"$remotePrefix.png") | Out-Null
  Invoke-Device -DeviceArguments @('pull',"$remotePrefix.png",(Join-Path $output 'screen.png')) | Out-Null
  Invoke-Device -DeviceArguments @('shell','uiautomator','dump',"$remotePrefix.xml") | Out-Null
  Invoke-Device -DeviceArguments @('pull',"$remotePrefix.xml",(Join-Path $output 'screen.xml')) | Out-Null
} finally {
  & $adb -s $serial shell rm -f "$remotePrefix.png" "$remotePrefix.xml" | Out-Null
}
Write-Host "Conferencia salva em: $output"
$report | ConvertTo-Json
