#!/usr/bin/env bash
# Multica Squad Board 一键安装 / 启动
# 用法：curl -fsSL https://raw.githubusercontent.com/wwwgang/multica-squad-board/main/install.sh | bash
set -euo pipefail

REPO="https://github.com/wwwgang/multica-squad-board.git"
DIR="${MSB_DIR:-$HOME/.multica-squad-board}"
PORT="${PORT:-4177}"

info() { printf '\033[1;33m[squad-board]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[squad-board]\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "需要 Node.js 20+，请先安装：https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 版本过低（当前 $(node -v)），需要 20+"
command -v multica >/dev/null 2>&1 || fail "未找到 multica CLI，请先安装并登录：https://multica.ai/docs/cli"

# 在仓库目录里直接运行时，不重复 clone
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/server.js" ]; then
  DIR="$SCRIPT_DIR"
else
  command -v git >/dev/null 2>&1 || fail "需要 git"
  if [ -d "$DIR/.git" ]; then
    info "更新 $DIR"
    git -C "$DIR" pull --ff-only
  else
    info "克隆到 $DIR"
    git clone --depth 1 "$REPO" "$DIR"
  fi
fi

if ! multica workspace list >/dev/null 2>&1; then
  fail "multica CLI 尚未登录或不可用，请先执行 multica login"
fi

cd "$DIR"
info "启动 Squad Board → http://127.0.0.1:$PORT（仅本机可访问，Ctrl+C 停止）"
if [ "$(uname)" = "Darwin" ]; then
  (sleep 1.5; open "http://127.0.0.1:$PORT") &
elif command -v xdg-open >/dev/null 2>&1; then
  (sleep 1.5; xdg-open "http://127.0.0.1:$PORT") &
fi
exec node server.js
