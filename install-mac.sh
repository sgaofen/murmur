#!/usr/bin/env bash
# Murmur 微语 · 一键 Mac 安装脚本
#
# 这个脚本会：
#   1. 装 Homebrew（如果没装）
#   2. brew install python@3.12 node ffmpeg
#   3. git clone 仓库到 ~/Applications/Murmur（默认）
#   4. pip install / npm install 主功能依赖
#   5. 启动 Murmur（终端 + 浏览器）
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/sgaofen/murmur/main/install-mac.sh | bash
#
# 或者本地：
#   bash install-mac.sh

set -e

# ----------------- 颜色输出 -----------------
RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'; BOLD=$'\033[1m'; NC=$'\033[0m'
say() { printf "%s%s%s\n" "$1" "$2" "$NC"; }
ok()    { say "$GREEN" "✓ $1"; }
info()  { say "$BLUE"  "→ $1"; }
warn()  { say "$YELLOW" "⚠ $1"; }
error() { say "$RED"   "✗ $1"; }

cat <<'BANNER'

  ╔════════════════════════════════════════════╗
  ║                                            ║
  ║    Murmur 微语 · 一键 Mac 安装             ║
  ║                                            ║
  ║    100% 本地 · 不上传 · 关系档案           ║
  ║                                            ║
  ╚════════════════════════════════════════════╝

BANNER

# ----------------- 系统检查 -----------------
if [[ "$OSTYPE" != "darwin"* ]]; then
    error "这个脚本只支持 macOS。Win 用户请用 start-windows.bat"
    exit 1
fi
ok "macOS $(sw_vers -productVersion)"

# ----------------- Homebrew -----------------
if ! command -v brew > /dev/null 2>&1; then
    info "没装 Homebrew — 现在装一下（约 5 分钟）"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Apple Silicon: brew 装到 /opt/homebrew，需要 source profile
    if [ -x /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [ -x /usr/local/bin/brew ]; then
        eval "$(/usr/local/bin/brew shellenv)"
    fi
fi
ok "Homebrew $(brew --version | head -1 | cut -d ' ' -f 2)"

# ----------------- Python 3.11+ -----------------
PY=""
for cand in python3.13 python3.12 python3.11; do
    if command -v "$cand" > /dev/null 2>&1; then
        PY="$cand"
        break
    fi
done
if [ -z "$PY" ]; then
    info "装 Python 3.12（Murmur 需要 3.11+，系统自带 3.9 太老）"
    brew install python@3.12
    PY="python3.12"
fi
ok "Python: $($PY --version)"

# ----------------- Node 18+ -----------------
if ! command -v node > /dev/null 2>&1; then
    info "装 Node"
    brew install node
fi
NODE_MAJOR=$(node --version | sed 's/v//' | cut -d . -f 1)
if [ "$NODE_MAJOR" -lt 18 ]; then
    warn "Node $(node --version) 太老，需要 18+ — 用 brew 升级"
    brew upgrade node
fi
ok "Node: $(node --version)"

# ----------------- ffmpeg（语音转写需要）-----------------
if ! command -v ffmpeg > /dev/null 2>&1; then
    info "装 ffmpeg（可选 — 语音消息转写需要）"
    brew install ffmpeg || warn "ffmpeg 装失败，但不影响主功能"
fi

# ----------------- 克隆仓库 -----------------
DEFAULT_DIR="$HOME/Applications/Murmur"
if [ -d "$DEFAULT_DIR/.git" ]; then
    info "已有仓库 $DEFAULT_DIR — 拉最新版本"
    cd "$DEFAULT_DIR"
    git pull --ff-only
elif [ -d "$DEFAULT_DIR" ]; then
    error "$DEFAULT_DIR 已存在但不是 Murmur 仓库，请手动处理"
    exit 1
else
    info "克隆 Murmur 到 $DEFAULT_DIR"
    mkdir -p "$(dirname "$DEFAULT_DIR")"
    git clone https://github.com/sgaofen/murmur.git "$DEFAULT_DIR"
    cd "$DEFAULT_DIR"
fi
ok "仓库就绪：$DEFAULT_DIR"

# ----------------- Python 依赖 -----------------
info "装 Python 依赖（zstandard / cryptography；语音转写依赖可之后单独安装）"
$PY -m pip install --user --break-system-packages -r requirements.txt > /dev/null 2>&1
ok "Python 依赖 ready"

# ----------------- Node 依赖 -----------------
if [ ! -d "app/node_modules" ]; then
    info "装 Node 依赖（首次约 1 分钟）"
    (cd app && npm install --silent)
fi
ok "Node 依赖 ready"

# ----------------- 启动 -----------------
echo
echo "  ╔════════════════════════════════════════════╗"
echo "  ║                                            ║"
echo "  ║     ✓ 安装完毕                             ║"
echo "  ║                                            ║"
echo "  ╚════════════════════════════════════════════╝"
echo
ok "下一步：启动 Murmur"
echo
echo "    cd $DEFAULT_DIR"
echo "    bash start-mac.sh"
echo
ok "或者现在直接启动"
read -p "现在启动 Murmur？[y/N] " yn
case "$yn" in
  [Yy]*)
    info "启动中…"
    bash "$DEFAULT_DIR/start-mac.sh"
    ;;
  *)
    info "好的，下次手动跑 start-mac.sh"
    ;;
esac
