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

where git > nul 2>&1
if errorlevel 1 (
    echo [X] 没找到 git
    echo     先装：https://git-scm.com/download/win
    pause
    exit /b 1
)

where node > nul 2>&1
if errorlevel 1 (
    echo [X] 没找到 Node.js
    echo     先装：https://nodejs.org/
    pause
    exit /b 1
)

set "GH=gh"
where gh > nul 2>&1
if errorlevel 1 (
    if exist "C:\Program Files\GitHub CLI\gh.exe" (
        set "GH=C:\Program Files\GitHub CLI\gh.exe"
    )
)
where "%GH%" > nul 2>&1
if errorlevel 1 if not exist "%GH%" (
    echo [X] 没找到 gh CLI
    echo     先装：winget install GitHub.cli
    pause
    exit /b 1
)

for /f %%v in ('node -p "require('./app/package.json').version"') do set VERSION=%%v
set TAG=v%VERSION%

echo  ⚠ 高风险操作：这个脚本会把当前 git 仓库推送到 GitHub，并创建公开 Release。
echo     运行前请确认：
echo       - 没有把私人聊天数据、密钥、解密数据库加入 git
echo       - 你真的要发布 %TAG%
echo.
set /p CONFIRM=请输入 %TAG% 继续，其他内容取消：
if not "%CONFIRM%"=="%TAG%" (
    echo 已取消。
    pause
    exit /b 1
)

git status --short
echo.
set /p CONFIRM_DIRTY=上面是当前 git 状态。继续推送？输入 PUSH：
if not "%CONFIRM_DIRTY%"=="PUSH" (
    echo 已取消。
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
echo [3/3] 上传 Release 安装包（%TAG%）...
echo.
if exist "app\src-tauri\target\release\bundle\msi\Murmur_%VERSION%_x64_en-US.msi" (
    set MSI=app\src-tauri\target\release\bundle\msi\Murmur_%VERSION%_x64_en-US.msi
) else (
    set MSI=
)
if exist "app\src-tauri\target\release\bundle\nsis\Murmur_%VERSION%_x64-setup.exe" (
    set NSIS=app\src-tauri\target\release\bundle\nsis\Murmur_%VERSION%_x64-setup.exe
) else (
    set NSIS=
)

if "%MSI%%NSIS%"=="" (
    echo [X] 没找到 %VERSION% 的 Windows 安装包。
    echo     先在 Windows 上运行：cd app ^&^& npm run tauri:build
    pause
    exit /b 1
)

"%GH%" release create %TAG% %MSI% %NSIS% ^
    --title "Murmur %TAG%" ^
    --notes "Release %TAG%。安装和隐私说明见 README.md、docs/ONBOARDING_WINDOWS.md、docs/PRIVACY.md。"

echo.
echo  ✓ 完成！打开 https://github.com/sgaofen/murmur
echo.
start "" "https://github.com/sgaofen/murmur"
pause
