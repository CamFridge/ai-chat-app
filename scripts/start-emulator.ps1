# 启动无窗口 Android 模拟器（状态目录放在工程内可写位置，避免 ~/.android 权限问题）
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot          # ai-chat-app
$sdk  = Join-Path $root 'tools\android-sdk'
$tmp  = Join-Path $root 'build\tmp'

$env:ANDROID_SDK_ROOT = $sdk
$env:ANDROID_HOME     = $sdk
$env:ANDROID_USER_HOME    = Join-Path $tmp 'android-home'
$env:ANDROID_EMULATOR_HOME = Join-Path $tmp 'android-home'
$env:ANDROID_AVD_HOME     = Join-Path $tmp 'android-home\avd'
$env:TEMP = Join-Path $tmp 'adb'
$env:TMP  = Join-Path $tmp 'adb'
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null

$adb = Join-Path $sdk 'platform-tools\adb.exe'
$emu = Join-Path $sdk 'emulator\emulator.exe'
& $adb start-server 2>&1 | Out-Null
& $adb devices

& $emu -avd probe33 -no-window -no-audio -no-boot-anim -no-snapshot -no-metrics `
      -gpu swiftshader_indirect -memory 2048 -cores 2 -netdelay none -netspeed full `
      -verbose 2>&1 | ForEach-Object { $_ }
