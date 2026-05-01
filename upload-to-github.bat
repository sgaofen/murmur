@echo off
chcp 65001 > nul
title Murmur — 上传到 GitHub

echo.
echo  ╔════════════════════════════════════════════╗
echo  ║                                            ║
echo  ║   Murmur · 一键上传到 GitHub               ║
echo  ║                                            ║
echo  ╚════════════════════════════════════════════╝
echo.

cd /d "%~dp0"

set "GH=C:\Program Files\GitHub CLI\gh.exe"
if not exist "%GH%" (
    echo [X] 没找到 gh CLI
    echo     先装：winget install GitHub.cli
    pause
    exit /b 1
)

echo [1/3] 登录 GitHub（会自动开浏览器）...
echo.
echo  ⚠ 请按以下步骤：
echo     1. 跟屏幕提示按 Enter，会显示一个 8 位字符码
echo     2. 浏览器会弹出，把那 8 位码粘进去
echo     3. 点 Authorize 即可
echo.
"%GH%" auth login --hostname github.com --git-protocol https --web
if errorlevel 1 (
    echo.
    echo [X] 登录失败
    pause
    exit /b 1
)

echo.
echo [2/3] 创建仓库 sgaofen/murmur 并推送...
echo.
"%GH%" repo create sgaofen/murmur --public --source=. --remote=origin --push --description "Murmur 微语 — 你的微信社交故事，100%% 本地"
if errorlevel 1 (
    echo.
    echo  ⚠ repo 可能已存在；尝试只推送...
    git remote add origin https://github.com/sgaofen/murmur.git 2>nul
    git push -u origin main
    if errorlevel 1 (
        echo [X] 推送失败
        pause
        exit /b 1
    )
)

echo.
echo [3/3] 上传 Release 安装包（v0.1.0）...
echo.
"%GH%" release create v0.1.0 ^
    "app\src-tauri\target\release\bundle\msi\Murmur_0.1.0_x64_en-US.msi" ^
    "app\src-tauri\target\release\bundle\nsis\Murmur_0.1.0_x64-setup.exe" ^
    --title "Murmur v0.1.0 — Windows" ^
    --notes "首发 Windows 版。Mac dmg 等下次构建。详细安装指南：docs/ONBOARDING_WINDOWS.md"

echo.
echo  ✓ 完成！打开 https://github.com/sgaofen/murmur
echo.
start "" "https://github.com/sgaofen/murmur"
pause
