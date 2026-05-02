#!/bin/bash
# Murmur 微语 — Mac launcher
# Double-click in Finder (or run: bash start-mac.sh)

set -e

cd "$(dirname "$0")"

echo ""
echo "  ╔════════════════════════════════════════╗"
echo "  ║      Murmur 微语 · 你的微信故事          ║"
echo "  ╚════════════════════════════════════════╝"
echo ""

# --- pick Python (require 3.11+; system python3 on macOS is often 3.9) ---
PY=""
for cand in python3.13 python3.12 python3.11 python3; do
    if command -v "$cand" > /dev/null 2>&1; then
        ver=$("$cand" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)
        major=${ver%%.*}; minor=${ver##*.}
        if [ "$major" = "3" ] && [ "$minor" -ge 11 ] 2>/dev/null; then
            PY="$cand"
            break
        fi
    fi
done
if [ -z "$PY" ]; then
    echo "[X] 没找到 Python 3.11+"
    echo "    安装：brew install python@3.12"
    read -n 1
    exit 1
fi
echo "[OK] Python found ($($PY --version) at $(command -v $PY))"

# --- check node ---
if ! command -v node > /dev/null; then
    echo "[X] 没找到 node"
    echo "    安装：brew install node"
    read -n 1
    exit 1
fi
NODE_MAJOR=$(node --version | sed 's/v//' | cut -d . -f 1)
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo "[X] Node.js 版本太老，需要 18+"
    echo "    当前版本：$(node --version)"
    echo "    升级：brew upgrade node"
    read -n 1
    exit 1
fi
echo "[OK] Node found ($(node --version))"

# --- install python deps ---
if ! $PY -c "import zstandard, cryptography" 2>/dev/null; then
    echo "[...] 装 Python 依赖..."
    $PY -m pip install --user -r requirements.txt
fi
echo "[OK] Python deps ready"

# --- install node deps ---
if [ ! -d "app/node_modules" ]; then
    echo "[...] 装 Node 依赖（首次约 1 分钟）..."
    (cd app && npm install)
fi
echo "[OK] Node deps ready"

# --- check decrypted data ---
if [ ! -d "$HOME/Documents/Murmur/decrypted" ] && [ ! -d "$HOME/Documents/EchoTrace" ]; then
    echo ""
    echo "  ⚠ 没找到解密后的微信数据。"
    echo "    Mac 上有两个选项："
    echo "      1. 在 Windows 上跑过 Murmur 后，把 ~/Documents/Murmur/decrypted/ 拷过来"
    echo "      2. 在 app 内点'引导' → 粘贴 64 位 hex 密钥（要从 Win 上抓出来）"
    echo ""
fi

# --- launch ---
echo "[...] 启动后端..."
(cd cli && $PY etcli.py serve --port 9100) > /tmp/murmur-backend.log 2>&1 &
BACKEND_PID=$!
sleep 2

echo "[...] 启动前端..."
(cd app && npm run dev -- --host 127.0.0.1) > /tmp/murmur-frontend.log 2>&1 &
FRONTEND_PID=$!
sleep 4

# --- open browser ---
echo ""
echo "  ✓ 启动完成！打开浏览器中..."
echo "    后端 PID $BACKEND_PID  (log: /tmp/murmur-backend.log)"
echo "    前端 PID $FRONTEND_PID (log: /tmp/murmur-frontend.log)"
echo ""
echo "  按 Ctrl+C 停止"
echo ""
open "http://127.0.0.1:5173"

# --- wait for Ctrl+C, then cleanup ---
trap 'echo "Stopping..."; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0' INT TERM
wait
