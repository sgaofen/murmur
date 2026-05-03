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
for /f %%v in ('python -c "import sys; print(1 if sys.version_info >= (3, 11) else 0)"') do set PY_OK=%%v
if not "%PY_OK%"=="1" (
    echo [X] Python 版本太老，需要 3.11+
    python --version
    pause
    exit /b 1
)
echo [OK] Python 3.11+ found

REM --- check node ---
where node > nul 2>&1
if errorlevel 1 (
    echo [X] 没找到 Node.js
    echo     请先安装：https://nodejs.org/
    pause
    exit /b 1
)
for /f %%v in ('node -p "Number(process.versions.node.split('.')[0]) >= 18 ? 1 : 0"') do set NODE_OK=%%v
if not "%NODE_OK%"=="1" (
    echo [X] Node.js 版本太老，需要 18+
    node --version
    pause
    exit /b 1
)
echo [OK] Node.js 18+ found

REM --- install python deps if needed ---
python -c "import zstandard, cryptography, Crypto" 2>nul
if errorlevel 1 (
    echo [...] 装 Python 依赖（zstandard + cryptography + pycryptodome；语音转写依赖可之后单独安装）...
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
start "Murmur Frontend" /min cmd /c "cd /d app && npm run dev -- --host 127.0.0.1"
timeout /t 5 /nobreak > nul

REM --- open browser ---
echo.
echo  ✓ 启动完成！正在打开浏览器…
echo.
echo  后端: http://127.0.0.1:9100
echo  前端: http://127.0.0.1:5173
echo.
echo  关闭此窗口不会停止服务，要停服务关掉那两个 cmd 窗口
echo.
start "" "http://127.0.0.1:5173"
pause
