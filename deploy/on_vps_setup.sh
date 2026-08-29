#!/usr/bin/env bash
# 在 VPS 上执行：首次/更新部署 Brass（uvicorn 模式，免 Nuitka 编译）。
# 兼容 Alibaba Cloud Linux 3 (dnf) 与 Ubuntu (apt)。由 deploy.sh 通过 ssh 调用。
# 关键：系统自带 python3 是 3.6（太老且缺 venv），这里优先用 dnf 装 python3.11，
#       没有则 fallback 到 uv 自动拉 Python 3.12，彻底绕开系统 3.6。
set -euo pipefail
DEPLOY=/opt/brass

echo "==> 安装 nginx"
if command -v dnf >/dev/null; then
  dnf install -y nginx
elif command -v apt-get >/dev/null; then
  apt-get update && apt-get install -y nginx
else
  echo "!! 未识别的包管理器，请手动安装 nginx" >&2
  exit 1
fi

# ---- 取得一个现代 Python（>=3.9） ----
PYBIN=""
for v in python3.12 python3.11 python3.10 python3.9; do
  if command -v "$v" >/dev/null 2>&1; then PYBIN="$v"; break; fi
done
if [ -z "$PYBIN" ] && command -v dnf >/dev/null; then
  echo "==> 尝试 dnf 安装 python3.11"
  dnf install -y python3.11 2>/dev/null || true
  command -v python3.11 >/dev/null 2>&1 && PYBIN=python3.11
fi

UV_MODE=""
if [ -z "$PYBIN" ]; then
  echo "==> 系统无现代 Python，改用 uv 安装 Python 3.12 + venv"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  if [ ! -x "$DEPLOY/venv/bin/python" ]; then
    uv venv --python 3.12 "$DEPLOY/venv"
  fi
  uv pip install -r "$DEPLOY/server/requirements.txt"
  UV_MODE=1
fi

if [ -z "$UV_MODE" ]; then
  echo "==> 用 $PYBIN 建 venv 并装后端依赖"
  if [ ! -x "$DEPLOY/venv/bin/python" ]; then
    "$PYBIN" -m venv "$DEPLOY/venv"
  else
    echo "    venv 已存在，跳过创建"
  fi
  "$DEPLOY/venv/bin/python" -m pip install -U pip
  "$DEPLOY/venv/bin/python" -m pip install -r "$DEPLOY/server/requirements.txt"
fi

echo "==> 配置 nginx（IP 直访，HTTP 80，无域名）"
if [ -d /etc/nginx/conf.d ]; then
  cp "$DEPLOY/deploy/nginx.brass.conf" /etc/nginx/conf.d/brass.conf
  cp "$DEPLOY/deploy/csp.conf" /etc/nginx/conf.d/csp.conf
  rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
else
  cp "$DEPLOY/deploy/nginx.brass.conf" /etc/nginx/sites-available/brass
  ln -sf /etc/nginx/sites-available/brass /etc/nginx/sites-enabled/brass
fi
nginx -t
systemctl enable --now nginx
systemctl reload nginx || systemctl restart nginx

echo "==> 注册 systemd 服务并（重启以加载最新代码）启动"
cp "$DEPLOY/deploy/brass.service" /etc/systemd/system/brass.service
systemctl daemon-reload
systemctl enable brass
systemctl restart brass
sleep 2
systemctl status brass --no-pager
echo "✅ VPS 端部署完成"
