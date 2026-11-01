# 安装 Android 构建所需的最小 SDK（cmdline-tools + platforms;android-34 + build-tools;34.0.0 + platform-tools）
# 仅首次构建前需要执行。
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root "tools"
$sdk = Join-Path $tools "android-sdk"
$zip = Join-Path $tools "cmdline-tools.zip"
$tmp = Join-Path $tools "cmdline-tools-tmp"

New-Item -ItemType Directory -Force -Path $tools | Out-Null
New-Item -ItemType Directory -Force -Path $sdk | Out-Null

if (-not (Test-Path (Join-Path $sdk "cmdline-tools\latest\bin\sdkmanager.bat"))) {
  Write-Host "[1/4] 下载 commandline-tools ..."
  # 使用 Windows 自带 curl.exe，避免 Invoke-WebRequest 在大文件上慢
  & curl.exe -L --fail --retry 3 -o $zip "https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip"
  if ($LASTEXITCODE -ne 0) { throw "下载 commandline-tools 失败" }

  Write-Host "[2/4] 解压 ..."
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $sdk "cmdline-tools") | Out-Null
  if (Test-Path (Join-Path $sdk "cmdline-tools\latest")) { Remove-Item (Join-Path $sdk "cmdline-tools\latest") -Recurse -Force }
  Move-Item (Join-Path $tmp "cmdline-tools") (Join-Path $sdk "cmdline-tools\latest")
  Remove-Item $tmp -Recurse -Force
  Remove-Item $zip -Force
} else {
  Write-Host "[1/4] commandline-tools 已存在，跳过下载"
}

$sdkmanager = Join-Path $sdk "cmdline-tools\latest\bin\sdkmanager.bat"
Write-Host "[3/4] 接受许可协议 ..."
$yes = ("y`n" * 60)
$yes | & $sdkmanager --sdk_root=$sdk --licenses 2>&1 | Out-Host

Write-Host "[4/4] 安装平台与构建工具 ..."
& $sdkmanager --sdk_root=$sdk "platforms;android-34" "build-tools;34.0.0" "platform-tools" 2>&1 | Out-Host

Write-Host "SDK 安装完成：$sdk"
Get-ChildItem (Join-Path $sdk "build-tools") -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "build-tools: $($_.Name)" }
Get-ChildItem (Join-Path $sdk "platforms") -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "platform: $($_.Name)" }
