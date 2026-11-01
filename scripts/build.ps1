# AI 聊天 Android APK 构建脚本（手工管线：aapt2 + javac + d8 + zipalign + apksigner）
# 无需 Gradle / AndroidX / 任何第三方依赖
param(
    [switch]$Clean,
    [switch]$SkipSign,
    [switch]$DebugMode
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$AndroidDir = Join-Path $Root 'android'
$Sdk = Join-Path $Root 'tools/android-sdk'
$BuildTools = Join-Path $Sdk 'build-tools/34.0.0'
$AndroidJar = Join-Path $Sdk 'platforms/android-34/android.jar'

if (-not (Test-Path $AndroidJar)) {
    throw "找不到 Android SDK：$Sdk`n请先运行 scripts/setup-sdk.ps1"
}

$JavaHome = $env:JAVA_HOME
if (-not $JavaHome -or -not (Test-Path (Join-Path $JavaHome 'bin/javac.exe'))) {
    $candidates = @(
        'C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot',
        'C:\Program Files\Java\jdk-17',
        'C:\Program Files\Android\Android Studio\jbr'
    )
    foreach ($c in $candidates) {
        if (Test-Path (Join-Path $c 'bin/javac.exe')) { $JavaHome = $c; break }
    }
}
if (-not $JavaHome) { throw '找不到 JDK 17（请设置 JAVA_HOME）' }

$Javac = Join-Path $JavaHome 'bin/javac.exe'
$Keytool = Join-Path $JavaHome 'bin/keytool.exe'
$env:PATH = (Join-Path $JavaHome 'bin') + ';' + $env:PATH
$env:JAVA_HOME = $JavaHome

$Build = Join-Path $Root 'build'
$VersionCode = '5'
$VersionName = '1.2.1'
$Gen = Join-Path $Build 'gen'
$Classes = Join-Path $Build 'classes'
$DexDir = Join-Path $Build 'dex'
$ResZip = Join-Path $Build 'res.zip'
$BaseApk = Join-Path $Build 'base.apk'
$Unsigned = Join-Path $Build 'unsigned.apk'
$Aligned = Join-Path $Build 'aligned.apk'
$OutApk = Join-Path $Build ("AI-Chat-$VersionName" + $(if ($DebugMode) { '-debug.apk' } else { '.apk' }))
$Keystore = Join-Path $Root 'keystore/aichat-release.jks'
$KsAlias = 'aichat'
$KsPass = 'aichat2026'

if ($Clean) {
    if (Test-Path $Build) { Remove-Item $Build -Recurse -Force }
}
New-Item -ItemType Directory -Force -Path $Build, $Gen, $Classes, $DexDir, (Join-Path $Root 'keystore') | Out-Null

$Aapt2 = Join-Path $BuildTools 'aapt2.exe'
$D8 = Join-Path $BuildTools 'd8.bat'
$ZipAlign = Join-Path $BuildTools 'zipalign.exe'
$ApkSigner = Join-Path $BuildTools 'apksigner.bat'

function Step($name) { Write-Host "==> $name" -ForegroundColor Cyan }
function Run($exe, $arguments) {
    & $exe @arguments
    if ($LASTEXITCODE -ne 0) { throw "命令失败（exit $LASTEXITCODE）：$exe $($arguments -join ' ')" }
}

# ---------- 1. 编译资源 ----------
Step 'aapt2 compile'
if (Test-Path $ResZip) { Remove-Item $ResZip -Force }
$resDir = Join-Path $AndroidDir 'res'
Run $Aapt2 @('compile', '--dir', $resDir, '-o', $ResZip)

# ---------- 2. 链接资源 + 生成 R.java ----------
Step 'aapt2 link'
if (Test-Path $BaseApk) { Remove-Item $BaseApk -Force }
if (Test-Path $Gen) { Remove-Item $Gen -Recurse -Force; New-Item -ItemType Directory -Force -Path $Gen | Out-Null }
$manifest = Join-Path $AndroidDir 'AndroidManifest.xml'
$assets = Join-Path $AndroidDir 'assets'
$linkArgs = @('link', '-o', $BaseApk, '-I', $AndroidJar, '--manifest', $manifest,
    '-R', $ResZip, '--java', $Gen, '--min-sdk-version', '26', '--target-sdk-version', '34',
    '--version-code', $VersionCode, '--version-name', $VersionName, '-A', $assets, '--auto-add-overlay')
if ($DebugMode) { $linkArgs += '--debug-mode' }
Run $Aapt2 $linkArgs

# ---------- 3. 编译 Java ----------
Step 'javac'
if (Test-Path $Classes) { Remove-Item $Classes -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Classes | Out-Null
$sources = @()
$sources += Get-ChildItem -Path (Join-Path $AndroidDir 'src') -Recurse -Filter *.java | ForEach-Object { $_.FullName }
$sources += Get-ChildItem -Path $Gen -Recurse -Filter *.java | ForEach-Object { $_.FullName }
$srcList = Join-Path $Build 'sources.txt'
# javac 的 @argfile 会把反斜杠当转义符，这里统一改成正斜杠
($sources | ForEach-Object { '"' + ($_ -replace '\\', '/') + '"' }) -join "`r`n" | Set-Content -Path $srcList -Encoding ASCII
Run $Javac @('-encoding', 'UTF-8', '-source', '8', '-target', '8', '-Xlint:-options',
    '-bootclasspath', $AndroidJar, '-d', $Classes, "@$srcList")

# ---------- 4. dex ----------
Step 'd8'
if (Test-Path $DexDir) { Remove-Item $DexDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $DexDir | Out-Null
$classFiles = Get-ChildItem -Path $Classes -Recurse -Filter *.class | ForEach-Object { $_.FullName }
if ($classFiles.Count -eq 0) { throw '没有编译出 class 文件' }
$d8Args = @('--release', '--min-api', '26', '--lib', $AndroidJar, '--output', $DexDir) + $classFiles
Run $D8 $d8Args

# ---------- 5. 打包 classes.dex 进 APK ----------
Step 'pack classes.dex'
Copy-Item $BaseApk $Unsigned -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($Unsigned, 'Update')
try {
    $dex = Join-Path $DexDir 'classes.dex'
    if (-not (Test-Path $dex)) { throw 'd8 没有生成 classes.dex' }
    $entry = $zip.CreateEntry('classes.dex', [System.IO.Compression.CompressionLevel]::Optimal)
    $es = $entry.Open()
    $fs = [System.IO.File]::OpenRead($dex)
    try { $fs.CopyTo($es) } finally { $fs.Dispose(); $es.Dispose() }
} finally {
    $zip.Dispose()
}

# ---------- 6. 对齐 ----------
Step 'zipalign'
if (Test-Path $Aligned) { Remove-Item $Aligned -Force }
Run $ZipAlign @('-f', '4', $Unsigned, $Aligned)

# ---------- 7. 签名 ----------
if (-not $SkipSign) {
    if (-not (Test-Path $Keystore)) {
        Step '生成签名 keystore'
        Run $Keytool @('-genkeypair', '-v', '-keystore', $Keystore, '-alias', $KsAlias,
            '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
            '-storepass', $KsPass, '-keypass', $KsPass,
            '-dname', 'CN=AI Chat, OU=Mobile, O=AiChat, L=Shenzhen, ST=Guangdong, C=CN')
    }
    Step 'apksigner sign（V1+V2+V3）'
    if (Test-Path $OutApk) { Remove-Item $OutApk -Force }
    Run $ApkSigner @('sign', '--ks', $Keystore, '--ks-key-alias', $KsAlias,
        '--ks-pass', "pass:$KsPass", '--key-pass', "pass:$KsPass",
        '--v1-signing-enabled', 'true', '--v2-signing-enabled', 'true', '--v3-signing-enabled', 'true',
        '--out', $OutApk, $Aligned)

    Step 'apksigner verify'
    & $ApkSigner verify --verbose --print-certs $OutApk
    if ($LASTEXITCODE -ne 0) { throw 'APK 签名校验失败' }
    $final = $OutApk
} else {
    $final = $Aligned
}

# ---------- 8. 结果 ----------
$fi = Get-Item $final
$hash = (Get-FileHash $final -Algorithm SHA256).Hash
Write-Host ''
Write-Host '================ 构建成功 ================' -ForegroundColor Green
Write-Host ("APK   : " + $fi.FullName)
Write-Host ("大小  : " + [math]::Round($fi.Length / 1MB, 2) + " MB (" + $fi.Length + " bytes)")
Write-Host ("SHA256: " + $hash)
Write-Host ("JDK   : " + $JavaHome)
Write-Host ("SDK   : " + $Sdk)
Write-Host '=========================================' -ForegroundColor Green
