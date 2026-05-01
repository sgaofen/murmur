@echo off
setlocal enabledelayedexpansion
chcp 65001 > nul
title Murmur 微语 — 启动器

echo.
echo  ╔════════════════════════════════════════╗
echo  ║                                        ║
echo  ║      Murmur 微语 · 你的微信故事          ║
echo  ║                                        ║
echo  ╚════════════════════════════════════════╝
echo.

cd /d "%~dp0"

REM --- check python ---
where python > nul 2>&1
if errorlevel 1 (
    echo [X] 没找到 Python 3.11+
    echo     请先安装：https://www.python.org/downloads/
    echo     选「Add Python to PATH」
    pause
    exit /b 1
)
echo [OK] Python found

REM --- check node ---
where node > nul 2>&1
if errorlevel 1 (
    echo [X] 没找到 Node.js
    echo     请先安装：https://nodejs.org/
    pause
    exit /b 1
)
echo [OK] Node.js found

REM --- install python deps if needed ---
python -c "import zstandard, cryptography" 2>nul
if errorlevel 1 (
    echo [...] 装 Python 依赖（zstandard + cryptography + faster-whisper 可选）...
    python -m pip install -r requirements.txt
    if errorlevel 1 (
        echo [X] pip install 失败
        pause
        exit /b 1
    )
)
echo [OK] Python deps ready

REM --- install node deps if needed ---
if not exist "app\node_modules" (
    echo [...] 装 Node 依赖（首次需要 ~1 分钟）...
    pushd app
    call npm install
    if errorlevel 1 (
        popd
        echo [X] npm install 失败
        pause
        exit /b 1
    )
    popd
)
echo [OK] Node deps ready

REM --- launch backend ---
echo [...] 启动后端 (etcli serve)...
start "Murmur Backend" /min cmd /c "cd /d cli && python etcli.py serve --port 9100"
timeout /t 3 /nobreak > nul

REM --- launch frontend ---
echo [...] 启动前端 (vite dev)...
start "Murmur Frontend" /min cmd /c "cd /d app && npm run dev"
timeout /t 5 /nobreak > nul

REM --- open browser ---
echo.
echo  ✓ 启动完成！正在打开浏览器…
echo.
echo  后端: http://localhost:9100
echo  前端: http://localhost:5173
echo.
echo  关闭此窗口不会停止服务，要停服务关掉那两个 cmd 窗口
echo.
start "" "http://localhost:5173"
pause
